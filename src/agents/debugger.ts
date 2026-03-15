/**
 * Debugger Agent
 * ──────────────
 * When the Coder fails, the Debugger takes over:
 *  1. Receives the error text (and optionally a base64 screenshot)
 *  2. Sends it to Claude Vision / text analysis
 *  3. Extracts concrete fixes (file + old code + new code)
 *  4. Applies them via the `apply_fix` tool
 *  5. Returns a DebugResult so the Orchestrator can retry the Coder
 *
 * If a dev server URL is supplied, Puppeteer captures a screenshot first.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getClient } from '../lib/anthropicClient.js';
import { writeProjectFile, readProjectFile } from '../utils/fileSystem.js';
import { captureScreenshot } from '../utils/screenshotter.js';
import type { DebugResult, Fix, BuildResult, Emit, AgentEvent } from '../types.js';

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description: 'Read a source file to understand its current content',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
  },
  {
    name: 'apply_fix',
    description: 'Apply a targeted fix to a file by replacing a code segment',
    input_schema: {
      type: 'object' as const,
      properties: {
        filePath: { type: 'string', description: 'Relative path from project root' },
        description: { type: 'string', description: 'What this fix does' },
        oldCode: {
          type: 'string',
          description:
            'The EXACT existing code to replace (must match file content exactly)',
        },
        newCode: { type: 'string', description: 'The replacement code' },
      },
      required: ['filePath', 'description', 'oldCode', 'newCode'],
    },
  },
  {
    name: 'report_debug_result',
    description: 'Submit the debugging analysis and list all fixes that were applied',
    input_schema: {
      type: 'object' as const,
      properties: {
        analysis: {
          type: 'string',
          description: 'Root cause analysis of the error',
        },
        fixesSummary: {
          type: 'string',
          description: 'Summary of all fixes applied',
        },
      },
      required: ['analysis', 'fixesSummary'],
    },
  },
];

// ─── Agent entry point ───────────────────────────────────────────────────────

export async function runDebugger(
  buildResult: BuildResult,
  workDir: string,
  emit: Emit,
  sessionId: string,
  devServerUrl?: string,
): Promise<DebugResult> {
  const e = (type: AgentEvent['type'], message: string, data?: unknown) =>
    emit({ type, agent: 'Debugger', message, data, sessionId, ts: Date.now() });

  e('agent_start', 'Analyzing build failure...');

  const errorText = [buildResult.stderr, buildResult.stdout]
    .join('\n')
    .slice(-8000); // Trim to avoid blowing context

  // Try to grab a browser screenshot if a dev server URL is given
  let screenshotBase64: string | null = null;
  let browserErrors: string[] = [];

  if (devServerUrl) {
    e('agent_log', `Capturing screenshot from ${devServerUrl}...`);
    const shot = await captureScreenshot(devServerUrl);
    if (shot) {
      screenshotBase64 = shot.base64;
      browserErrors = shot.consoleErrors;
      e('agent_log', `Screenshot captured. Browser errors: ${browserErrors.length}`);
    }
  }

  // Build the user message content — text + optional image
  const userContent: Anthropic.MessageParam['content'] = screenshotBase64
    ? [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: screenshotBase64,
          },
        },
        {
          type: 'text',
          text: `Build/runtime error — please diagnose and fix it.\n\nBuild phase: ${buildResult.phase}\n\nError output:\n\`\`\`\n${errorText}\n\`\`\`\n\nBrowser console errors:\n${browserErrors.join('\n') || 'none'}\n\nApply fixes using apply_fix, then call report_debug_result.`,
        },
      ]
    : `Build/runtime error — please diagnose and fix it.\n\nBuild phase: ${buildResult.phase}\n\nError output:\n\`\`\`\n${errorText}\n\`\`\`\n\nApply fixes using apply_fix, then call report_debug_result.`;

  const client = getClient();
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userContent },
  ];

  const appliedFixes: Fix[] = [];
  let debugResult: DebugResult | null = null;

  while (true) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16384,
      thinking: { type: 'adaptive' },
      system: `You are Pixel's Debugger agent — an expert at reading error messages and fixing code.

Your responsibilities:
1. Analyze the error carefully (read relevant files if needed)
2. Identify the root cause(s)
3. Apply targeted fixes using apply_fix — use EXACT strings from the file
4. Call report_debug_result when all fixes are applied

Rules:
- Read files before applying fixes — you need to see the current content
- Fix the ROOT cause, not symptoms
- Prefer minimal, surgical fixes
- If the same error appears in multiple places, fix all of them
- Never guess — always read the file first`,
      tools: TOOLS,
      tool_choice: { type: 'auto' },
      messages,
    });

    for (const block of response.content) {
      if (block.type === 'thinking') {
        e('agent_thinking', block.thinking.slice(0, 500) + '…');
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
          if (block.name === 'read_file') {
            const { path: filePath } = block.input as { path: string };
            resultContent = await readProjectFile(workDir, filePath);
          }

          else if (block.name === 'apply_fix') {
            const { filePath, description, oldCode, newCode } = block.input as {
              filePath: string;
              description: string;
              oldCode: string;
              newCode: string;
            };

            const current = await readProjectFile(workDir, filePath);

            if (!current.includes(oldCode)) {
              resultContent = `ERROR: Could not find the target code in ${filePath}. The oldCode string did not match. Read the file again and try with exact content.`;
            } else {
              const updated = current.replace(oldCode, newCode);
              await writeProjectFile(workDir, filePath, updated);

              const fix: Fix = { filePath, description, oldCode, newCode };
              appliedFixes.push(fix);

              e('agent_log', `Fix applied: ${description} → ${filePath}`, fix);
              resultContent = `Fix applied successfully to ${filePath}`;
            }
          }

          else if (block.name === 'report_debug_result') {
            const { analysis, fixesSummary } = block.input as {
              analysis: string;
              fixesSummary: string;
            };

            debugResult = { analysis, fixes: appliedFixes };
            e('agent_complete', `Debug complete — ${appliedFixes.length} fix(es) applied\n${fixesSummary}`);
            resultContent = 'Debug result recorded.';
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

      if (debugResult) break;
    } else {
      break;
    }
  }

  if (!debugResult) {
    return {
      analysis: 'Debugger ended without producing a result',
      fixes: appliedFixes,
    };
  }

  return debugResult;
}
