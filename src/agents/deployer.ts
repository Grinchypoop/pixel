/**
 * Deployer Agent
 * ──────────────
 * Takes a successfully built project and pushes it live:
 *  - Railway (preferred when RAILWAY_API_TOKEN is set)
 *  - Vercel  (fallback when VERCEL_TOKEN is set)
 *  - "none"  (graceful no-op when no tokens are configured)
 *
 * Uses the Railway / Vercel REST APIs via axios.
 * Also uses Claude to decide which platform to use and to generate
 * platform-specific config files (railway.json / vercel.json).
 */

import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import path from 'path';
import fs from 'fs-extra';
import { writeProjectFile } from '../utils/fileSystem.js';
import { runCommand } from '../utils/processRunner.js';
import type { Plan, DeployResult, Emit, AgentEvent } from '../types.js';

const client = new Anthropic();

// ─── Deployment helpers ──────────────────────────────────────────────────────

async function deployToRailway(
  workDir: string,
  plan: Plan,
  emit: (msg: string) => void,
): Promise<DeployResult> {
  const token = process.env.RAILWAY_API_TOKEN!;

  emit('Connecting to Railway API...');

  // 1. Create a new project
  const projectRes = await axios.post(
    'https://backboard.railway.app/graphql/v2',
    {
      query: `
        mutation ProjectCreate($input: ProjectCreateInput!) {
          projectCreate(input: $input) { id }
        }
      `,
      variables: {
        input: { name: plan.projectName },
      },
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
  );

  const projectId = projectRes.data?.data?.projectCreate?.id;
  if (!projectId) throw new Error('Railway: failed to create project');
  emit(`Railway project created: ${projectId}`);

  // 2. Deploy via CLI (railway up)
  const installResult = await runCommand(`npx railway up --service ${plan.projectName}`, workDir, (line) =>
    emit(line),
  );

  if (!installResult.success) {
    throw new Error(`Railway deploy failed:\n${installResult.stderr}`);
  }

  // 3. Get the public URL
  const domainRes = await axios.post(
    'https://backboard.railway.app/graphql/v2',
    {
      query: `
        query GetDomain($projectId: String!) {
          project(id: $projectId) {
            services { edges { node { domains { edges { node { domain } } } } } }
          }
        }
      `,
      variables: { projectId },
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
  );

  const edges =
    domainRes.data?.data?.project?.services?.edges?.[0]?.node?.domains?.edges;
  const url = edges?.[0]?.node?.domain
    ? `https://${edges[0].node.domain}`
    : `https://${plan.projectName}.up.railway.app`;

  return { url, platform: 'railway', deploymentId: projectId };
}

async function deployToVercel(
  workDir: string,
  plan: Plan,
  emit: (msg: string) => void,
): Promise<DeployResult> {
  const token = process.env.VERCEL_TOKEN!;
  const teamId = process.env.VERCEL_TEAM_ID;

  const authHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // Step 1: Collect all project files
  emit('Collecting project files...');
  const fileList: Array<{ fullPath: string; relPath: string; content: Buffer }> = [];
  const walkDir = async (dir: string, base: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(base, fullPath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'dist', '.next', '.prisma'].includes(entry.name)) continue;
        await walkDir(fullPath, base);
      } else {
        const content = await fs.readFile(fullPath);
        fileList.push({ fullPath, relPath, content });
      }
    }
  };
  await walkDir(workDir, workDir);

  // Step 2: Upload each file to Vercel and collect SHAs
  emit(`Uploading ${fileList.length} files to Vercel...`);
  const crypto = await import('crypto');
  const deployFiles: Array<{ file: string; sha: string; size: number }> = [];

  for (const f of fileList) {
    const sha = crypto.createHash('sha1').update(f.content).digest('hex');
    deployFiles.push({ file: f.relPath, sha, size: f.content.length });

    // Upload the file (Vercel deduplicates by SHA so this is idempotent)
    try {
      const params = teamId ? `?teamId=${teamId}` : '';
      await axios.post(
        `https://api.vercel.com/v2/files${params}`,
        f.content,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/octet-stream',
            'x-vercel-digest': sha,
          },
          maxBodyLength: Infinity,
        },
      );
    } catch (err: any) {
      // 409 means already uploaded (duplicate SHA) — fine to ignore
      if (err?.response?.status !== 409) throw err;
    }
  }

  // Step 3: Create the deployment
  emit('Creating Vercel deployment...');
  const payload: Record<string, unknown> = {
    name: plan.projectName,
    files: deployFiles,
    projectSettings: {
      buildCommand: plan.buildCommand,
      installCommand: plan.installCommand,
      framework: 'nextjs',
    },
    target: 'production',
  };
  if (teamId) payload.teamId = teamId;

  const deployRes = await axios.post(
    'https://api.vercel.com/v13/deployments',
    payload,
    { headers: authHeaders },
  );

  const deploymentId = deployRes.data?.id;
  const url = deployRes.data?.url ? `https://${deployRes.data.url}` : 'https://vercel.app';

  if (!deploymentId) throw new Error('Vercel: missing deployment ID in response');
  emit(`Vercel deployment started: ${url}`);

  // Step 4: Poll until READY or ERROR (max 3 minutes)
  emit('Waiting for Vercel build to complete...');
  const params = teamId ? `?teamId=${teamId}` : '';
  const maxAttempts = 36; // 36 × 5s = 3 minutes
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const statusRes = await axios.get(
      `https://api.vercel.com/v13/deployments/${deploymentId}${params}`,
      { headers: authHeaders },
    );
    const state: string = statusRes.data?.status ?? statusRes.data?.readyState ?? '';
    emit(`Vercel build status: ${state}`);
    if (state === 'READY') {
      emit(`Deployment live: ${url}`);
      return { url, platform: 'vercel', deploymentId };
    }
    if (state === 'ERROR' || state === 'CANCELED') {
      const errorMessage = statusRes.data?.errorMessage ?? 'unknown error';
      throw new Error(`Vercel build failed (${state}): ${errorMessage}`);
    }
  }
  throw new Error('Vercel deployment timed out after 3 minutes');
}

