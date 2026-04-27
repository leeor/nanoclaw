/**
 * Worktree mutex — prevents two devcontainers from running concurrently in
 * the same git worktree.
 *
 * Per-worktree-path lock backed by `coding_worktree_locks` (central DB).
 * Sessions targeting different worktrees still run in parallel; there is
 * no host-wide concurrency cap. Released on session end (FK cascade) and
 * by the orphan scanner on host startup.
 *
 * NOTE: stub for sub-task 2. Sub-task 3 adds the migration and the real
 * acquire/release implementation. The exports here keep the module barrel
 * resolvable so the rest of the skeleton can land independently.
 */

export interface WorktreeLock {
  worktreePath: string;
  sessionId: string;
  acquiredAt: string;
}

export function acquireWorktreeLock(_worktreePath: string, _sessionId: string): WorktreeLock | null {
  // Sub-task 3: real impl. Returns null until then to make accidental
  // callers fail loudly rather than silently double-acquire.
  return null;
}

export function releaseWorktreeLock(_worktreePath: string): void {
  // Sub-task 3: real impl.
}

export function listWorktreeLocks(): WorktreeLock[] {
  // Sub-task 3: real impl.
  return [];
}
