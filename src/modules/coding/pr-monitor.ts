/**
 * Deterministic, host-driven PR monitor.
 *
 * Pure functions — all real-world side effects (gh shell-out, ETag fetch,
 * session-DB wake) are injected via `PrMonitorDeps` so tests can pass fakes.
 * The runtime wiring lives in `pr-monitor-runtime.ts`.
 *
 * Algorithm per due monitor (see `pollOneMonitor`):
 *   0. Quiescent terminal-wake-sent fast path: if `terminal_wake_sent_at`
 *      is set and the grace period hasn't elapsed, advance next_run_at and
 *      return (no fetches, no wakes, no cleanup). If past grace, run the
 *      host-side fallback (cleanup + deactivate) and return.
 *   1. Fetch PR state. Terminal (MERGED / CLOSED) → wake the agent with a
 *      terminal payload so it can call `delete_coding_task` itself (emits
 *      the cost summary from inside the container). Persist
 *      `terminal_wake_sent_at`. Do NOT cleanup or deactivate yet — that's
 *      the fallback at step 0 once the grace period elapses.
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
  /** Last observed PR head SHA — `surfaced_run_ids` is keyed against this. */
  last_head_sha: string | null;
  /** JSON array of failed workflow_run ids already surfaced for `last_head_sha`. */
  surfaced_run_ids: string | null;
  /**
   * ISO timestamp of when the host first woke the agent for a terminal
   * (MERGED / CLOSED) PR state. Null while the PR is still OPEN. Once set,
   * subsequent ticks are quiet no-ops until either the agent calls
   * `delete_coding_task` (cascade-deletes the monitor row) or the grace
   * period elapses and the host-side fallback runs cleanup directly.
   */
  terminal_wake_sent_at: string | null;
  status: 'active' | 'completed';
  created_at: string;
}

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED';

/** PR state plus the HEAD SHA — both come from a single `gh pr view` call. */
export interface PrStateInfo {
  state: PrState;
  headSha: string;
}

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

/**
 * A failed GitHub Actions workflow run that the monitor decided to surface
 * to the agent. `log_path` is set when the host successfully downloaded the
 * failed-step logs to a file under the agent group's directory; if the
 * download failed `log_error` carries the reason and the agent has to fetch
 * logs itself.
 */
export interface CiFailure {
  run_id: number;
  name: string;
  conclusion: string;
  html_url: string;
  log_path: string | null;
  log_error?: string;
}

export interface WorkflowRun {
  id: number;
  name: string;
  head_sha: string;
  status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending';
  conclusion: string | null;
  html_url: string;
}

/**
 * Terminal-state metadata attached to a wake payload when the host has
 * just observed MERGED / CLOSED. The agent reads this and calls
 * `delete_coding_task` so the cost summary is emitted before teardown.
 * `reason` mirrors the value passed to `cleanupCodingTask` so the message
 * formatting and the fallback cleanup share the same vocabulary.
 */
export interface TerminalWake {
  state: 'MERGED' | 'CLOSED';
  reason: 'merged' | 'abandoned';
}

export interface WakePayload {
  pr_number: number;
  repo: string;
  comments: FreshComment[];
  ci_failures?: CiFailure[];
  /** Set only when the PR transitioned to MERGED / CLOSED on this tick. */
  terminal?: TerminalWake;
}

/** Subset of `console`/log surface the poller actually needs. */
export interface MonitorLogger {
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
}

