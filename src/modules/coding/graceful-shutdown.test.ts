import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import type { Session } from '../../types.js';

import { gracefulShutdown, type GracefulShutdownDeps } from './graceful-shutdown.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

interface Recorder {
  shutdownWrites: string[];
  devcontainerStops: string[];
  releases: string[];
  warns: Array<{ msg: string; data?: unknown }>;
  infos: Array<{ msg: string; data?: unknown }>;
  sleeps: number[];
}

interface FixtureOpts {
  sessions: Session[];
  /** docker ps output sequence — one entry per call. Last entry sticks. */
  dockerPsResponses: Array<string | { throws: true }>;
  writeThrows?: boolean;
  devcontainerStopThrows?: boolean | ((path: string) => boolean);
  listLocks?: Array<{ worktreePath: string; sessionId: string; acquiredAt: string }>;
  timeoutMs?: number;
  /** When true, sleep advances Date.now() so the deadline progresses. */
  fastForward?: boolean;
}

function buildDeps(opts: FixtureOpts): { deps: GracefulShutdownDeps; rec: Recorder } {
  const rec: Recorder = {
    shutdownWrites: [],
    devcontainerStops: [],
    releases: [],
    warns: [],
    infos: [],
    sleeps: [],
  };
  let psCall = 0;
  let virtualNow = Date.now();
  const deadline = virtualNow + (opts.timeoutMs ?? 5000);
  const realDateNow = Date.now;
  // Patch Date.now while the deps are in use to honor fast-forward sleeps.
  // We restore in afterEach via globalThis.
  if (opts.fastForward) {
    Date.now = () => virtualNow;
  }

  const deps: GracefulShutdownDeps = {
    listCodingSessions: () => opts.sessions,
    writeShutdownMessage: (session: Session) => {
      if (opts.writeThrows) throw new Error('write failed');
      rec.shutdownWrites.push(session.id);
    },
    dockerPs: () => {
      const r = opts.dockerPsResponses[Math.min(psCall, opts.dockerPsResponses.length - 1)];
      psCall++;
      if (r && typeof r === 'object' && 'throws' in r) {
        throw new Error('docker ps failed');
      }
      return (r as string) ?? '';
    },
    devcontainerStop: (path: string) => {
      const shouldThrow =
        typeof opts.devcontainerStopThrows === 'function'
          ? opts.devcontainerStopThrows(path)
          : opts.devcontainerStopThrows;
      if (shouldThrow) throw new Error('devcontainer stop failed');
      rec.devcontainerStops.push(path);
    },
    listLocks: () => opts.listLocks ?? [],
    releaseLock: (worktreePath: string) => {
      rec.releases.push(worktreePath);
    },
    sleep: async (ms: number) => {
      rec.sleeps.push(ms);
      if (opts.fastForward) {
        virtualNow += ms;
      }
    },
    timeoutMs: opts.timeoutMs ?? 5000,
    logger: {
      info: (msg: string, data?: unknown) => {
        rec.infos.push({ msg, data });
      },
      warn: (msg: string, data?: unknown) => {
        rec.warns.push({ msg, data });
      },
    },
  };

  // Restore hook — caller invokes via afterEach.
  void deadline;
  void realDateNow;
  return { deps, rec };
}

const realDateNow = Date.now;

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  Date.now = realDateNow;
  closeDb();
});

describe('gracefulShutdown — no active sessions', () => {
  it('returns immediately when no devcontainer-backed sessions are active', async () => {
    const { deps, rec } = buildDeps({ sessions: [], dockerPsResponses: [''] });
    await gracefulShutdown(deps);
    expect(rec.shutdownWrites).toEqual([]);
    expect(rec.devcontainerStops).toEqual([]);
    expect(rec.infos.find((i) => i.msg.includes('no devcontainer-backed coding sessions'))).toBeTruthy();
  });
});

describe('gracefulShutdown — clean exit within timeout', () => {
  it('writes _shutdown and exits when all containers go away', async () => {
    const sess = makeSession({ id: 'sess-A' });
    const { deps, rec } = buildDeps({
      sessions: [sess],
      // First poll: container still alive. Second poll: gone.
      dockerPsResponses: ['cidA\tsess-A\t/wt/A\n', ''],
      fastForward: true,
      timeoutMs: 30_000,
    });
    await gracefulShutdown(deps);
    expect(rec.shutdownWrites).toEqual(['sess-A']);
    expect(rec.devcontainerStops).toEqual([]); // no stragglers
    expect(rec.infos.find((i) => i.msg.includes('all coding sessions exited cleanly'))).toBeTruthy();
  });
});

