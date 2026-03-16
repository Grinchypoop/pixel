/**
 * Planner Agent
 * ─────────────
 * Receives the user's raw goal and outputs a structured Plan:
 * which files to create, what stack to use, folder structure,
 * install/build/start commands.
 *
 * Uses claude-sonnet-4-6 with adaptive thinking + tool use.
 * The `output_plan` tool is the single exit point.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getClient } from '../lib/anthropicClient.js';
import type { Plan, Emit, AgentEvent } from '../types.js';

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'output_plan',
    description:
      'Submit the finalized project plan. Call this exactly once when the plan is complete.',
    input_schema: {
      type: 'object' as const,
      properties: {
        projectName: {
          type: 'string',
          description: 'Slug-safe project name, e.g. "todo-app"',
        },
        stack: {
          type: 'string',
          description:
            'Full tech stack description, e.g. "Next.js 14 + Tailwind CSS + Prisma + PostgreSQL"',
        },
        description: {
          type: 'string',
          description: 'One-sentence description of the app being built',
        },
        folderStructure: {
          type: 'string',
          description: 'ASCII folder tree showing all files and directories',
        },
        files: {
          type: 'array',
          description: 'Every file that the Coder agent must create',
          items: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Relative path from project root, e.g. "src/index.ts"',
              },
              description: {
                type: 'string',
                description: 'What this file contains / its role',
              },
            },
            required: ['path', 'description'],
          },
        },
        dependencies: {
          type: 'array',
          items: { type: 'string' },
          description: 'npm production dependencies (names only, no versions)',
        },
        devDependencies: {
          type: 'array',
          items: { type: 'string' },
          description: 'npm dev dependencies',
        },
        installCommand: {
          type: 'string',
          description: 'e.g. "npm install"',
        },
        buildCommand: {
          type: 'string',
          description: 'e.g. "npm run build"',
        },
        startCommand: {
          type: 'string',
          description: 'e.g. "npm start"',
        },
        port: {
          type: 'number',
          description: 'Port the app will listen on (default 3000)',
        },
        envVars: {
          type: 'object',
          description:
            'Map of env var names to placeholder values, e.g. {"DATABASE_URL": "postgresql://..."}',
          additionalProperties: { type: 'string' },
        },
      },
      required: [
        'projectName',
        'stack',
        'description',
        'folderStructure',
        'files',
        'dependencies',
        'devDependencies',
        'installCommand',
        'buildCommand',
        'startCommand',
      ],
    },
  },
];

// ─── Agent entry point ───────────────────────────────────────────────────────

export async function runPlanner(
  goal: string,
  emit: Emit,
  sessionId: string,
): Promise<Plan> {
  const e = (type: AgentEvent['type'], message: string, data?: unknown) =>
    emit({ type, agent: 'Planner', message, data, sessionId, ts: Date.now() });

  e('agent_start', 'Analyzing your goal and designing the project architecture...');

  const client = getClient();
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Design a complete, production-ready project for the following goal:\n\n${goal}\n\nChoose the best modern stack. Include every file needed (package.json, config files, source files, .env.example, etc.). Think deeply before calling output_plan.`,
    },
  ];

  let plan: Plan | null = null;

  while (true) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: `You are Pixel's Planner agent — a world-class software architect.

Your responsibilities:
1. Pick the optimal, modern tech stack for the user's goal
2. Design a complete folder/file structure
3. List every file that must be created (including package.json, tsconfig, env files, README)
4. Specify all npm dependencies
5. Specify install/build/start commands

Rules:
- Prefer TypeScript over JavaScript
- Choose proven, popular libraries
- Design for a COMPLETE, WORKING application — not a skeleton
- Call output_plan exactly once with the full plan

IMPORTANT — Vercel deployment constraints (always follow these):
- NEVER use SQLite or any file-based database — Vercel has no persistent filesystem
- NEVER include "prisma db push", "prisma migrate", or any database migration in buildCommand or installCommand
- For apps that need data persistence, use in-memory state (useState/useReducer) or localStorage on the client
- For full-stack apps needing a real database, use Vercel Postgres or note the user must supply DATABASE_URL separately — do NOT run migrations at build time
- buildCommand must only compile/bundle code (e.g. "npm run build" or "next build") — no side effects
- The app must build successfully with zero environment variables set`,
      tools: TOOLS,
      tool_choice: { type: 'auto' },
      messages,
    });

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) e('agent_log', block.text);
    }

    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        if (block.name === 'output_plan') {
          plan = block.input as Plan;
          e(
            'agent_log',
            `Plan created!\n• Stack: ${plan.stack}\n• Files: ${plan.files.length}\n• Description: ${plan.description}`,
            plan,
          );
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: 'Plan accepted. Planner complete.',
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });
      if (plan) break; // Done
    } else {
      break;
    }
  }

  if (!plan) throw new Error('Planner failed to produce a plan');

  e('agent_complete', `Planning done — ${plan.files.length} files to create`, plan);
  return plan;
}
