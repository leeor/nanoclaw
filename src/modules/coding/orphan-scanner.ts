/**
 * Orphan scanner — reconciles `coding_worktree_locks` with actually-running
 * devcontainers.
 *
 * Two failure modes the scanner repairs:
 *
 *   1. Lock row whose container is gone (host crashed, `devcontainer stop`
 *      ran during shutdown but DELETE on the lock row didn't make it). The
 *      scanner releases the lock so the next coding session can re-acquire
 *      it.
 *
 *   2. Devcontainer left running with no matching lock row, OR its session
 *      row has been deleted from the central DB. Either way the host has
 *      no way to talk to this container — graceful `devcontainer stop` plus
 *      a docker-stop fallback by id-label.
 *
 * Scope: scoped to THIS install via `nanoclaw.install=<install>` label so
 * a side-by-side install on the same machine cannot reap our containers
 * and we cannot reap theirs. Mirrors `cleanupOrphans()` in
 * `src/container-runtime.ts`.
 *
 * Trigger:
 *   - On host startup via `initCodingModule()` (called from `src/index.ts`).
 *   - Every 5 minutes from `src/host-sweep.ts` via the
 *     `MODULE-HOOK:coding-orphan-scan` site. The sweep tick is cheap when
 *     no work is due — `runOrphanScan` keeps an internal `lastScanAt` and
 *     early-exits when called more often than the configured interval.
 *
 * Fail-safe behaviour:
 *   - `docker ps` failures abort the scan without releasing any locks. A
 *     transient docker hiccup must NOT cause the scanner to re-issue locks
 *     someone else is actually using.
 *   - `devcontainer stop` failures fall back to `docker stop` by id-label;
 *     if that also fails we log warn and move on. The next sweep tick will
 *     try again.
 */
import { execFileSync } from 'child_process';

import { CONTAINER_INSTALL_LABEL } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';

import { listWorktreeLocks, releaseWorktreeLock, type WorktreeLock } from './worktree-locks.js';

/** How often the host-sweep hook actually runs the reconcile. */
const SCAN_INTERVAL_MS = 5 * 60 * 1000;
/** Override for tests via DEVCONTAINER_BIN env var; matches devcontainer.ts. */
const DEVCONTAINER_BIN = (): string => process.env.DEVCONTAINER_BIN || 'devcontainer';

/** Snapshot of a running coding-agent devcontainer. */
export interface RunningContainer {
  containerId: string;
  sessionId: string;
  /**
   * `devcontainer.local_folder` label is set by the devcontainer CLI itself
   * — we use it for graceful `devcontainer stop --workspace-folder <path>`.
   * Falls back to empty string when the label is absent (older CLI versions);
   * in that case stop drops to the docker-stop fallback.
   */
  workspaceFolder: string;
}

export type DockerPsRunner = () => string;

