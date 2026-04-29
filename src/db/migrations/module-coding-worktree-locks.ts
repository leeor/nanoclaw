import type { Migration } from './index.js';

/**
 * Coding-agent worktree mutex.
 *
 * Owned by the coding-agent skill. Prevents two devcontainers from running
 * concurrently in the same git worktree (would corrupt branch state,
 * package-lock, build artifacts). Per-worktree-path lock; sessions
 * targeting different worktrees still run in parallel.
 *
 * On session DELETE the FK cascades the lock row away — clean shutdown
 * needs no extra bookkeeping. Crashes are repaired by the orphan scanner
 * in `src/modules/coding/orphan-scanner.ts`.
 */
export const moduleCodingWorktreeLocks: Migration = {
  version: 100,
  name: 'coding-worktree-locks',
  up(db) {
    db.exec(`
      CREATE TABLE coding_worktree_locks (
        worktree_path TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL,
        acquired_at   TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_coding_worktree_locks_session
        ON coding_worktree_locks(session_id);
    `);
  },
};
