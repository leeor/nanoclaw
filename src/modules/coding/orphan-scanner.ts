/**
 * Orphan scanner — reconciles `coding_worktree_locks` with actually-running
 * devcontainers on host startup.
 *
 * On a clean shutdown the graceful-shutdown handler releases every lock and
 * stops every devcontainer. After a crash, the lock table can carry stale
 * rows whose containers are gone, or the inverse — running containers
 * whose lock was lost. Both cases are repaired here.
 *
 * Algorithm (full impl in sub-task 5):
 *   1. List devcontainers via `docker ps --filter label=nanoclaw.install=...`.
 *   2. SELECT * FROM coding_worktree_locks.
 *   3. For each lock row whose session_id is no longer in `sessions`
 *      (FK should cascade-delete, but defensive sweep) → release.
 *   4. For each lock row whose container is not running → attempt graceful
 *      stop, then release.
 *   5. For each running coding devcontainer with no matching lock → stop
 *      it (orphaned process from a crashed prior run).
 *
 * NOTE: stub for sub-task 2. Full implementation lives in sub-task 5,
 * which ports v1's `coding-orphan-scanner.ts`.
 */
import { log } from '../../log.js';

export async function runOrphanScan(): Promise<void> {
  log.info('coding orphan-scan (stub — sub-task 5 ports v1 logic)');
}