const defaultDockerPs: DockerPsRunner = () => {
  return execFileSync(
    'docker',
    [
      'ps',
      '--filter',
      `label=${CONTAINER_INSTALL_LABEL}`,
      '--filter',
      'label=nanoclaw.session',
      '--format',
      '{{.ID}}\t{{.Label "nanoclaw.session"}}\t{{.Label "devcontainer.local_folder"}}',
    ],
    {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
};

export type DevcontainerStopRunner = (workspaceFolder: string) => void;

const defaultDevcontainerStop: DevcontainerStopRunner = (workspaceFolder) => {
  execFileSync(DEVCONTAINER_BIN(), ['stop', '--workspace-folder', workspaceFolder], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
};

export type DockerStopRunner = (containerId: string) => void;

const defaultDockerStop: DockerStopRunner = (containerId) => {
  execFileSync('docker', ['stop', '-t', '10', containerId], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  });
};

export interface OrphanScanDeps {
  listLocks?: () => WorktreeLock[];
  releaseLock?: (worktreePath: string) => void;
  dockerPs?: DockerPsRunner;
  devcontainerStop?: DevcontainerStopRunner;
  dockerStop?: DockerStopRunner;
  /** Tests override; production resolves via `getSession`. */
  sessionExists?: (id: string) => boolean;
  /** Tests override; allows asserting on log calls. */
  logger?: { info: typeof log.info; warn: typeof log.warn };
}

function parseDockerPs(out: string): RunningContainer[] {
  const containers: RunningContainer[] = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [containerId, sessionId, workspaceFolder] = trimmed.split('\t');
    if (!containerId || !sessionId) continue;
    containers.push({
      containerId,
      sessionId,
      workspaceFolder: workspaceFolder ?? '',
    });
  }
  return containers;
}

function defaultSessionExists(id: string): boolean {
  return getSession(id) !== undefined;
}

let scanInFlight = false;
let lastScanAt = 0;

/**
 * Run a single reconcile pass. Safe to call from both host startup and the
 * periodic sweep tick — guards against re-entry and rate-limits to
 * `SCAN_INTERVAL_MS` (5 minutes) when called from the sweep.
 *
 * Pass `force: true` (used at boot) to bypass the rate-limit gate. Tests
 * can also pass injected dependencies for full deterministic coverage.
 */
export async function runOrphanScan(opts: { force?: boolean; deps?: OrphanScanDeps } = {}): Promise<void> {
  const force = opts.force ?? false;
  const now = Date.now();
  if (!force && now - lastScanAt < SCAN_INTERVAL_MS) return;
  if (scanInFlight) return;
  scanInFlight = true;
  lastScanAt = now;
  try {
    await reconcile(opts.deps ?? {});
  } catch (err) {
    log.error('coding orphan-scan threw', { err });
  } finally {
    scanInFlight = false;
  }
}

/**
 * Internal: pure reconcile body. Always uses the supplied deps, falling
 * back to the production runners when a dep is missing. Exposed for tests
 * via `runOrphanScan({ deps })`.
 */
async function reconcile(deps: OrphanScanDeps): Promise<void> {
  const listLocks = deps.listLocks ?? listWorktreeLocks;
  const releaseLock = deps.releaseLock ?? releaseWorktreeLock;
  const dockerPs = deps.dockerPs ?? defaultDockerPs;
  const devcontainerStop = deps.devcontainerStop ?? defaultDevcontainerStop;
  const dockerStop = deps.dockerStop ?? defaultDockerStop;
  const sessionExists = deps.sessionExists ?? defaultSessionExists;
  const logger = deps.logger ?? { info: log.info.bind(log), warn: log.warn.bind(log) };

  // 1. Discover live coding devcontainers. Failure here aborts — never
  //    release locks based on stale / partial container info.
  let raw: string;
  try {
    raw = dockerPs();
  } catch (err) {
    logger.warn('coding orphan-scan: docker ps failed — aborting (no locks released)', { err });
    return;
  }
  const containers = parseDockerPs(raw);
  const containersBySession = new Map<string, RunningContainer>();
  for (const c of containers) {
    containersBySession.set(c.sessionId, c);
  }

  const locks = listLocks();
  const locksBySession = new Map<string, WorktreeLock>();
  for (const l of locks) {
    locksBySession.set(l.sessionId, l);
  }

  // 2. Lock rows with no live container → release.
  for (const lock of locks) {
    if (containersBySession.has(lock.sessionId)) continue;
    logger.info('coding orphan-scan: releasing lock with no live container', {
      sessionId: lock.sessionId,
      worktreePath: lock.worktreePath,
    });
    try {
      releaseLock(lock.worktreePath);
    } catch (err) {
      logger.warn('coding orphan-scan: releaseLock failed', {
        sessionId: lock.sessionId,
        worktreePath: lock.worktreePath,
        err,
      });
    }
  }

  // 3. Live containers with no lock row OR whose session is gone → stop.
  for (const c of containers) {
    const lock = locksBySession.get(c.sessionId);
    const sessionAlive = sessionExists(c.sessionId);
    const orphan = !lock || !sessionAlive;
    if (!orphan) continue;

    logger.info('coding orphan-scan: stopping orphan devcontainer', {
      sessionId: c.sessionId,
      containerId: c.containerId,
      workspaceFolder: c.workspaceFolder,
      reason: !sessionAlive ? 'session gone' : 'no lock row',
    });

    let stopped = false;
    if (c.workspaceFolder) {
      try {
        devcontainerStop(c.workspaceFolder);
        stopped = true;
      } catch (err) {
        logger.warn('coding orphan-scan: devcontainer stop failed — falling back to docker stop', {
          sessionId: c.sessionId,
          workspaceFolder: c.workspaceFolder,
          err,
        });
      }
    }
    if (!stopped) {
      try {
        dockerStop(c.containerId);
      } catch (err) {
        logger.warn('coding orphan-scan: docker stop fallback failed', {
          sessionId: c.sessionId,
          containerId: c.containerId,
          err,
        });
      }
    }
  }

  // Suppress an unused-var warning on the imported db helper; reserved for
  // future cross-checks (e.g. matching session.agent_group_id back through
  // agent_groups for diagnostics).
  void getDb;
}

/**
 * Reset internal state. Test-only — exported under `__test` to keep the
 * production surface clean.
 */
export const __test = {
  reset(): void {
    scanInFlight = false;
    lastScanAt = 0;
  },
};
