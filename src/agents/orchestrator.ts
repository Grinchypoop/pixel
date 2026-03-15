/**
 * Orchestrator Agent
 * ──────────────────
 * The manager. Receives the user's goal and runs the full pipeline:
 *
 *   Planner → Coder → [Debugger → Coder]* → Deployer
 *
 * Retry logic: if the Coder fails, the Debugger fixes the project and
 * the Coder tries again. Max 3 build attempts before giving up.
 *
 * Every agent streams events back via the `emit` callback so the frontend
 * can render real-time progress.
 */

import { createWorkDir } from '../utils/fileSystem.js';
import { runPlanner } from './planner.js';
import { runCoder } from './coder.js';
import { runDebugger } from './debugger.js';
import { runDeployer } from './deployer.js';
import type { Emit, AgentEvent, OrchestratorResult } from '../types.js';

const MAX_BUILD_ATTEMPTS = 3;

export async function runOrchestrator(
  goal: string,
  emit: Emit,
  sessionId: string,
): Promise<OrchestratorResult> {
  const e = (type: AgentEvent['type'], message: string, data?: unknown) =>
    emit({ type, agent: 'Orchestrator', message, data, sessionId, ts: Date.now() });

  e('agent_start', `Pixel is starting on your goal…\n"${goal}"`);

  let workDir: string;

  try {
    workDir = await createWorkDir(sessionId);
    e('agent_log', `Work directory: ${workDir}`);
  } catch (err) {
    const error = `Failed to create work directory: ${(err as Error).message}`;
    e('pipeline_error', error);
    return { success: false, error };
  }

  // ─── Step 1: Plan ────────────────────────────────────────────────────────

  let plan;
  try {
    plan = await runPlanner(goal, emit, sessionId);
  } catch (err) {
    const error = `Planner failed: ${(err as Error).message}`;
    e('pipeline_error', error);
    return { success: false, error, workDir };
  }

  // ─── Step 2: Code + Debug loop ───────────────────────────────────────────

  let buildResult;
  let attempt = 0;

  while (attempt < MAX_BUILD_ATTEMPTS) {
    attempt++;
    e('agent_log', `Build attempt ${attempt}/${MAX_BUILD_ATTEMPTS}…`);

    try {
      buildResult = await runCoder(plan, workDir, emit, sessionId);
    } catch (err) {
      buildResult = {
        success: false,
        stdout: '',
        stderr: (err as Error).message,
        exitCode: 1,
        phase: 'build' as const,
      };
    }

    if (buildResult.success) {
      e('agent_log', `Build succeeded on attempt ${attempt}`);
      break;
    }

    // Build failed — hand off to Debugger
    e(
      'agent_log',
      `Build failed (attempt ${attempt}). Handing off to Debugger…\nError: ${buildResult.stderr.slice(0, 300)}`,
    );

    if (attempt < MAX_BUILD_ATTEMPTS) {
      try {
        const debugResult = await runDebugger(buildResult, workDir, emit, sessionId);
        e(
          'agent_log',
          `Debugger applied ${debugResult.fixes.length} fix(es). Retrying build…`,
        );
      } catch (err) {
        e('agent_log', `Debugger error: ${(err as Error).message} — retrying anyway`);
      }
    }
  }

  if (!buildResult?.success) {
    const error = `Build failed after ${MAX_BUILD_ATTEMPTS} attempt(s).\n${buildResult?.stderr ?? 'Unknown error'}`;
    e('pipeline_error', error);
    return { success: false, error, plan, workDir };
  }

  // ─── Step 3: Deploy ──────────────────────────────────────────────────────

  let deployResult;
  try {
    deployResult = await runDeployer(plan, workDir, emit, sessionId);
  } catch (err) {
    e('agent_log', `Deployer error (non-fatal): ${(err as Error).message}`);
    deployResult = {
      url: `http://localhost:${plan.port ?? 3000}`,
      platform: 'none' as const,
    };
  }

  // ─── Done ────────────────────────────────────────────────────────────────

  e(
    'pipeline_complete',
    `✅ Pixel finished!\nProject: ${plan.projectName}\nStack: ${plan.stack}\nURL: ${deployResult.url}`,
    {
      plan,
      deployUrl: deployResult.url,
      platform: deployResult.platform,
      workDir,
    },
  );

  return {
    success: true,
    plan,
    deployUrl: deployResult.url,
    workDir,
  };
}
