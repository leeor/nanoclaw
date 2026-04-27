import type { Migration } from './index.js';

/**
 * Coding-agent PR monitor — host-driven deterministic poller.
 *
 * v1 monitored PRs by scheduling a 5-min recurring agent task whose prompt
 * was 700 lines of LLM instructions for "fetch PR comments, dedupe, decide
 * if anything changed". Tokens burned every 5 minutes regardless of whether
 * GitHub had anything new.
 *
 * v2 inverts the loop: the host polls `gh pr view` + `gh api .../comments`
 * directly (with ETag fast-path for 304s), dedupes against
 * `coding_pr_monitor_seen`, and writes a wake message into the session's
 * inbound.db ONLY when fresh comments actually arrive. Quiescent PRs cost
 * zero tokens until something changes; the agent wakes with the comment
 * bodies already in its inbox.
 *
 * `coding_pr_monitors`     — one row per (agent_group, repo, pr) being watched.
 *                            ETags persisted so a 304 short-circuits the next tick.
 * `coding_pr_monitor_seen` — comment-id dedupe table; `updated_at` lets us
 *                            distinguish NEW from UPDATED on revisited comments.
 *
 * On agent_group DELETE the monitor cascades; on monitor DELETE the seen
 * rows cascade. Crashed-host repair is handled by the orphan scanner
 * (sub-task 5) — no extra bookkeeping needed.
 */
export const moduleCodingPrMonitors: Migration = {
  version: 101,
  name: 'coding-pr-monitors',
  up(db) {
    db.exec(`
      CREATE TABLE coding_pr_monitors (
        id                 TEXT PRIMARY KEY,
        agent_group_id     TEXT NOT NULL,
        messaging_group_id TEXT NOT NULL,
        thread_id          TEXT,
        pr_number          INTEGER NOT NULL,
        repo               TEXT NOT NULL,
        interval_ms        INTEGER NOT NULL DEFAULT 60000,
        next_run_at        TEXT NOT NULL,
        last_state         TEXT,
        last_etag_issue    TEXT,
        last_etag_review   TEXT,
        status             TEXT NOT NULL DEFAULT 'active',
        created_at         TEXT NOT NULL,
        FOREIGN KEY (agent_group_id) REFERENCES agent_groups(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_coding_pr_monitors_due
        ON coding_pr_monitors(status, next_run_at);

      CREATE TABLE coding_pr_monitor_seen (
        monitor_id   TEXT NOT NULL,
        comment_id   INTEGER NOT NULL,
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (monitor_id, comment_id),
        FOREIGN KEY (monitor_id) REFERENCES coding_pr_monitors(id) ON DELETE CASCADE
      );
    `);
  },
};
