/**
 * PlannerChat Agent
 * ─────────────────
 * Conversational agent that chats with the user to understand their goal,
 * draws a system architecture, and asks for approval before building.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getClient } from '../lib/anthropicClient.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatResponse {
  message: string;
  ready: boolean;
  goalSummary?: string;
  architecture?: string;
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'ready_to_build',
    description: 'Call this ONLY when the user has explicitly approved the plan and you are ready to start building.',
    input_schema: {
      type: 'object' as const,
      properties: {
        goalSummary: {
          type: 'string',
          description: 'Full detailed summary of what to build — stack, features, pages, database needs. This goes directly to the Coder agent.',
        },
        architecture: {
          type: 'string',
          description: 'ASCII system architecture diagram showing the components and how they connect.',
        },
      },
      required: ['goalSummary', 'architecture'],
    },
  },
];

const SYSTEM = `You are Pixel's friendly AI assistant. Your job is to have a short, warm conversation with the user to understand what they want to build — then present a clear plan and get their approval before building starts.

You are talking to NON-TECHNICAL users. Keep it simple, friendly, and jargon-free.

Your flow:
1. Greet them and ask 1-2 focused questions to understand their idea
2. Once you have enough info, summarize what you'll build in plain English
3. Draw a simple ASCII architecture diagram showing the main parts
4. Ask: "Does this look right? Should I start building?"
5. If they say yes/looks good/go ahead → call the ready_to_build tool

Architecture diagram format (keep it simple):
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Frontend   │────▶│     API      │────▶│   Database   │
│  (Next.js)   │     │  (Routes)    │     │  (Supabase)  │
└──────────────┘     └──────────────┘     └──────────────┘

Rules:
- Never use technical jargon without explaining it
- Be encouraging and positive
- Keep messages short and scannable
- Ask only 1-2 questions at a time
- Don't ask for approval until you have a clear picture of what they want`;

export async function plannerChat(messages: ChatMessage[]): Promise<ChatResponse> {
  const client = getClient();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM,
    tools: TOOLS,
    tool_choice: { type: 'auto' },
    messages: messages.map(m => ({ role: m.role, content: m.content })),
  });

  // Check if planner is ready to build
  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === 'ready_to_build') {
      const input = block.input as { goalSummary: string; architecture: string };
      return {
        message: "Perfect! I have everything I need. Let's build your app! 🚀",
        ready: true,
        goalSummary: input.goalSummary,
        architecture: input.architecture,
      };
    }
  }

  const textBlock = response.content.find(b => b.type === 'text');
  const text = textBlock?.type === 'text' ? textBlock.text : "Could you tell me more about what you'd like to build?";

  return { message: text, ready: false };
}