export interface PrMonitorDeps {
  db: Database.Database;
  /**
   * Returns the PR state plus its current HEAD SHA. A single fetch satisfies
   * both the existing terminal-state check and the new CI-failure surfacing
   * path (which keys against the HEAD SHA).
   */
  fetchPrState: (repo: string, n: number) => Promise<PrStateInfo | null>;
  fetchComments: (
    repo: string,
    n: number,
    source: 'issue' | 'review',
    etag: string | null,
  ) => Promise<FetchCommentsResult>;
  /**
   * List GitHub Actions workflow runs whose `head_sha` matches the PR's
   * current HEAD. Returns null on transient failure (the poller keeps the
   * existing surfaced-run cache and retries next tick). Empty array means
   * "fetched successfully, no runs for this SHA".
   */
  fetchWorkflowRuns: (repo: string, headSha: string) => Promise<WorkflowRun[] | null>;
  /**
   * Download failed-step logs for a workflow run to a file inside the agent
   * group's directory. Returns `{ logPath }` (relative to the agent's
   * `/nanoclaw-group/` mount) on success, or `{ error }` on failure — the
   * monitor still surfaces the failure with the error string so the agent
   * can decide whether to fetch logs itself.
   */
  downloadWorkflowLogs: (
    repo: string,
    runId: number,
    agentGroupId: string,
  ) => Promise<{ logPath: string } | { error: string }>;
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

function setTerminalWakeSentAt(db: Database.Database, monitorId: string, when: Date): void {
  db.prepare('UPDATE coding_pr_monitors SET terminal_wake_sent_at = ? WHERE id = ?').run(when.toISOString(), monitorId);
}

/**
 * Grace period after the host first wakes the agent on a terminal PR before
 * the host runs the fallback cleanup itself. 5 minutes is enough for an
 * idle/busy agent to react and call `delete_coding_task` (which emits the
 * cost summary) but short enough that a crashed/ignored wake doesn't leave
 * the devcontainer running indefinitely.
 */
export const TERMINAL_WAKE_GRACE_MS = 5 * 60 * 1000;

function terminalReasonFor(state: 'MERGED' | 'CLOSED'): 'merged' | 'abandoned' {
  return state === 'MERGED' ? 'merged' : 'abandoned';
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
 * Workflow run conclusions that constitute a "failure" worth surfacing.
 * Excludes `success`, `neutral`, `skipped` (no agent action needed) and
 * the non-conclusive `null` (run still in progress).
 */
const FAILURE_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure']);

function parseSurfacedRunIds(json: string | null): Set<number> {
  if (!json) return new Set();
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is number => typeof x === 'number'));
  } catch {
    return new Set();
  }
}

/**
 * Fetch workflow runs for the PR's HEAD SHA, surface ones that have failed
 * since we last checked, download their failed-step logs, and persist the
 * updated head-sha + surfaced-run-id cache.
 *
 * Returns the list of failures the agent should be woken about (possibly
 * empty). Transient fetch failures (`runs === null`) leave the cache
 * untouched so the next tick re-evaluates.
 */
async function collectCiFailures(deps: PrMonitorDeps, monitor: MonitorRow, headSha: string): Promise<CiFailure[]> {
  let runs: WorkflowRun[] | null;
  try {
    runs = await deps.fetchWorkflowRuns(monitor.repo, headSha);
  } catch (err) {
    deps.log.warn('pr-monitor: fetchWorkflowRuns threw — preserving CI cache, will retry next tick', {
      monitorId: monitor.id,
      err,
    });
    return [];
  }
  if (runs === null) return [];

  // New head SHA → reset the surfaced-run cache; old failures on a stale
  // SHA are no longer relevant. Same SHA → keep prior surfaces.
  const surfaced =
    monitor.last_head_sha === headSha ? parseSurfacedRunIds(monitor.surfaced_run_ids) : new Set<number>();

  const ciFailures: CiFailure[] = [];
  for (const run of runs) {
    if (run.status !== 'completed') continue;
    if (!run.conclusion || !FAILURE_CONCLUSIONS.has(run.conclusion)) continue;
    if (surfaced.has(run.id)) continue;

    let logPath: string | null = null;
    let logError: string | undefined;
    try {
      const result = await deps.downloadWorkflowLogs(monitor.repo, run.id, monitor.agent_group_id);
      if ('logPath' in result) {
        logPath = result.logPath;
      } else {
        logError = result.error;
      }
    } catch (err) {
      logError = err instanceof Error ? err.message : String(err);
    }

    ciFailures.push({
      run_id: run.id,
      name: run.name,
      conclusion: run.conclusion,
      html_url: run.html_url,
      log_path: logPath,
      log_error: logError,
    });
    surfaced.add(run.id);
  }

  // Persist whether or not we surfaced anything new — the head-SHA column
  // must reflect what we just observed, even when there are zero failures
  // (otherwise a failure later on the same SHA would think it was a fresh
  // SHA and lose the dedupe).
  deps.db
    .prepare('UPDATE coding_pr_monitors SET last_head_sha = ?, surfaced_run_ids = ? WHERE id = ?')
    .run(headSha, JSON.stringify([...surfaced]), monitor.id);

  return ciFailures;
}

/**
 * Poll a single monitor. Catches its own errors and logs them so a bad PR
 * doesn't stall the rest of the queue when called from `pollDuePrMonitors`.
 *
 * Returns `true` if the agent was woken, `false` otherwise. Useful for tests.
 */
