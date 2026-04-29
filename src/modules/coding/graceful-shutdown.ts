/**
 * Graceful shutdown — drains in-flight coding sessions cleanly before host
 * exit.
 *
 * Why: a host SIGTERM/SIGINT must not leave devcontainer-backed coding
 * sessions in flight. Sessions are long-lived (one per coding task), and
 * killing the host without telling the container means the agent runner
 * exits mid-tool-call, the tool partial-state is on disk, and the next
 * boot's orphan scanner has to clean it up. The graceful path lets the
 * container stop on its own poll-loop tick.
 *
 * Algorithm:
 *
 *   1. Enumerate active sessions whose agent_group's container.json
 *      declares `containerBackend: 'devcontainer'`.
 *
 *   2. For each, write a `_shutdown` system message into the session's
 *      inbound.db (`messages_in`, kind='system', content='_shutdown').
 *      The container poll-loop sees it within ~250ms and exits cleanly.
 *
 *   3. Wait up to `CODING_GRACEFUL_SHUTDOWN_MS` (default 30000) polling
 *      `docker ps` for the matching `nanoclaw.session=<id>` label. As
 *      sessions go away their containers do too, and the wait short-
 *      circuits when all are gone.
 *
 *   4. For stragglers: `devcontainer stop --workspace-folder <path>` per
 *      session, with a 10s timeout each.
 *
 *   5. Release worktree locks for stopped sessions explicitly.
 *      (FK cascade does it automatically when sessions are deleted; we
 *      don't delete sessions on shutdown — they live to the next boot —
 *      so locks need explicit release here.)
 *
 *   6. Log each step. Continue exit even if some stragglers don't stop —
 *      surface as warnings so the next-boot orphan scanner picks up the
 *      remainder.
 *
 * Wired into `src/index.ts` shutdown(); see `gracefulShutdown` in
 * `src/modules/coding/index.ts`.
 */
import { execFileSync } from 'child_process';

import { CONTAINER_INSTALL_LABEL } from '../../config.js';
import { readContainerConfig } from '../../container-config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getActiveSessions } from '../../db/sessions.js';
import { writeSessionMessage } from '../../session-manager.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

import { listWorktreeLocks, releaseWorktreeLock, type WorktreeLock } from './worktree-locks.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1000;
const FALLBACK_STOP_TIMEOUT_MS = 10_000;

const DEVCONTAINER_BIN = (): string => process.env.DEVCONTAINER_BIN || 'devcontainer';

function defaultTimeoutMs(): number {
  const env = process.env.CODING_GRACEFUL_SHUTDOWN_MS;
  if (env) {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TIMEOUT_MS;
}

/** Live-container snapshot. Mirrors orphan-scanner's RunningContainer. */
export interface LiveContainer {
  containerId: string;
  sessionId: string;
  workspaceFolder: string;
}

/** Production docker-ps used to detect which session containers remain alive. */
function defaultDockerPs(): string {
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
}

function defaultDevcontainerStop(workspaceFolder: string): void {
  execFileSync(DEVCONTAINER_BIN(), ['stop', '--workspace-folder', workspaceFolder], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: FALLBACK_STOP_TIMEOUT_MS,
  });
}

function parseDockerPs(out: string): LiveContainer[] {
  const containers: LiveContainer[] = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [containerId, sessionId, workspaceFolder] = trimmed.split('\t');
    if (!containerId || !sessionId) continue;
    containers.push({ containerId, sessionId, workspaceFolder: workspaceFolder ?? '' });
  }
  return containers;
}

export interface GracefulShutdownDeps {
  /** Override session enumeration; default uses central DB + container-config. */
  listCodingSessions?: () => Session[];
  /** Override `_shutdown` writer; default uses session-manager. */
  writeShutdownMessage?: (session: Session) => void;
  /** docker ps runner — returns tab-separated lines (id, sessionId, workspaceFolder). */
  dockerPs?: () => string;
  /** devcontainer stop runner — for stragglers. */
  devcontainerStop?: (workspaceFolder: string) => void;
  /** Lock listing + release; default uses worktree-locks helpers. */
  listLocks?: () => WorktreeLock[];
  releaseLock?: (worktreePath: string) => void;
  /** Override sleep — tests pass a fast-forward fake. */
  sleep?: (ms: number) => Promise<void>;
  /** Override timeout in ms (default reads CODING_GRACEFUL_SHUTDOWN_MS env or 30000). */
  timeoutMs?: number;
  /** Logger — defaults to module log. */
  logger?: { info: typeof log.info; warn: typeof log.warn };
}

