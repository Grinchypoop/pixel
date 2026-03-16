/**
 * Pixel Backend — Express + WebSocket server
 * ───────────────────────────────────────────
 * HTTP endpoints:
 *   POST /api/build   { goal: string } → { sessionId }
 *   GET  /api/status/:sessionId        → { status, result? }
 *   GET  /api/health                   → { ok: true }
 *
 * WebSocket (ws://host/ws):
 *   Client sends:  { type: "subscribe", sessionId: "..." }
 *   Server sends:  AgentEvent objects (streamed in real-time)
 *   Client sends:  { type: "build", goal: "..." }
 *                  → server starts pipeline and returns { sessionId }
 *                  → subsequent events flow to the same connection
 */

import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.env') }); // must run before any agent imports so ANTHROPIC_API_KEY is set
import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { db } from './db/index.js';
import { checkUsage, recordBuild, updateBuildStatus } from './middleware/usage.js';
import { runOrchestrator } from './agents/orchestrator.js';
import type { AgentEvent, OrchestratorResult } from './types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Session {
  status: 'running' | 'done' | 'error';
  result?: OrchestratorResult;
  events: AgentEvent[];
  subscribers: Set<WebSocket>;
}

// ─── App setup ───────────────────────────────────────────────────────────────

const app = express();
const PORT = Number(process.env.PORT ?? 3001);

app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// In-memory session store (good for single-instance deployments)
const sessions = new Map<string, Session>();

// ─── Session helpers ─────────────────────────────────────────────────────────

function broadcast(sessionId: string, event: AgentEvent) {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.events.push(event);

  const payload = JSON.stringify(event);
  for (const ws of session.subscribers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

async function startPipeline(goal: string, sessionId: string): Promise<void> {
  const session = sessions.get(sessionId)!;

  const emit = (event: AgentEvent) => broadcast(sessionId, event);

  try {
    const result = await runOrchestrator(goal, emit, sessionId);
    session.status = result.success ? 'done' : 'error';
    session.result = result;
    await updateBuildStatus(sessionId, session.status, result.deployUrl);
  } catch (err) {
    session.status = 'error';
    session.result = { success: false, error: (err as Error).message };
    await updateBuildStatus(sessionId, 'error');
    broadcast(sessionId, {
      type: 'pipeline_error',
      agent: 'Orchestrator',
      message: (err as Error).message,
      sessionId,
      ts: Date.now(),
    });
  }
}

// ─── REST endpoints ──────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: '1.0.0', model: 'claude-sonnet-4-6' });
});

// ─── Auth: register a new user ───────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email || !email.includes('@')) {
    res.status(400).json({ error: 'Valid email required.' });
    return;
  }

  // Check if already registered
  const { data: existing } = await db.from('users').select('api_key').eq('email', email).single();
  if (existing) {
    res.json({ api_key: existing.api_key, message: 'Welcome back!' });
    return;
  }

  const { data: user, error } = await db.from('users').insert({ email }).select('api_key').single();
  if (error || !user) {
    res.status(500).json({ error: 'Could not create account.' });
    return;
  }

  res.json({ api_key: user.api_key, message: 'Account created! Save your API key.' });
});

// ─── Build ───────────────────────────────────────────────────────────────────
app.post('/api/build', checkUsage, async (req, res) => {
  const { goal } = req.body as { goal?: string };
  const user = (req as any).pixelUser;

  if (!goal || typeof goal !== 'string' || goal.trim().length < 5) {
    res.status(400).json({ error: 'goal must be a non-empty string' });
    return;
  }

  const sessionId = uuidv4();
  sessions.set(sessionId, {
    status: 'running',
    events: [],
    subscribers: new Set(),
  });

  await recordBuild(user.id, sessionId, user.plan);

  // Fire and forget — progress streams via WebSocket
  startPipeline(goal.trim(), sessionId).catch(console.error);

  res.json({ sessionId });
});

app.get('/api/status/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({
    status: session.status,
    eventCount: session.events.length,
    result: session.result,
  });
});

// Replay missed events for reconnecting clients
app.get('/api/events/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ events: session.events });
});

// ─── WebSocket handler ───────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  let boundSessionId: string | null = null;

  ws.on('message', (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    // Subscribe to an existing session (e.g. page refresh)
    if (msg.type === 'subscribe') {
      const sessionId = msg.sessionId as string;
      const session = sessions.get(sessionId);
      if (!session) {
        ws.send(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      boundSessionId = sessionId;
      session.subscribers.add(ws);

      // Replay all past events so the client catches up
      for (const event of session.events) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(event));
        }
      }
      ws.send(JSON.stringify({ type: 'subscribed', sessionId }));
      return;
    }

    // Start a new build directly over WebSocket
    if (msg.type === 'build') {
      const goal = msg.goal as string;
      if (!goal || goal.trim().length < 5) {
        ws.send(JSON.stringify({ error: 'goal is required' }));
        return;
      }

      const sessionId = uuidv4();
      sessions.set(sessionId, {
        status: 'running',
        events: [],
        subscribers: new Set([ws]),
      });

      boundSessionId = sessionId;
      ws.send(JSON.stringify({ type: 'session_created', sessionId }));

      startPipeline(goal.trim(), sessionId).catch(console.error);
      return;
    }

    ws.send(JSON.stringify({ error: `Unknown message type: ${msg.type}` }));
  });

  ws.on('close', () => {
    if (boundSessionId) {
      sessions.get(boundSessionId)?.subscribers.delete(ws);
    }
  });

  ws.on('error', console.error);

  ws.send(
    JSON.stringify({
      type: 'connected',
      message: 'Pixel backend ready. Send { type: "build", goal: "..." } to start.',
    }),
  );
});

// ─── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`
  ██████╗ ██╗██╗  ██╗███████╗██╗
  ██╔══██╗██║╚██╗██╔╝██╔════╝██║
  ██████╔╝██║ ╚███╔╝ █████╗  ██║
  ██╔═══╝ ██║ ██╔██╗ ██╔══╝  ██║
  ██║     ██║██╔╝ ██╗███████╗███████╗
  ╚═╝     ╚═╝╚═╝  ╚═╝╚══════╝╚══════╝

  Pixel AI Developer Backend
  ─────────────────────────────────────────
  HTTP  → http://localhost:${PORT}
  WS    → ws://localhost:${PORT}/ws
  Model → claude-sonnet-4-6
  `);
});

export default app;