export async function pollOneMonitor(deps: PrMonitorDeps, monitor: MonitorRow): Promise<boolean> {
  const now = nowFn(deps);

  // Step 0: terminal-wake-sent fast path. Skip every fetch + side-effect
  // until either the grace elapses (host-side fallback below) or the agent
  // calls `delete_coding_task` (cascade-deletes the monitor row, so we
  // never see this code path on a subsequent tick).
  if (monitor.terminal_wake_sent_at) {
    const sentAtMs = Date.parse(monitor.terminal_wake_sent_at);
    const elapsed = now.getTime() - sentAtMs;
    if (Number.isFinite(sentAtMs) && elapsed >= TERMINAL_WAKE_GRACE_MS) {
      // Grace exceeded — agent didn't react. Use last_state to pick the
      // reason so we don't burn another `gh pr view` call here. Falls
      // back to 'merged' for any unexpected state value (defensive — the
      // column should always be MERGED or CLOSED at this point).
      const reason: 'merged' | 'abandoned' =
        monitor.last_state === 'CLOSED' ? 'abandoned' : 'merged';
      try {
        await deps.cleanupCodingTask(monitor.agent_group_id, reason);
      } catch (err) {
        deps.log.error('pr-monitor: fallback cleanupCodingTask threw', { monitorId: monitor.id, err });
      }
      deactivatePrMonitor(deps.db, monitor.id);
      deps.log.info('pr-monitor: terminal-wake grace elapsed — host-side fallback cleanup ran', {
        monitorId: monitor.id,
        pr: monitor.pr_number,
        repo: monitor.repo,
        reason,
        elapsedMs: elapsed,
      });
      return false;
    }
    // Within grace — stay quiet. No fetches, no wakes, no cleanup. Just
    // advance the schedule so we re-check later.
    advanceNextRun(deps.db, monitor, now);
    return false;
  }

  // Step 1: PR state + HEAD SHA.
  let info: PrStateInfo | null;
  try {
    info = await deps.fetchPrState(monitor.repo, monitor.pr_number);
  } catch (err) {
    deps.log.warn('pr-monitor: fetchPrState threw — will retry next tick', {
      monitorId: monitor.id,
      err,
    });
    advanceNextRun(deps.db, monitor, now);
    return false;
  }

  if (info === null) {
    // Transient / network error — retry next tick. Don't update last_state.
    advanceNextRun(deps.db, monitor, now);
    return false;
  }

  const state = info.state;
  const headSha = info.headSha;

  if (state !== monitor.last_state) {
    updateLastState(deps.db, monitor.id, state);
  }

  if (state === 'MERGED' || state === 'CLOSED') {
    // Terminal-wake-first. Wake the agent with a structured terminal
    // payload so it can call `delete_coding_task` itself — that path emits
    // the cost summary from inside the container before teardown. Don't
    // cleanup or deactivate here; the fallback at Step 0 takes over once
    // the grace elapses (catches busy / crashed / ignored agents).
    const reason = terminalReasonFor(state);
    const payload: WakePayload = {
      pr_number: monitor.pr_number,
      repo: monitor.repo,
      comments: [],
      terminal: { state, reason },
    };
    try {
      await deps.wakeAgent(monitor, payload);
    } catch (err) {
      // Wake failed — leave terminal_wake_sent_at NULL so the next tick
      // retries. Last state already updated; agent_group cleanup hasn't
      // happened so the agent will get its chance again.
      deps.log.error('pr-monitor: terminal wakeAgent threw — will retry next tick', {
        monitorId: monitor.id,
        err,
      });
      advanceNextRun(deps.db, monitor, now);
      return false;
    }
    setTerminalWakeSentAt(deps.db, monitor.id, now);
    advanceNextRun(deps.db, monitor, now);
    deps.log.info('pr-monitor: terminal wake sent — awaiting agent delete_coding_task', {
      monitorId: monitor.id,
      pr: monitor.pr_number,
      repo: monitor.repo,
      state,
      graceMs: TERMINAL_WAKE_GRACE_MS,
    });
    return true;
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

  // Step 3: CI failures on the current HEAD SHA. Independent of comments —
  // a clean comment fetch with a freshly-failed CI run still warrants a
  // wake. The surfaced-run cache is keyed against `last_head_sha`; on a new
  // commit (HEAD SHA changed) we reset and re-evaluate every run for this
  // SHA from scratch.
  const ciFailures = await collectCiFailures(deps, monitor, headSha);

  if (fresh.length === 0 && ciFailures.length === 0) {
    advanceNextRun(deps.db, monitor, now);
    return false;
  }

  // Step 5: wake agent.
  const payload: WakePayload = {
    pr_number: monitor.pr_number,
    repo: monitor.repo,
    comments: fresh,
    ci_failures: ciFailures.length > 0 ? ciFailures : undefined,
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
    ciFailureCount: ciFailures.length,
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
