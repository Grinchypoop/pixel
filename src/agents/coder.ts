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
      system: `You are Pixel's Coder agent — an expert full-stack engineer and UI/UX designer.

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
- Never call report_build_result before running both commands

UI/UX Design rules (apply to every app you build):
- Minimalistic, clean design — no clutter, generous whitespace
- Use Tailwind CSS for layout and spacing, but write custom CSS for interactive components
- Color palette: neutral backgrounds (white/gray-50/gray-100), one accent color that fits the app's purpose
- Typography: use a Google Font (Inter or Plus Jakarta Sans), clear hierarchy with font weights
- Mobile responsive by default — every layout must work on small screens
- Navigation: sticky header with logo + nav links, hamburger menu on mobile
- Overall feel: like a modern SaaS product (think Linear, Vercel, Notion aesthetics)

Custom CSS component rules (inspired by uiverse.io style):
- Buttons: craft custom CSS with creative hover effects — glowing box-shadows, shimmer sweeps, fill animations, or border-draw effects. Never use plain unstyled buttons.
- Cards: use glassmorphism (backdrop-filter: blur + semi-transparent background) or soft neumorphic shadows where appropriate
- Inputs/Forms: animated underline or floating label effects, glowing focus states with the accent color
- Loaders: CSS-only spinners or pulsing dots — never a plain browser default
- Checkboxes/toggles: fully custom styled with CSS animations
- Transitions: smooth 200-300ms ease on all interactive elements
- Empty states and loading states must be designed with these custom styles — never leave a blank screen

Pixel watermark (REQUIRED on every app):
Every app you build MUST include a small "Built with Pixel" badge fixed to the bottom-right corner of the page.
Use this exact HTML and CSS (colors changed to purple):

HTML (place just before </body>):
<a href="https://pixel.so" target="_blank" id="pixel-badge">
  <div id="ghost">
    <div id="shadow"></div>
    <div id="red">
      <div id="top0"></div><div id="top1"></div><div id="top2"></div>
      <div id="top3"></div><div id="top4"></div>
      <div id="st0"></div><div id="st1"></div><div id="st2"></div>
      <div id="st3"></div><div id="st4"></div><div id="st5"></div>
      <div id="an1"></div><div id="an2"></div><div id="an3"></div>
      <div id="an4"></div><div id="an6"></div><div id="an7"></div>
      <div id="an8"></div><div id="an9"></div><div id="an10"></div>
      <div id="an11"></div><div id="an12"></div><div id="an13"></div>
      <div id="an15"></div><div id="an16"></div><div id="an17"></div><div id="an18"></div>
    </div>
    <div id="eye"></div><div id="pupil"></div>
    <div id="eye1"></div><div id="pupil1"></div>
  </div>
  <span>Built with Pixel</span>
</a>

CSS:
#pixel-badge {
  position: fixed; bottom: 16px; right: 16px; z-index: 9999;
  display: flex; align-items: center; gap: 8px;
  background: rgba(255,255,255,0.9); backdrop-filter: blur(8px);
  border: 1px solid #e9d5ff; border-radius: 12px;
  padding: 6px 12px 6px 6px;
  text-decoration: none; color: #7c3aed; font-size: 12px; font-weight: 600;
  box-shadow: 0 2px 12px rgba(124,58,237,0.15);
  transition: box-shadow 0.2s ease, transform 0.2s ease;
}
#pixel-badge:hover { box-shadow: 0 4px 20px rgba(124,58,237,0.3); transform: translateY(-1px); }
#ghost { position: relative; scale: 0.25; margin: -30px -20px; }
#red {
  animation: upNDown infinite 0.5s; position: relative;
  width: 140px; height: 140px; display: grid;
  grid-template-columns: repeat(14, 1fr); grid-template-rows: repeat(14, 1fr);
  grid-template-areas:
    "a1 a2 a3 a4 a5 top0 top0 top0 top0 a10 a11 a12 a13 a14"
    "b1 b2 b3 top1 top1 top1 top1 top1 top1 top1 top1 b12 b13 b14"
    "c1 c2 top2 top2 top2 top2 top2 top2 top2 top2 top2 top2 c13 c14"
    "d1 top3 top3 top3 top3 top3 top3 top3 top3 top3 top3 top3 top3 d14"
    "e1 top3 top3 top3 top3 top3 top3 top3 top3 top3 top3 top3 top3 e14"
    "f1 top3 top3 top3 top3 top3 top3 top3 top3 top3 top3 top3 top3 f14"
    "top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4"
    "top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4"
    "top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4"
    "top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4"
    "top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4"
    "top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4"
    "st0 st0 an4 st1 an7 st2 an10 an10 st3 an13 st4 an16 st5 st5"
    "an1 an2 an3 an5 an6 an8 an9 an9 an11 an12 an14 an15 an17 an18";
}
@keyframes upNDown { 0%,49%{transform:translateY(0px)} 50%,100%{transform:translateY(-10px)} }
#top0{grid-area:top0} #top1{grid-area:top1} #top2{grid-area:top2} #top3{grid-area:top3} #top4{grid-area:top4}
#st0{grid-area:st0} #st1{grid-area:st1} #st2{grid-area:st2} #st3{grid-area:st3} #st4{grid-area:st4} #st5{grid-area:st5}
#top0,#top1,#top2,#top3,#top4,#st0,#st1,#st2,#st3,#st4,#st5{background-color:#7c3aed}
#an1{grid-area:an1;animation:flicker0 infinite 0.5s} #an18{grid-area:an18;animation:flicker0 infinite 0.5s}
#an2{grid-area:an2;animation:flicker1 infinite 0.5s} #an17{grid-area:an17;animation:flicker1 infinite 0.5s}
#an3{grid-area:an3;animation:flicker1 infinite 0.5s} #an16{grid-area:an16;animation:flicker1 infinite 0.5s}
#an4{grid-area:an4;animation:flicker1 infinite 0.5s} #an15{grid-area:an15;animation:flicker1 infinite 0.5s}
#an6{grid-area:an6;animation:flicker0 infinite 0.5s} #an12{grid-area:an12;animation:flicker0 infinite 0.5s}
#an7{grid-area:an7;animation:flicker0 infinite 0.5s} #an13{grid-area:an13;animation:flicker0 infinite 0.5s}
#an9{grid-area:an9;animation:flicker1 infinite 0.5s} #an10{grid-area:an10;animation:flicker1 infinite 0.5s}
#an8{grid-area:an8;animation:flicker0 infinite 0.5s} #an11{grid-area:an11;animation:flicker0 infinite 0.5s}
@keyframes flicker0{0%,49%{background-color:#7c3aed}50%,100%{background-color:transparent}}
@keyframes flicker1{0%,49%{background-color:transparent}50%,100%{background-color:#7c3aed}}
#eye{width:40px;height:50px;position:absolute;top:30px;left:10px}
#eye::before{content:"";background-color:white;width:20px;height:50px;transform:translateX(10px);display:block;position:absolute}
#eye::after{content:"";background-color:white;width:40px;height:30px;transform:translateY(10px);display:block;position:absolute}
#eye1{width:40px;height:50px;position:absolute;top:30px;right:30px}
#eye1::before{content:"";background-color:white;width:20px;height:50px;transform:translateX(10px);display:block;position:absolute}
#eye1::after{content:"";background-color:white;width:40px;height:30px;transform:translateY(10px);display:block;position:absolute}
#pupil{width:20px;height:20px;background-color:#4c1d95;position:absolute;top:50px;left:10px;z-index:1;animation:eyesMovement infinite 3s}
#pupil1{width:20px;height:20px;background-color:#4c1d95;position:absolute;top:50px;right:50px;z-index:1;animation:eyesMovement infinite 3s}
@keyframes eyesMovement{0%,49%{transform:translateX(0px)}50%,99%{transform:translateX(10px)}100%{transform:translateX(0px)}}
#shadow{background-color:#7c3aed;width:140px;height:140px;position:absolute;border-radius:50%;transform:rotateX(80deg);filter:blur(20px);top:80%;animation:shadowMovement infinite 0.5s}
@keyframes shadowMovement{0%,49%{opacity:0.5}50%,100%{opacity:0.2}}`,
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
