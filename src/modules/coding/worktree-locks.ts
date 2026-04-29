/**
 * Worktree mutex — prevents two devcontainers from running concurrently in
 * the same git worktree.
 *
 * Per-worktree-path lock backed by `coding_worktree_locks` (central DB).
 * Sessions targeting different worktrees still run in parallel; there is
 * no host-wide concurrency cap.
 *
 * Lifecycle:
 *   - Acquired by the coding-task spawn path before `containerBackend.spawn`.
 *   - Released on session DELETE via FK cascade (ON DELETE CASCADE).
 *   - Released explicitly by the orphan scanner for sessions that survived
 *     a host crash but whose container is gone.
 *
 * Concurrency semantics:
 *   - `acquireWorktreeLock` returns `null` if the worktree is already locked
 *     by a different session. Caller must surface "another coding task is
 *     already using this worktree — try again when it finishes" to the user.
 *   - Re-acquire by the same session is a no-op (returns the existing row)
 *     so retries after transient failures don't deadlock the worktree.
 */
import { getDb, hasTable } from '../../db/connection.js';
import { log } from '../../log.js';

export interface WorktreeLock {
  worktreePath: string;
  sessionId: string;
  acquiredAt: string;
}

interface LockRow {
  worktree_path: string;
  session_id: string;
  acquired_at: string;
}

const TABLE = 'coding_worktree_locks';

function rowToLock(row: LockRow): WorktreeLock {
  return {
    worktreePath: row.worktree_path,
    sessionId: row.session_id,
    acquiredAt: row.acquired_at,
  };
}

/**
 * Try to acquire a lock for `worktreePath` on behalf of `sessionId`.
 *
 * Returns the lock row on success. Returns `null` if the worktree is
 * already locked by a *different* session — caller must retry later.
 * If the same session already holds the lock, this is a no-op success.
 */
export function acquireWorktreeLock(worktreePath: string, sessionId: string): WorktreeLock | null {
  const db = getDb();
  if (!hasTable(db, TABLE)) {
    log.warn('coding_worktree_locks table missing — skill not migrated?', { worktreePath });
    return null;
  }
  const now = new Date().toISOString();

  // Single-statement upsert with conditional WHERE. INSERT-OR-IGNORE plus a
  // SELECT is racy across processes but safe within a single host because
  // SQLite serializes writes; we additionally verify the result with a
  // SELECT to detect conflict.
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO ${TABLE} (worktree_path, session_id, acquired_at) VALUES (?, ?, ?)`,
  );
  insertStmt.run(worktreePath, sessionId, now);

  const row = db
    .prepare(`SELECT worktree_path, session_id, acquired_at FROM ${TABLE} WHERE worktree_path = ?`)
    .get(worktreePath) as LockRow | undefined;
  if (!row) return null;
  if (row.session_id !== sessionId) {
    log.info('worktree lock contention', {
      worktreePath,
      requestedBy: sessionId,
      heldBy: row.session_id,
    });
    return null;
  }
  return rowToLock(row);
}

/**
 * Release the lock on `worktreePath`. Idempotent — silently no-ops if no
 * lock exists. Used by the orphan scanner; routine session-end cleanup
 * happens via the sessions FK cascade.
 */
export function releaseWorktreeLock(worktreePath: string): void {
  const db = getDb();
  if (!hasTable(db, TABLE)) return;
  db.prepare(`DELETE FROM ${TABLE} WHERE worktree_path = ?`).run(worktreePath);
}

/** Snapshot all current locks. Used by the orphan scanner. */
export function listWorktreeLocks(): WorktreeLock[] {
  const db = getDb();
  if (!hasTable(db, TABLE)) return [];
  const rows = db.prepare(`SELECT worktree_path, session_id, acquired_at FROM ${TABLE}`).all() as LockRow[];
  return rows.map(rowToLock);
}
