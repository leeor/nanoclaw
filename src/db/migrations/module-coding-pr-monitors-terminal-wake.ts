import type { Migration } from './index.js';

/**
 * Coding-agent PR monitor — terminal wake handshake.
 *
 * Adds `terminal_wake_sent_at` so the host can record when it first woke
 * the agent for a MERGED/CLOSED PR. The agent is expected to call
 * `mcp__nanoclaw__delete_coding_task` itself (so the cost summary is
 * emitted from inside the container, where the JSONL log lives). If the
 * agent is idle / crashed / ignored the wake, a host-side fallback fires
 * after a grace period and runs the existing teardown directly.
 *
 *   `terminal_wake_sent_at` — ISO timestamp of when the terminal wake
 *                              was first dispatched. NULL while the PR is
 *                              still OPEN. Once set, subsequent ticks are
 *                              quiet no-ops until either the agent calls
 *                              `delete_coding_task` (cascade-deletes the
 *                              monitor row) or the grace period elapses.
 */
export const moduleCodingPrMonitorsTerminalWake: Migration = {
  version: 103,
  name: 'coding-pr-monitors-terminal-wake',
  up(db) {
    db.exec(`
      ALTER TABLE coding_pr_monitors ADD COLUMN terminal_wake_sent_at TEXT;
    `);
  },
};