describe('gracefulShutdown — stragglers', () => {
  it('falls back to devcontainer stop for stragglers after timeout', async () => {
    const sess = makeSession({ id: 'sess-A' });
    const { deps, rec } = buildDeps({
      sessions: [sess],
      // Container never exits.
      dockerPsResponses: ['cidA\tsess-A\t/wt/A\n'],
      fastForward: true,
      timeoutMs: 2_000,
    });
    await gracefulShutdown(deps);
    expect(rec.shutdownWrites).toEqual(['sess-A']);
    expect(rec.devcontainerStops).toEqual(['/wt/A']);
    expect(rec.warns.find((w) => w.msg.includes('timeout — stopping stragglers'))).toBeTruthy();
  });

  it('continues after devcontainer stop failure on a straggler', async () => {
    const sessA = makeSession({ id: 'sess-A' });
    const sessB = makeSession({ id: 'sess-B' });
    const { deps, rec } = buildDeps({
      sessions: [sessA, sessB],
      dockerPsResponses: ['cidA\tsess-A\t/wt/A\ncidB\tsess-B\t/wt/B\n'],
      devcontainerStopThrows: (p) => p === '/wt/A',
      fastForward: true,
      timeoutMs: 2_000,
    });
    await gracefulShutdown(deps);
    expect(rec.devcontainerStops).toEqual(['/wt/B']);
    expect(rec.warns.find((w) => w.msg.includes('devcontainer stop failed for straggler'))).toBeTruthy();
  });

  it('skips graceful stop when straggler has no workspace label, logs warn', async () => {
    const sessA = makeSession({ id: 'sess-A' });
    const { deps, rec } = buildDeps({
      sessions: [sessA],
      dockerPsResponses: ['cidA\tsess-A\t\n'],
      fastForward: true,
      timeoutMs: 2_000,
    });
    await gracefulShutdown(deps);
    expect(rec.devcontainerStops).toEqual([]);
    expect(rec.warns.find((w) => w.msg.includes('no workspace label'))).toBeTruthy();
  });
});

describe('gracefulShutdown — lock release', () => {
  it('releases locks for all targeted sessions', async () => {
    const sessA = makeSession({ id: 'sess-A' });
    const sessB = makeSession({ id: 'sess-B' });
    const now = new Date().toISOString();
    const { deps, rec } = buildDeps({
      sessions: [sessA, sessB],
      dockerPsResponses: [''], // both already gone
      fastForward: true,
      timeoutMs: 30_000,
      listLocks: [
        { worktreePath: '/wt/A', sessionId: 'sess-A', acquiredAt: now },
        { worktreePath: '/wt/B', sessionId: 'sess-B', acquiredAt: now },
        { worktreePath: '/wt/other', sessionId: 'sess-X', acquiredAt: now }, // not targeted
      ],
    });
    await gracefulShutdown(deps);
    expect(rec.releases.sort()).toEqual(['/wt/A', '/wt/B']);
  });
});

describe('gracefulShutdown — robustness', () => {
  it('continues when _shutdown write throws for a session', async () => {
    const sessA = makeSession({ id: 'sess-A' });
    const { deps, rec } = buildDeps({
      sessions: [sessA],
      dockerPsResponses: [''],
      writeThrows: true,
      fastForward: true,
      timeoutMs: 30_000,
    });
    await expect(gracefulShutdown(deps)).resolves.toBeUndefined();
    expect(rec.warns.find((w) => w.msg.includes('failed to write _shutdown'))).toBeTruthy();
  });

  it('breaks out of poll on docker ps failure (uses last snapshot)', async () => {
    const sessA = makeSession({ id: 'sess-A' });
    const { deps, rec } = buildDeps({
      sessions: [sessA],
      // First call returns alive; second throws — drain falls through.
      dockerPsResponses: ['cidA\tsess-A\t/wt/A\n', { throws: true }],
      fastForward: true,
      timeoutMs: 30_000,
    });
    await gracefulShutdown(deps);
    // Used the last successful snapshot — sess-A treated as a straggler.
    expect(rec.devcontainerStops).toEqual(['/wt/A']);
    expect(rec.warns.find((w) => w.msg.includes('docker ps failed during drain'))).toBeTruthy();
  });
});