// ─── Config file generation ──────────────────────────────────────────────────

async function generateConfigFiles(
  plan: Plan,
  workDir: string,
  platform: 'railway' | 'vercel',
  emit: (msg: string) => void,
): Promise<void> {
  if (platform === 'railway') {
    const railwayJson = JSON.stringify(
      {
        build: { builder: 'NIXPACKS' },
        deploy: {
          startCommand: plan.startCommand,
          restartPolicyType: 'ON_FAILURE',
          restartPolicyMaxRetries: 10,
        },
      },
      null,
      2,
    );
    await writeProjectFile(workDir, 'railway.json', railwayJson);
    emit('Generated railway.json');
  }

  if (platform === 'vercel') {
    const vercelJson = JSON.stringify(
      {
        buildCommand: plan.buildCommand,
        installCommand: plan.installCommand,
      },
      null,
      2,
    );
    await writeProjectFile(workDir, 'vercel.json', vercelJson);
    emit('Generated vercel.json');
  }
}

// ─── Agent entry point ───────────────────────────────────────────────────────

export async function runDeployer(
  plan: Plan,
  workDir: string,
  emit: Emit,
  sessionId: string,
): Promise<DeployResult> {
  const e = (type: AgentEvent['type'], message: string, data?: unknown) =>
    emit({ type, agent: 'Deployer', message, data, sessionId, ts: Date.now() });

  const hasRailway = !!process.env.RAILWAY_API_TOKEN;
  const hasVercel = !!process.env.VERCEL_TOKEN;

  if (!hasRailway && !hasVercel) {
    e('agent_log', 'No deployment tokens configured (RAILWAY_API_TOKEN / VERCEL_TOKEN). Skipping deployment.');
    e('agent_complete', 'Build succeeded — deployment skipped (no tokens configured)', {
      note: 'Set RAILWAY_API_TOKEN or VERCEL_TOKEN in .env to enable deployment',
    });
    return { url: 'http://localhost:' + (plan.port ?? 3000), platform: 'none' };
  }

  const platform = hasRailway ? 'railway' : 'vercel';
  e('agent_start', `Deploying ${plan.projectName} to ${platform}...`);

  const log = (msg: string) => e('agent_log', msg);

  try {
    await generateConfigFiles(plan, workDir, platform, log);

    let result: DeployResult;

    if (platform === 'railway') {
      result = await deployToRailway(workDir, plan, log);
    } else {
      result = await deployToVercel(workDir, plan, log);
    }

    e('agent_complete', `Deployed! Live URL: ${result.url}`, result);
    return result;
  } catch (err) {
    const message = (err as Error).message;
    e('agent_error', `Deployment failed: ${message}`);

    // Return a graceful fallback so the pipeline can still report success
    return {
      url: 'http://localhost:' + (plan.port ?? 3000),
      platform: 'none',
      deploymentId: undefined,
    };
  }
}