function defaultListCodingSessions(): Session[] {
  const out: Session[] = [];
  for (const session of getActiveSessions()) {
    const ag = getAgentGroup(session.agent_group_id);
    if (!ag) continue;
    const cfg = readContainerConfig(ag.folder);
    if ((cfg.containerBackend ?? '').toLowerCase() === 'devcontainer') {
      out.push(session);
    }
  }
  return out;
}

function defaultWriteShutdownMessage(session: Session): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `_shutdown-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    content: '_shutdown',
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Graceful drain entry point. Returns when either all targeted sessions'
 * containers are gone, or the timeout fires (whichever comes first).
 * Never throws — surfaces failures as warnings so the host exit path is
 * not blocked by a sub-step.
 */
export async function gracefulShutdown(deps: GracefulShutdownDeps = {}): Promise<void> {
  const listCodingSessions = deps.listCodingSessions ?? defaultListCodingSessions;
  const writeShutdownMessage = deps.writeShutdownMessage ?? defaultWriteShutdownMessage;
  const dockerPs = deps.dockerPs ?? defaultDockerPs;
  const devcontainerStop = deps.devcontainerStop ?? defaultDevcontainerStop;
  const listLocks = deps.listLocks ?? listWorktreeLocks;
  const releaseLock = deps.releaseLock ?? releaseWorktreeLock;
  const sleep = deps.sleep ?? defaultSleep;
  const timeoutMs = deps.timeoutMs ?? defaultTimeoutMs();
  const logger = deps.logger ?? { info: log.info.bind(log), warn: log.warn.bind(log) };

  // Step 1: enumerate.
  let sessions: Session[];
  try {
    sessions = listCodingSessions();
  } catch (err) {
    logger.warn('graceful shutdown: failed to list coding sessions — aborting drain', { err });
    return;
  }
  if (sessions.length === 0) {
    logger.info('graceful shutdown: no devcontainer-backed coding sessions to drain');
    return;
  }

  logger.info('graceful shutdown: draining coding sessions', { count: sessions.length });

  // Step 2: write `_shutdown` into each inbound.db.
  for (const session of sessions) {
    try {
      writeShutdownMessage(session);
    } catch (err) {
      logger.warn('graceful shutdown: failed to write _shutdown', {
        sessionId: session.id,
        err,
      });
    }
  }

  const targetedSessionIds = new Set(sessions.map((s) => s.id));

  // Step 3: poll docker ps until all matching containers are gone or timeout.
  const deadline = Date.now() + timeoutMs;
  let remaining: LiveContainer[] = [];
  while (Date.now() < deadline) {
    let raw: string;
    try {
      raw = dockerPs();
    } catch (err) {
      logger.warn('graceful shutdown: docker ps failed during drain — using last snapshot', { err });
      break;
    }
    const live = parseDockerPs(raw);
    remaining = live.filter((c) => targetedSessionIds.has(c.sessionId));
    if (remaining.length === 0) {
      logger.info('graceful shutdown: all coding sessions exited cleanly');
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // Step 4: stop stragglers.
  if (remaining.length > 0) {
    logger.warn('graceful shutdown: timeout — stopping stragglers via devcontainer stop', {
      count: remaining.length,
      sessionIds: remaining.map((c) => c.sessionId),
    });
    for (const c of remaining) {
      if (!c.workspaceFolder) {
        logger.warn('graceful shutdown: straggler has no workspace label; cannot stop gracefully', {
          sessionId: c.sessionId,
          containerId: c.containerId,
        });
        continue;
      }
      try {
        devcontainerStop(c.workspaceFolder);
      } catch (err) {
        logger.warn('graceful shutdown: devcontainer stop failed for straggler', {
          sessionId: c.sessionId,
          workspaceFolder: c.workspaceFolder,
          err,
        });
      }
    }
  }

  // Step 5: release locks for ALL targeted sessions. Sessions live across
  // a restart — we don't delete the session row, so the FK cascade doesn't
  // trigger. Releasing here lets the next boot re-acquire cleanly without
  // waiting for the orphan scanner's 5-min tick.
  let locks: WorktreeLock[];
  try {
    locks = listLocks();
  } catch (err) {
    logger.warn('graceful shutdown: failed to list locks for release', { err });
    locks = [];
  }
  for (const lock of locks) {
    if (!targetedSessionIds.has(lock.sessionId)) continue;
    try {
      releaseLock(lock.worktreePath);
    } catch (err) {
      logger.warn('graceful shutdown: releaseLock failed', {
        sessionId: lock.sessionId,
        worktreePath: lock.worktreePath,
        err,
      });
    }
  }

  logger.info('graceful shutdown: drain complete');
}
