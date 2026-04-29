import type { Migration } from './index.js';

/**
 * Coding-agent PR monitor — CI failure surfacing.
 *
 * Extends `coding_pr_monitors` with two columns so the host poller can
 * detect failed workflow runs on the PR's HEAD commit and surface them to
 * the agent without re-detecting on every tick.
 *
 *   `last_head_sha`     — last observed PR head SHA. When this changes,
 *                          the surfaced-run cache is reset (new commit =
 *                          new CI cycle to evaluate).
 *   `surfaced_run_ids`  — JSON array of workflow run IDs already surfaced
 *                          to the agent for the current head SHA. Prevents
 *                          re-waking on every poll for an already-known
 *                          failure that's still red.
 */
export const moduleCodingPrMonitorsCi: Migration = {
  version: 102,
  name: 'coding-pr-monitors-ci',
  up(db) {
    db.exec(`
      ALTER TABLE coding_pr_monitors ADD COLUMN last_head_sha TEXT;
      ALTER TABLE coding_pr_monitors ADD COLUMN surfaced_run_ids TEXT;
    `);
  },
};
