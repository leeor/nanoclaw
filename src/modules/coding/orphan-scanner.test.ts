import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createSession } from '../../db/sessions.js';

import { __test, runOrphanScan, type OrphanScanDeps } from './orphan-scanner.js';
import { acquireWorktreeLock } from './worktree-locks.js';

function setupDb() {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({
    id: 'ag-1',
    name: 'coding',
    folder: 'coding',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
}

function makeSession(id: string) {
  createSession({
    id,
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: new Date().toISOString(),
  });
}

interface Recorder {
  releases: string[];
  devcontainerStops: string[];
  dockerStops: string[];
  warns: Array<{ msg: string; data?: unknown }>;
  infos: Array<{ msg: string; data?: unknown }>;
}

function buildDeps(opts: {
  dockerPsOutput?: string;
  dockerPsThrows?: boolean;
  devcontainerStopThrows?: boolean | ((path: string) => boolean);
  dockerStopThrows?: boolean | ((id: string) => boolean);
  /** Pretend these session ids no longer exist in the central DB. */
  goneSessions?: Set<string>;
}): { deps: OrphanScanDeps; rec: Recorder } {
  const rec: Recorder = {
    releases: [],
    devcontainerStops: [],
    dockerStops: [],
    warns: [],
    infos: [],
  };
  const deps: OrphanScanDeps = {
    releaseLock: (path: string) => {
      rec.releases.push(path);
    },
    dockerPs: () => {
      if (opts.dockerPsThrows) throw new Error('docker is dead');
      return opts.dockerPsOutput ?? '';
    },
    devcontainerStop: (path: string) => {
      const shouldThrow =
        typeof opts.devcontainerStopThrows === 'function'
          ? opts.devcontainerStopThrows(path)
          : opts.devcontainerStopThrows;
      if (shouldThrow) throw new Error('devcontainer stop failed');
      rec.devcontainerStops.push(path);
    },
    dockerStop: (id: string) => {
      const shouldThrow =
        typeof opts.dockerStopThrows === 'function' ? opts.dockerStopThrows(id) : opts.dockerStopThrows;
      if (shouldThrow) throw new Error('docker stop failed');
      rec.dockerStops.push(id);
    },
    sessionExists: opts.goneSessions
      ? (id: string) => !(opts.goneSessions as Set<string>).has(id)
      : undefined,
    logger: {
      info: (msg: string, data?: unknown) => {
        rec.infos.push({ msg, data });
      },
      warn: (msg: string, data?: unknown) => {
        rec.warns.push({ msg, data });
      },
    },
  };
  return { deps, rec };
}

beforeEach(() => {
  __test.reset();
  setupDb();
});

afterEach(() => {
  closeDb();
});

describe('runOrphanScan — happy paths', () => {
  it('no locks, no containers → no work', async () => {
    const { deps, rec } = buildDeps({ dockerPsOutput: '' });
    await runOrphanScan({ force: true, deps });
    expect(rec.releases).toEqual([]);
    expect(rec.devcontainerStops).toEqual([]);
    expect(rec.dockerStops).toEqual([]);
  });

  it('lock with matching live container → no release, no stop', async () => {
    makeSession('sess-1');
    acquireWorktreeLock('/wt/feature-a', 'sess-1');

    const { deps, rec } = buildDeps({
      dockerPsOutput: 'cid1\tsess-1\t/wt/feature-a\n',
    });
    await runOrphanScan({ force: true, deps });
    expect(rec.releases).toEqual([]);
    expect(rec.devcontainerStops).toEqual([]);
  });
});

describe('runOrphanScan — lock without container', () => {
  it('releases lock when no container has matching session label', async () => {
    makeSession('sess-1');
    acquireWorktreeLock('/wt/feature-a', 'sess-1');

    const { deps, rec } = buildDeps({ dockerPsOutput: '' });
    await runOrphanScan({ force: true, deps });
    expect(rec.releases).toEqual(['/wt/feature-a']);
  });

  it('releases multiple stale locks in one pass', async () => {
    makeSession('sess-1');
    makeSession('sess-2');
    acquireWorktreeLock('/wt/a', 'sess-1');
    acquireWorktreeLock('/wt/b', 'sess-2');

    const { deps, rec } = buildDeps({ dockerPsOutput: '' });
    await runOrphanScan({ force: true, deps });
    expect(rec.releases.sort()).toEqual(['/wt/a', '/wt/b']);
  });
});

describe('runOrphanScan — container without lock', () => {
  it('stops devcontainer with no matching lock row via devcontainer stop', async () => {
    makeSession('sess-1');
    // Note: no acquireWorktreeLock call.

    const { deps, rec } = buildDeps({
      dockerPsOutput: 'cid1\tsess-1\t/wt/feature-a\n',
    });
    await runOrphanScan({ force: true, deps });
    expect(rec.devcontainerStops).toEqual(['/wt/feature-a']);
    expect(rec.dockerStops).toEqual([]);
  });

  it('stops container whose session row is gone (cascade-deleted lock leaves nothing)', async () => {
    // Session is "gone" — lock would have cascade-deleted; container survived.
    const { deps, rec } = buildDeps({
      dockerPsOutput: 'cid1\tsess-orphan\t/wt/orphan\n',
      goneSessions: new Set(['sess-orphan']),
    });
    await runOrphanScan({ force: true, deps });
    expect(rec.devcontainerStops).toEqual(['/wt/orphan']);
  });

  it('falls back to docker stop when devcontainer stop fails', async () => {
    makeSession('sess-1');
    const { deps, rec } = buildDeps({
      dockerPsOutput: 'cid1\tsess-1\t/wt/feature-a\n',
      devcontainerStopThrows: true,
    });
    await runOrphanScan({ force: true, deps });
    expect(rec.devcontainerStops).toEqual([]);
    expect(rec.dockerStops).toEqual(['cid1']);
    expect(rec.warns.find((w) => w.msg.includes('falling back to docker stop'))).toBeTruthy();
  });

  it('falls back to docker stop directly when workspace folder label missing', async () => {
    makeSession('sess-1');
    const { deps, rec } = buildDeps({
      // tab-tab → empty workspace folder column
      dockerPsOutput: 'cid1\tsess-1\t\n',
    });
    await runOrphanScan({ force: true, deps });
    expect(rec.devcontainerStops).toEqual([]);
    expect(rec.dockerStops).toEqual(['cid1']);
  });

  it('logs warning but continues when docker stop fallback also fails', async () => {
    makeSession('sess-1');
    const { deps, rec } = buildDeps({
      dockerPsOutput: 'cid1\tsess-1\t/wt/a\ncid2\tsess-2\t/wt/b\n',
      devcontainerStopThrows: true,
      dockerStopThrows: (id: string) => id === 'cid1',
    });
    makeSession('sess-2');
    await runOrphanScan({ force: true, deps });
    // cid2 still got stopped via docker stop fallback.
    expect(rec.dockerStops).toContain('cid2');
    expect(rec.warns.find((w) => w.msg.includes('docker stop fallback failed'))).toBeTruthy();
  });
});

describe('runOrphanScan — multiple of each', () => {
  it('releases stale locks AND stops orphan containers in one pass', async () => {
    makeSession('sess-1');
    makeSession('sess-2');
    makeSession('sess-3');
    acquireWorktreeLock('/wt/a', 'sess-1'); // matched container — keep
    acquireWorktreeLock('/wt/b', 'sess-2'); // no container → release
    // sess-3 has a container but no lock → stop

    const { deps, rec } = buildDeps({
      dockerPsOutput: ['cid1\tsess-1\t/wt/a', 'cid3\tsess-3\t/wt/c'].join('\n') + '\n',
    });
    await runOrphanScan({ force: true, deps });

    expect(rec.releases).toEqual(['/wt/b']);
    expect(rec.devcontainerStops).toEqual(['/wt/c']);
  });
});

describe('runOrphanScan — fail-safe', () => {
  it('docker ps failure aborts WITHOUT releasing any locks', async () => {
    makeSession('sess-1');
    acquireWorktreeLock('/wt/a', 'sess-1');

    const { deps, rec } = buildDeps({ dockerPsThrows: true });
    await runOrphanScan({ force: true, deps });
    expect(rec.releases).toEqual([]);
    expect(rec.devcontainerStops).toEqual([]);
    expect(rec.dockerStops).toEqual([]);
    expect(rec.warns.find((w) => w.msg.includes('docker ps failed'))).toBeTruthy();
  });
});

describe('runOrphanScan — rate limiting', () => {
  it('non-forced calls within 5 minutes early-exit (single dockerPs invocation)', async () => {
    let calls = 0;
    const deps: OrphanScanDeps = {
      listLocks: () => [],
      dockerPs: () => {
        calls++;
        return '';
      },
    };
    await runOrphanScan({ force: true, deps });
    await runOrphanScan({ deps });
    await runOrphanScan({ deps });
    expect(calls).toBe(1);
  });

  it('force bypasses the rate limit', async () => {
    let calls = 0;
    const deps: OrphanScanDeps = {
      listLocks: () => [],
      dockerPs: () => {
        calls++;
        return '';
      },
    };
    await runOrphanScan({ force: true, deps });
    await runOrphanScan({ force: true, deps });
    expect(calls).toBe(2);
  });
});
