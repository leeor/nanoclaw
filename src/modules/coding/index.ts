/**
 * Coding-agent module — host-side wiring for per-task devcontainer-backed
 * coding sessions.
 *
 * What this module owns:
 *
 *   - The `coding_worktree_locks` mutex table (see ./worktree-locks.ts and
 *     the `module-coding-worktree-locks` migration).
 *   - A delivery-action handler `coding_cost_summary` that posts a per-task
 *     cost summary back to the originating channel + PR (see
 *     ./cost-summary.ts).
 *   - A delivery-action handler `register_pr_monitor` that registers a new
 *     deterministic PR poller (see ./pr-monitor.ts) when the agent calls
 *     the container-side `monitor_pr` MCP tool.
 *   - The PR-monitor central-DB tables `coding_pr_monitors` +
 *     `coding_pr_monitor_seen` (see migration `module-coding-pr-monitors`),
 *     polled each host-sweep tick from the `MODULE-HOOK:coding-pr-monitor`
 *     site in `src/host-sweep.ts`. Wakes the agent ONLY when fresh
 *     non-noise comments arrive — quiescent PRs cost zero tokens.
 *   - An orphan scanner that runs on host startup to reconcile
 *     coding_worktree_locks against actually-running devcontainers (see
 *     ./orphan-scanner.ts).
 *   - A graceful shutdown handler that signals active devcontainers to
 *     close cleanly before host exit.
 *
 * Architecture: one v2 session per coding task. Session container = the
 * devcontainer (registered via the `devcontainer` containerBackend in
 * src/container-backends/devcontainer.ts). PR monitoring is host-driven:
 * the host polls `gh pr view` + `gh api .../comments` (with ETag
 * fast-path) and only wakes the session when the comment surface
 * actually changes. There is no in-session cron and no agent token spent
 * on quiescent PRs — see ./pr-monitor.ts and ./pr-monitor-runtime.ts.
 *
 * This skeleton registers the module and exposes the public hooks. Each
 * sub-task fills in its handler. Empty handlers are safe no-ops.
 */
import type Database from 'better-sqlite3';

import { registerDeliveryAction } from '../../delivery.js';
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

import { handleCostSummary } from './cost-summary.js';
import { handleCreateCodingTask } from './create-coding-task.js';
import { handleDeleteCodingTask } from './delete-coding-task.js';
import { runOrphanScan } from './orphan-scanner.js';
import { registerPrMonitor } from './pr-monitor.js';

// Delivery actions: the agent inside the devcontainer writes
// messages_out rows with kind='system' + action='coding_cost_summary'
// when a task completes. The handler posts to the originating channel
// and adds a PR comment.
registerDeliveryAction('coding_cost_summary', handleCostSummary);

/**
 * Delivery action `create_coding_task`.
 *
 * Source: parent's `create_coding_task` MCP tool. Spawns a per-task
 * coding agent group with a devcontainer-backed git worktree and wires
 * bidirectional parent/child agent_destinations. See create-coding-task.ts.
 */
registerDeliveryAction('create_coding_task', handleCreateCodingTask);

/**
 * Delivery action `delete_coding_task`.
 *
 * Source: parent's `delete_coding_task` MCP tool. Tears down the per-task
 * agent group: stops devcontainer, archives the Slack channel, drops the
 * OneCLI agent, removes worktree + branch, deletes DB rows.
 */
registerDeliveryAction('delete_coding_task', handleDeleteCodingTask);

/**
 * Delivery action `register_pr_monitor`.
 *
 * Source: container's `monitor_pr` MCP tool emits a system message with
 * `{ pr_number, repo, interval_ms? }`. The host registers a deterministic
 * monitor row in `coding_pr_monitors`, scoped to the calling session's
 * agent group + messaging group + thread. Idempotent at the DB layer
 * (`registerPrMonitor` deduplicates on agent_group/repo/pr/active).
 */
registerDeliveryAction(
  'register_pr_monitor',
  async (content: Record<string, unknown>, session: Session, _inDb: Database.Database) => {
    const prNumber = Number(content.pr_number);
    const repo = content.repo as string | undefined;
    const intervalMs = content.interval_ms !== undefined ? Number(content.interval_ms) : undefined;

    if (!Number.isInteger(prNumber) || prNumber <= 0 || !repo) {
      log.warn('register_pr_monitor: invalid payload — ignoring', {
        sessionId: session.id,
        prNumber: content.pr_number,
        repo: content.repo,
      });
      return;
    }
    if (!session.messaging_group_id) {
      log.warn('register_pr_monitor: session has no messaging group — cannot wire monitor', {
        sessionId: session.id,
      });
      return;
    }

    const monitorId = registerPrMonitor(getDb(), {
      agentGroupId: session.agent_group_id,
      messagingGroupId: session.messaging_group_id,
      threadId: session.thread_id,
      prNumber,
      repo,
      intervalMs,
    });
    log.info('PR monitor registered', {
      sessionId: session.id,
      monitorId,
      pr: prNumber,
      repo,
      intervalMs: intervalMs ?? 60_000,
    });
  },
);

/**
 * Initialize coding-agent module on host startup. Called from src/index.ts
 * after migrations + channel adapters are up.
 *
 * Currently runs the orphan scanner; later sub-tasks may add scheduled
 * housekeeping. Safe to call multiple times — internal state guards
 * idempotency.
 */
export async function initCodingModule(): Promise<void> {
  // Force the first scan at boot (bypasses the 5-minute rate limit).
  // Subsequent runs come from the host-sweep tick at SCAN_INTERVAL_MS.
  await runOrphanScan({ force: true });
}

export { acquireWorktreeLock, releaseWorktreeLock, listWorktreeLocks } from './worktree-locks.js';
export { pollDuePrMonitors } from './pr-monitor.js';
export { buildPrMonitorDeps } from './pr-monitor-runtime.js';
export { gracefulShutdown } from './graceful-shutdown.js';
