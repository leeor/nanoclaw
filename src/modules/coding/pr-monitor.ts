/**
 * Deterministic, host-driven PR monitor.
 *
 * Pure functions — all real-world side effects (gh shell-out, ETag fetch,
 * session-DB wake) are injected via `PrMonitorDeps` so tests can pass fakes.
 * The runtime wiring lives in `pr-monitor-runtime.ts`.
 *
 * Algorithm per due monitor (see `pollOneMonitor`):
 *   1. Fetch PR state. Terminal (MERGED / CLOSED) → cleanup + mark completed.
 *   2. Fetch issue + review comments with ETags. Both 304 → advance, return.
 *   3. Dedupe against `coding_pr_monitor_seen`; skip bot-noise allowlist.
 *   4. No fresh comments → store etags, advance, return. Zero tokens.
 *   5. Build wake payload, write into the session's inbound.db, upsert seen
 *      rows, store etags, advance.
 *
 * The bot-noise allowlist is intentionally hardcoded for now (`linear[bot]`,
 * `github-actions[bot]`); `claude[bot]` is always included so the agent
 * sees its own coordination messages from other coding sessions.
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';

export interface PrComment {
  id: number;
  user: { login: string };
  body: string;
  updated_at: string;
  /** Review comments carry the file path; issue comments don't. */
  path?: string;
  html_url: string;
  source: 'issue' | 'review';
}

export interface MonitorRow {
  id: string;
  agent_group_id: string;
  messaging_group_id: string;
  thread_id: string | null;
  pr_number: number;
  repo: string;
  interval_ms: number;
  next_run_at: string;
  last_state: string | null;
  last_etag_issue: string | null;
  last_etag_review: string | null;
  status: 'active' | 'completed';
  created_at: string;
}

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED';

export type FetchCommentsResult = { etag: string; comments: PrComment[] } | { notModified: true };

export interface FreshComment {
  id: number;
  author: string;
  body: string;
  path: string | null;
  html_url: string;
  source: 'issue' | 'review';
  kind: 'NEW' | 'UPDATED';
}

export interface WakePayload {
  pr_number: number;
  repo: string;
  comments: FreshComment[];
}

/** Subset of `console`/log surface the poller actually needs. */
export interface MonitorLogger {
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
}

export interface PrMonitorDeps {
  db: Database.Database;
  fetchPrState: (repo: string, n: number) => Promise<PrState | null>;
  fetchComments: (
    repo: string,
    n: number,
    source: 'issue' | 'review',
    etag: string | null,
  ) => Promise<FetchCommentsResult>;
  wakeAgent: (monitor: MonitorRow, payload: WakePayload) => Promise<void>;
  cleanupCodingTask: (agentGroupId: string, reason: 'merged' | 'abandoned') => Promise<void>;
  log: MonitorLogger;
  now?: () => Date;
}

const BOT_NOISE_LOGINS = new Set(['linear[bot]', 'github-actions[bot]']);

/** Always-include allowlist — these bot logins are coordination signal, not noise. */
const ALWAYS_INCLUDE_LOGINS = new Set(['claude[bot]']);

