import type { Request, Response, NextFunction } from 'express';
import { db } from '../db/index.js';

// ─── Plan limits ─────────────────────────────────────────────────────────────

export const PLAN_LIMITS: Record<string, { buildsPerMonth: number; totalBuilds?: number; hostingDays: number | null }> = {
  free:     { totalBuilds: 1,         buildsPerMonth: 1,         hostingDays: 5    },
  starter:  { totalBuilds: undefined, buildsPerMonth: 5,         hostingDays: null },
  pro:      { totalBuilds: undefined, buildsPerMonth: Infinity,  hostingDays: null },
  database: { totalBuilds: undefined, buildsPerMonth: Infinity,  hostingDays: null },
};

// ─── Reset monthly builds if billing cycle has rolled over ───────────────────

async function resetIfNewMonth(userId: string, billingStart: Date) {
  const now = new Date();
  const cycleStart = new Date(billingStart);
  const nextCycle = new Date(cycleStart);
  nextCycle.setMonth(nextCycle.getMonth() + 1);

  if (now >= nextCycle) {
    await db.from('users').update({
      builds_this_month: 0,
      billing_cycle_start: now.toISOString(),
    }).eq('id', userId);
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export async function checkUsage(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'] as string | undefined;

  if (!apiKey) {
    res.status(401).json({ error: 'Missing API key. Include x-api-key header.' });
    return;
  }

  const { data: user, error } = await db
    .from('users')
    .select('*')
    .eq('api_key', apiKey)
    .single();

  if (error || !user) {
    res.status(401).json({ error: 'Invalid API key.' });
    return;
  }

  await resetIfNewMonth(user.id, new Date(user.billing_cycle_start));

  const limits = PLAN_LIMITS[user.plan] ?? PLAN_LIMITS.free;

  // Check total builds for free tier
  if (limits.totalBuilds !== undefined && user.total_builds >= limits.totalBuilds) {
    res.status(403).json({
      error: 'Free plan limit reached. You have used your 1 free build.',
      upgrade: 'Upgrade to Starter ($15/mo) for 5 builds/month.',
    });
    return;
  }

  // Check monthly builds
  if (user.builds_this_month >= limits.buildsPerMonth) {
    res.status(403).json({
      error: `Monthly build limit reached (${limits.buildsPerMonth} builds/mo on ${user.plan} plan).`,
      upgrade: user.plan === 'starter' ? 'Upgrade to Pro ($25/mo) for unlimited builds.' : undefined,
    });
    return;
  }

  // Attach user to request for downstream use
  (req as any).pixelUser = user;
  next();
}

// ─── Record a build after it starts ──────────────────────────────────────────

export async function recordBuild(userId: string, sessionId: string, plan: string) {
  const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
  const expiresAt = limits.hostingDays
    ? new Date(Date.now() + limits.hostingDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  await db.from('builds').insert({ user_id: userId, session_id: sessionId, expires_at: expiresAt });
  await db.rpc('increment_build_counts', { user_id_input: userId });
}

// ─── Update build status when done ───────────────────────────────────────────

export async function updateBuildStatus(sessionId: string, status: string, deployUrl?: string) {
  await db.from('builds').update({ status, deploy_url: deployUrl ?? null }).eq('session_id', sessionId);
}
