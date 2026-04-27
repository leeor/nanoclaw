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
 *   - An orphan scanner that runs on host startup to reconcile
 *     coding_worktree_locks against actually-running devcontainers (see
 *     ./orphan-scanner.ts).
 *   - A graceful shutdown handler that signals active devcontainers to
 *     close cleanly before host exit.
 *
 * Architecture: one v2 session per coding task. Session container = the
 * devcontainer (registered via the `devcontainer` containerBackend in
 * src/container-backends/devcontainer.ts). PR monitoring runs as a
 * scheduled task INSIDE the session, via the scheduling module — there is
 * no host-side cron loop.
 *
 * This skeleton registers the module and exposes the public hooks. Each
 * sub-task fills in its handler. Empty handlers are safe no-ops.
 */
import { registerDeliveryAction } from '../../delivery.js';

import { handleCostSummary } from './cost-summary.js';
import { runOrphanScan } from './orphan-scanner.js';

// Delivery actions: the agent inside the devcontainer writes
// messages_out rows with kind='system' + action='coding_cost_summary'
// when a task completes. The handler posts to the originating channel
// and adds a PR comment.
registerDeliveryAction('coding_cost_summary', handleCostSummary);

/**
 * Initialize coding-agent module on host startup. Called from src/index.ts
 * after migrations + channel adapters are up.
 *
 * Currently runs the orphan scanner; later sub-tasks may add scheduled
 * housekeeping. Safe to call multiple times — internal state guards
 * idempotency.
 */
export async function initCodingModule(): Promise<void> {
  await runOrphanScan();
}

export { acquireWorktreeLock, releaseWorktreeLock, listWorktreeLocks } from './worktree-locks.js';