function nowFn(deps: PrMonitorDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function generateMonitorId(args: { agentGroupId: string; repo: string; prNumber: number; now: Date }): string {
  // Random suffix avoids same-ms collisions when a monitor is re-registered
  // immediately after being completed (e.g. PR reopened seconds later).
  const rand = Math.random().toString(36).slice(2, 8);
  return `${args.repo}#${args.prNumber}:${args.now.getTime()}-${rand}`;
}

export interface RegisterPrMonitorArgs {
  agentGroupId: string;
  messagingGroupId: string;
  threadId?: string | null;
  prNumber: number;
  repo: string;
  intervalMs?: number;
  /** Override clock for tests. */
  now?: () => Date;
}

/**
 * Register a new active monitor.
 *
 * Idempotent on (agent_group_id, repo, pr_number, status='active'): if a
 * matching active monitor exists, returns its id without inserting.
 */
export function registerPrMonitor(db: Database.Database, args: RegisterPrMonitorArgs): string {
  const existing = db
    .prepare(
      `SELECT id FROM coding_pr_monitors
        WHERE agent_group_id = ? AND repo = ? AND pr_number = ? AND status = 'active'
        LIMIT 1`,
    )
    .get(args.agentGroupId, args.repo, args.prNumber) as { id: string } | undefined;
  if (existing) return existing.id;

  const now = args.now ? args.now() : new Date();
  const id = generateMonitorId({
    agentGroupId: args.agentGroupId,
    repo: args.repo,
    prNumber: args.prNumber,
    now,
  });
  const intervalMs = args.intervalMs ?? 60_000;
  // First poll runs at "now" — we want to discover existing comments
  // immediately on register, not wait one full interval.
  const nextRunAt = now.toISOString();

  db.prepare(
    `INSERT INTO coding_pr_monitors
       (id, agent_group_id, messaging_group_id, thread_id, pr_number, repo,
        interval_ms, next_run_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).run(
    id,
    args.agentGroupId,
    args.messagingGroupId,
    args.threadId ?? null,
    args.prNumber,
    args.repo,
    intervalMs,
    nextRunAt,
    now.toISOString(),
  );

  return id;
}

export function deactivatePrMonitor(db: Database.Database, monitorId: string): void {
  db.prepare("UPDATE coding_pr_monitors SET status = 'completed' WHERE id = ?").run(monitorId);
}

function getDueMonitors(db: Database.Database, now: Date): MonitorRow[] {
  return db
    .prepare(
      `SELECT * FROM coding_pr_monitors
        WHERE status = 'active' AND next_run_at <= ?
        ORDER BY next_run_at ASC`,
    )
    .all(now.toISOString()) as MonitorRow[];
}

function advanceNextRun(db: Database.Database, monitor: MonitorRow, now: Date): void {
  const nextRun = new Date(now.getTime() + monitor.interval_ms).toISOString();
  db.prepare('UPDATE coding_pr_monitors SET next_run_at = ? WHERE id = ?').run(nextRun, monitor.id);
}

function updateLastState(db: Database.Database, monitorId: string, state: PrState): void {
  db.prepare('UPDATE coding_pr_monitors SET last_state = ? WHERE id = ?').run(state, monitorId);
}

function updateEtag(db: Database.Database, monitorId: string, source: 'issue' | 'review', etag: string): void {
  const col = source === 'issue' ? 'last_etag_issue' : 'last_etag_review';
  db.prepare(`UPDATE coding_pr_monitors SET ${col} = ? WHERE id = ?`).run(etag, monitorId);
}

function getSeen(db: Database.Database, monitorId: string): Map<number, string> {
  const rows = db
    .prepare('SELECT comment_id, updated_at FROM coding_pr_monitor_seen WHERE monitor_id = ?')
    .all(monitorId) as Array<{ comment_id: number; updated_at: string }>;
  const m = new Map<number, string>();
  for (const r of rows) m.set(r.comment_id, r.updated_at);
  return m;
}

function upsertSeen(
  db: Database.Database,
  monitorId: string,
  comments: Array<{ id: number; updated_at: string }>,
): void {
  const stmt = db.prepare(
    `INSERT INTO coding_pr_monitor_seen (monitor_id, comment_id, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(monitor_id, comment_id) DO UPDATE SET updated_at = excluded.updated_at`,
  );
  const tx = db.transaction((rows: Array<{ id: number; updated_at: string }>) => {
    for (const r of rows) stmt.run(monitorId, r.id, r.updated_at);
  });
  tx(comments);
}

function shouldIncludeAuthor(login: string): boolean {
  if (ALWAYS_INCLUDE_LOGINS.has(login)) return true;
  return !BOT_NOISE_LOGINS.has(login);
}

function classifyFresh(
  comments: PrComment[],
  seen: Map<number, string>,
): Array<{ comment: PrComment; kind: 'NEW' | 'UPDATED' }> {
  const out: Array<{ comment: PrComment; kind: 'NEW' | 'UPDATED' }> = [];
  for (const c of comments) {
    if (!shouldIncludeAuthor(c.user.login)) continue;
    const prev = seen.get(c.id);
    if (prev === undefined) {
      out.push({ comment: c, kind: 'NEW' });
    } else if (prev !== c.updated_at) {
      out.push({ comment: c, kind: 'UPDATED' });
    }
  }
  return out;
}

/**
 * Poll a single monitor. Catches its own errors and logs them so a bad PR
 * doesn't stall the rest of the queue when called from `pollDuePrMonitors`.
 *
 * Returns `true` if the agent was woken, `false` otherwise. Useful for tests.
 */
export async function pollOneMonitor(deps: PrMonitorDeps, monitor: MonitorRow): Promise<boolean> {
  const now = nowFn(deps);

  // Step 1: PR state.
  let state: PrState | null;
  try {
    state = await deps.fetchPrState(monitor.repo, monitor.pr_number);
  } catch (err) {
    deps.log.warn('pr-monitor: fetchPrState threw — will retry next tick', {
      monitorId: monitor.id,
      err,
    });
    advanceNextRun(deps.db, monitor, now);
    return false;
  }

  if (state === null) {
    // Transient / network error — retry next tick. Don't update last_state.
    advanceNextRun(deps.db, monitor, now);
    return false;
  }

  if (state !== monitor.last_state) {
    updateLastState(deps.db, monitor.id, state);
  }

  if (state === 'MERGED' || state === 'CLOSED') {
    const reason = state === 'MERGED' ? 'merged' : 'abandoned';
    try {
      await deps.cleanupCodingTask(monitor.agent_group_id, reason);
    } catch (err) {
      deps.log.error('pr-monitor: cleanupCodingTask threw', { monitorId: monitor.id, err });
    }
    deactivatePrMonitor(deps.db, monitor.id);
    deps.log.info('pr-monitor: monitor terminal', {
      monitorId: monitor.id,
      pr: monitor.pr_number,
      repo: monitor.repo,
      state,
    });
    return false;
  }

  // Step 2: comments. Fetch issue + review independently — a transient
  // failure on one source shouldn't lose progress on the other.
  const fresh: FreshComment[] = [];
  for (const source of ['issue', 'review'] as const) {
    const lastEtag = source === 'issue' ? monitor.last_etag_issue : monitor.last_etag_review;
    let result: FetchCommentsResult;
    try {
      result = await deps.fetchComments(monitor.repo, monitor.pr_number, source, lastEtag);
    } catch (err) {
      deps.log.warn('pr-monitor: fetchComments threw — preserving etag, will retry next tick', {
        monitorId: monitor.id,
        source,
        err,
      });
      continue;
    }

    if ('notModified' in result) {
      // 304 — nothing new on this source. Etag unchanged.
      continue;
    }

    const seen = getSeen(deps.db, monitor.id);
    const classified = classifyFresh(result.comments, seen);
    for (const { comment, kind } of classified) {
      fresh.push({
        id: comment.id,
        author: comment.user.login,
        body: comment.body,
        path: comment.path ?? null,
        html_url: comment.html_url,
        source,
        kind,
      });
    }

    // Persist etag only after successful fetch + dedupe — preserves the
    // load-bearing invariant that an unupdated etag means "we never saw a
    // 200 for this source", so the next tick re-fetches without
    // If-None-Match and the comment surface is rebuilt from scratch.
    updateEtag(deps.db, monitor.id, source, result.etag);

    // Always upsert seen rows for the comments we just learned about, even
    // if all of them were filtered as bot noise — otherwise a noisy bot
    // would re-trigger a re-fetch loop on every tick.
    upsertSeen(
      deps.db,
      monitor.id,
      result.comments.map((c) => ({ id: c.id, updated_at: c.updated_at })),
    );
  }

  if (fresh.length === 0) {
    advanceNextRun(deps.db, monitor, now);
    return false;
  }

  // Step 5: wake agent.
  const payload: WakePayload = {
    pr_number: monitor.pr_number,
    repo: monitor.repo,
    comments: fresh,
  };
  try {
    await deps.wakeAgent(monitor, payload);
  } catch (err) {
    // Wake failed — back out the next-run advance so we retry sooner. The
    // seen rows are already persisted, so a successful retry won't re-wake
    // for the same comments. We DON'T roll back etags either: a 200 already
    // happened, the host has the comments — re-asking GitHub is wasted.
    deps.log.error('pr-monitor: wakeAgent threw — will retry next tick', {
      monitorId: monitor.id,
      err,
    });
    advanceNextRun(deps.db, monitor, now);
    return false;
  }

  deps.log.info('pr-monitor: woke agent', {
    monitorId: monitor.id,
    pr: monitor.pr_number,
    repo: monitor.repo,
    freshCount: fresh.length,
  });
  advanceNextRun(deps.db, monitor, now);
  return true;
}

/**
 * Sweep entry point. Selects all due active monitors and polls each. Per-
 * monitor errors are caught + logged so one bad PR doesn't stall the rest.
 *
 * Wired from `src/host-sweep.ts` via `MODULE-HOOK:coding-pr-monitor`.
 */
export async function pollDuePrMonitors(deps: PrMonitorDeps): Promise<void> {
  const now = nowFn(deps);
  const due = getDueMonitors(deps.db, now);
  for (const monitor of due) {
    try {
      await pollOneMonitor(deps, monitor);
    } catch (err) {
      // Defence in depth — pollOneMonitor already catches its known failure
      // modes; this catches anything we missed (e.g. a SQLite-level error).
      log.error('pr-monitor: pollOneMonitor threw unexpectedly', {
        monitorId: monitor.id,
        err,
      });
    }
  }
}
