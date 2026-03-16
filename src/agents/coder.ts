/**
 * Coder Agent
 * ───────────
 * Takes the Planner's output and:
 *  1. Writes every file using the `write_file` tool
 *  2. Runs `npm install` via the `execute_command` tool
 *  3. Runs `npm run build` via the `execute_command` tool
 *  4. Reports success or the exact error for the Debugger
 *
 * Uses claude-sonnet-4-6 with adaptive thinking + tool use (manual loop).
 */

import Anthropic from '@anthropic-ai/sdk';
import { getClient } from '../lib/anthropicClient.js';
import { writeProjectFile, readProjectFile, listProjectFiles } from '../utils/fileSystem.js';
import { runCommand } from '../utils/processRunner.js';
import type { Plan, BuildResult, Emit, AgentEvent } from '../types.js';

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'write_file',
    description: 'Create or overwrite a file in the project directory',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Relative path from project root, e.g. "src/index.ts"',
        },
        content: {
          type: 'string',
          description: 'Full file content',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'read_file',
    description: 'Read an existing file from the project directory',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative path from project root' },
      },
      required: ['path'],
    },
  },
  {
    name: 'execute_command',
    description:
      'Run a build command in the project directory. Allowed: npm, npx, yarn, pnpm, node, tsc, next, vite.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'The command to execute' },
      },
      required: ['command'],
    },
  },
  {
    name: 'list_files',
    description: 'List all files currently in the project directory',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'report_build_result',
    description: 'Report the final build result (success or failure)',
    input_schema: {
      type: 'object' as const,
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string', description: 'Summary of what happened' },
        errorDetails: {
          type: 'string',
          description: 'Full error output if success is false',
        },
        phase: {
          type: 'string',
          enum: ['install', 'build', 'complete'],
          description: 'Which phase completed (or failed)',
        },
      },
      required: ['success', 'message', 'phase'],
    },
  },
];

// ─── Agent entry point ───────────────────────────────────────────────────────

export async function runCoder(
  plan: Plan,
  workDir: string,
  emit: Emit,
  sessionId: string,
): Promise<BuildResult> {
  const e = (type: AgentEvent['type'], message: string, data?: unknown) =>
    emit({ type, agent: 'Coder', message, data, sessionId, ts: Date.now() });

  e('agent_start', `Starting to build ${plan.projectName} with ${plan.stack}`);

  const planSummary = JSON.stringify(
    {
      projectName: plan.projectName,
      stack: plan.stack,
      description: plan.description,
      folderStructure: plan.folderStructure,
      files: plan.files,
      dependencies: plan.dependencies,
      devDependencies: plan.devDependencies,
      installCommand: plan.installCommand,
      buildCommand: plan.buildCommand,
      startCommand: plan.startCommand,
      port: plan.port,
      envVars: plan.envVars,
    },
    null,
    2,
  );

  const client = getClient();
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Implement the following project plan completely. Write every file listed in the plan with full, working content. Then run the install command, then the build command. Finally call report_build_result.\n\nPlan:\n${planSummary}\n\nWork directory: ${workDir}`,
    },
  ];

  let buildResult: BuildResult | null = null;
  let installOutput = '';
  let buildOutput = '';

  while (true) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 32768,
      thinking: { type: 'adaptive' },
      system: `You are Pixel's Coder agent — an expert full-stack engineer.

Your job:
1. Write EVERY file from the plan with complete, production-ready content
2. Do not skip files or leave TODOs — write real, working code
3. After writing all files, run: ${plan.installCommand}
4. After install succeeds, run: ${plan.buildCommand}
5. Call report_build_result with the outcome

Critical rules:
- Always write package.json FIRST
- Write complete implementations, not stubs
- Use the exact stack from the plan
- Handle errors: if npm install fails, report it; if build fails, report the exact error
- Never call report_build_result before running both commands`,
      tools: TOOLS,
      tool_choice: { type: 'auto' },
      messages,
    });

    // Surface thinking and text
    for (const block of response.content) {
      if (block.type === 'thinking') {
        e('agent_thinking', block.thinking.slice(0, 400) + '…');
      } else if (block.type === 'text' && block.text.trim()) {
        e('agent_log', block.text);
      }
    }

    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        let resultContent = '';

        try {
          if (block.name === 'write_file') {
            const { path: filePath, content } = block.input as {
              path: string;
              content: string;
            };
            await writeProjectFile(workDir, filePath, content);
            e('file_written', `Created ${filePath}`, { path: filePath, content: content.slice(0, 8000) });
            resultContent = `File written: ${filePath}`;
          }

          else if (block.name === 'read_file') {
            const { path: filePath } = block.input as { path: string };
            const content = await readProjectFile(workDir, filePath);
            resultContent = content;
          }

          else if (block.name === 'execute_command') {
            const { command } = block.input as { command: string };
            e('agent_log', `Running: ${command}`);

            const result = await runCommand(command, workDir, (line) => {
              e('command_output', line.trimEnd());
            });

            if (command.includes('install')) installOutput = result.stdout + result.stderr;
            if (command.includes('build')) buildOutput = result.stdout + result.stderr;

            resultContent = JSON.stringify({
              exitCode: result.exitCode,
              success: result.success,
              stdout: result.stdout.slice(-3000),
              stderr: result.stderr.slice(-3000),
            });
          }

          else if (block.name === 'list_files') {
            const files = await listProjectFiles(workDir);
            resultContent = files.join('\n');
          }

          else if (block.name === 'report_build_result') {
            const { success, message, errorDetails, phase } = block.input as {
              success: boolean;
              message: string;
              errorDetails?: string;
              phase: 'install' | 'build' | 'complete';
            };

            buildResult = {
              success,
              stdout: installOutput + '\n' + buildOutput,
              stderr: errorDetails ?? '',
              exitCode: success ? 0 : 1,
              phase,
            };

            if (success) {
              e('agent_complete', message);
            } else {
              e('agent_error', message, { errorDetails });
            }

            resultContent = 'Build result recorded.';
          }
        } catch (err) {
          resultContent = `Error: ${(err as Error).message}`;
          e('agent_log', `Tool error (${block.name}): ${(err as Error).message}`);
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: resultContent,
        });
      }

      messages.push({ role: 'user', content: toolResults });

      if (buildResult) break;
    } else {
      break;
    }
  }

  if (!buildResult) {
    return {
      success: false,
      stdout: '',
      stderr: 'Coder agent ended without reporting a build result',
      exitCode: 1,
      phase: 'build',
    };
  }

  return buildResult;
}
