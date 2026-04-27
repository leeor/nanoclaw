import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { runMigrations } from '../../db/migrations/index.js';

import {
  deactivatePrMonitor,
  pollDuePrMonitors,
  pollOneMonitor,
  registerPrMonitor,
  type FetchCommentsResult,
  type MonitorRow,
  type PrComment,
  type PrMonitorDeps,
  type PrState,
  type WakePayload,
} from './pr-monitor.js';

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface FixtureOptions {
  state?: PrState | null;
  stateThrows?: boolean;
  // keyed by source — issue/review
  comments?: { issue?: PrComment[] | 'throw'; review?: PrComment[] | 'throw' };
  /** When true, both issue + review return 304 regardless of stored etag. */
  bothNotModified?: boolean;
  /** Per-source 304 override. */
  notModified?: { issue?: boolean; review?: boolean };
  wakeThrows?: boolean;
  cleanupThrows?: boolean;
  now?: Date;
}

interface Fixture {
  deps: PrMonitorDeps;
  wakes: Array<{ monitor: MonitorRow; payload: WakePayload }>;
  cleanups: Array<{ agentGroupId: string; reason: 'merged' | 'abandoned' }>;
  fetchPrStateCalls: number;
  fetchCommentsCalls: Array<{ source: 'issue' | 'review'; etag: string | null }>;
}

function makeFixture(opts: FixtureOptions = {}): Fixture {
  const wakes: Fixture['wakes'] = [];
  const cleanups: Fixture['cleanups'] = [];
  const fetchCommentsCalls: Fixture['fetchCommentsCalls'] = [];
  let fetchPrStateCalls = 0;

  const deps: PrMonitorDeps = {
    db: getDb(),
    fetchPrState: async () => {
      fetchPrStateCalls++;
      if (opts.stateThrows) throw new Error('boom-state');
      return opts.state === undefined ? 'OPEN' : opts.state;
    },
    fetchComments: async (
      _repo: string,
      _n: number,
      source: 'issue' | 'review',
      etag: string | null,
    ): Promise<FetchCommentsResult> => {
      fetchCommentsCalls.push({ source, etag });
      if (opts.bothNotModified || opts.notModified?.[source]) {
        return { notModified: true };
      }
      const list = opts.comments?.[source];
      if (list === 'throw') throw new Error(`boom-${source}`);
      const comments = list ?? [];
      return { etag: `etag-${source}-${comments.length}`, comments };
    },
    wakeAgent: async (monitor, payload) => {
      if (opts.wakeThrows) throw new Error('boom-wake');
      wakes.push({ monitor, payload });
    },
    cleanupCodingTask: async (agentGroupId, reason) => {
      if (opts.cleanupThrows) throw new Error('boom-cleanup');
      cleanups.push({ agentGroupId, reason });
    },
    log: noopLog,
    now: opts.now ? () => opts.now! : undefined,
  };

  return { deps, wakes, cleanups, fetchPrStateCalls, fetchCommentsCalls };
}

function comment(
  id: number,
  login: string,
  body: string,
  source: 'issue' | 'review',
  updatedAt = '2026-01-01T00:00:00Z',
  path?: string,
): PrComment {
  return {
    id,
    user: { login },
    body,
    updated_at: updatedAt,
    path,
    html_url: `https://github.com/o/r/pull/1#${source}-${id}`,
    source,
  };
}

function getMonitor(id: string): MonitorRow {
  const row = getDb().prepare('SELECT * FROM coding_pr_monitors WHERE id = ?').get(id) as MonitorRow | undefined;
  if (!row) throw new Error(`monitor not found: ${id}`);
  return row;
}

function setupAgentGroup(id = 'ag-1') {
  createAgentGroup({
    id,
    name: id,
    folder: id,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
}

function registerActive(args: {
  id?: string;
  agentGroupId?: string;
  intervalMs?: number;
  /** If set, overrides next_run_at to past so it's due. */
  due?: boolean;
}): MonitorRow {
  const id = registerPrMonitor(getDb(), {
    agentGroupId: args.agentGroupId ?? 'ag-1',
    messagingGroupId: 'mg-1',
    threadId: 'thr-1',
    prNumber: 42,
    repo: 'o/r',
    intervalMs: args.intervalMs ?? 60_000,
  });
  if (args.due !== false) {
    // Force due regardless of timing.
    getDb().prepare('UPDATE coding_pr_monitors SET next_run_at = ? WHERE id = ?').run('2000-01-01T00:00:00Z', id);
  }
  return getMonitor(id);
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  setupAgentGroup();
});

afterEach(() => {
  closeDb();
});

describe('pollDuePrMonitors — selection', () => {
  it('skips inactive monitors', async () => {
    const monitor = registerActive({});
    deactivatePrMonitor(getDb(), monitor.id);

    const fx = makeFixture();
    await pollDuePrMonitors(fx.deps);

    expect(fx.fetchPrStateCalls).toBe(0);
    expect(fx.wakes).toHaveLength(0);
  });

  it('skips monitors whose next_run_at is in the future', async () => {
    const id = registerPrMonitor(getDb(), {
      agentGroupId: 'ag-1',
      messagingGroupId: 'mg-1',
      prNumber: 1,
      repo: 'o/r',
    });
    getDb().prepare('UPDATE coding_pr_monitors SET next_run_at = ? WHERE id = ?').run('2099-01-01T00:00:00Z', id);

    const fx = makeFixture();
    await pollDuePrMonitors(fx.deps);

    expect(fx.fetchPrStateCalls).toBe(0);
  });
});

describe('pollOneMonitor — terminal PR states', () => {
  it('MERGED → cleanup(merged), monitor completed, no wake', async () => {
    const monitor = registerActive({});
    const fx = makeFixture({ state: 'MERGED' });

    const woke = await pollOneMonitor(fx.deps, monitor);

    expect(woke).toBe(false);
    expect(fx.wakes).toHaveLength(0);
    expect(fx.cleanups).toEqual([{ agentGroupId: 'ag-1', reason: 'merged' }]);
    expect(getMonitor(monitor.id).status).toBe('completed');
    expect(getMonitor(monitor.id).last_state).toBe('MERGED');
  });

  it('CLOSED → cleanup(abandoned), monitor completed', async () => {
    const monitor = registerActive({});
    const fx = makeFixture({ state: 'CLOSED' });

    await pollOneMonitor(fx.deps, monitor);

    expect(fx.cleanups).toEqual([{ agentGroupId: 'ag-1', reason: 'abandoned' }]);
    expect(getMonitor(monitor.id).status).toBe('completed');
  });

  it('cleanupCodingTask throwing does not prevent the monitor from being marked completed', async () => {
    const monitor = registerActive({});
    const fx = makeFixture({ state: 'MERGED', cleanupThrows: true });

    await pollOneMonitor(fx.deps, monitor);
    expect(getMonitor(monitor.id).status).toBe('completed');
  });
});

describe('pollOneMonitor — etag fast path', () => {
  it('both 304 → next_run_at advanced, no wake, no seen writes', async () => {
    const monitor = registerActive({ intervalMs: 30_000 });
    const fx = makeFixture({ bothNotModified: true, now: new Date('2026-01-15T12:00:00Z') });

    const woke = await pollOneMonitor(fx.deps, monitor);
    expect(woke).toBe(false);
    expect(fx.wakes).toHaveLength(0);

    const seenCount = (
      getDb().prepare('SELECT COUNT(*) AS c FROM coding_pr_monitor_seen WHERE monitor_id = ?').get(monitor.id) as {
        c: number;
      }
    ).c;
    expect(seenCount).toBe(0);

    const after = getMonitor(monitor.id);
    expect(after.next_run_at).toBe(new Date('2026-01-15T12:00:30Z').toISOString());
  });
});

describe('pollOneMonitor — fresh comment classification', () => {
  it('first poll with no seen rows → all non-bot comments are NEW', async () => {
    const monitor = registerActive({});
    const fx = makeFixture({
      comments: {
        issue: [comment(1, 'alice', 'hi', 'issue')],
        review: [comment(2, 'bob', 'change this', 'review', '2026-01-01T00:00:00Z', 'src/foo.ts')],
      },
    });

    await pollOneMonitor(fx.deps, monitor);
    expect(fx.wakes).toHaveLength(1);
    const payload = fx.wakes[0].payload;
    expect(payload.comments.map((c) => ({ id: c.id, kind: c.kind, author: c.author }))).toEqual([
      { id: 1, kind: 'NEW', author: 'alice' },
      { id: 2, kind: 'NEW', author: 'bob' },
    ]);
    // Review comment should carry path
    expect(payload.comments.find((c) => c.id === 2)?.path).toBe('src/foo.ts');
  });

  it('second poll with same comments → no wake', async () => {
    const monitor = registerActive({});

    const fx1 = makeFixture({
      comments: {
        issue: [comment(1, 'alice', 'hi', 'issue')],
      },
    });
    await pollOneMonitor(fx1.deps, monitor);
    expect(fx1.wakes).toHaveLength(1);

    // Re-fetch to get freshest etag/state
    const monitor2 = getMonitor(monitor.id);
    const fx2 = makeFixture({
      comments: {
        issue: [comment(1, 'alice', 'hi', 'issue')], // unchanged
      },
    });
    await pollOneMonitor(fx2.deps, monitor2);
    expect(fx2.wakes).toHaveLength(0);
  });

  it('comment updated_at changed → reported as UPDATED', async () => {
    const monitor = registerActive({});
    const fx1 = makeFixture({
      comments: {
        issue: [comment(1, 'alice', 'first', 'issue', '2026-01-01T00:00:00Z')],
      },
    });
    await pollOneMonitor(fx1.deps, monitor);

    const monitor2 = getMonitor(monitor.id);
    const fx2 = makeFixture({
      comments: {
        issue: [comment(1, 'alice', 'edited', 'issue', '2026-01-02T00:00:00Z')],
      },
    });
    await pollOneMonitor(fx2.deps, monitor2);
    expect(fx2.wakes).toHaveLength(1);
    expect(fx2.wakes[0].payload.comments[0]).toMatchObject({ id: 1, kind: 'UPDATED' });
  });

  it('claude[bot] is included; linear[bot] / github-actions[bot] are excluded', async () => {
    const monitor = registerActive({});
    const fx = makeFixture({
      comments: {
        issue: [
          comment(10, 'claude[bot]', 'WIP', 'issue'),
          comment(11, 'linear[bot]', 'noise', 'issue'),
          comment(12, 'github-actions[bot]', 'CI ran', 'issue'),
          comment(13, 'human', 'looks ok', 'issue'),
        ],
      },
    });
    await pollOneMonitor(fx.deps, monitor);
    expect(fx.wakes).toHaveLength(1);
    const ids = fx.wakes[0].payload.comments.map((c) => c.id).sort();
    expect(ids).toEqual([10, 13]);

    // Bots should still be in seen so they don't re-trigger fetches.
    const seenIds = (
      getDb()
        .prepare('SELECT comment_id FROM coding_pr_monitor_seen WHERE monitor_id = ? ORDER BY comment_id')
        .all(monitor.id) as Array<{ comment_id: number }>
    ).map((r) => r.comment_id);
    expect(seenIds).toEqual([10, 11, 12, 13]);
  });

  it('fetch error on review but issue succeeds → wakes for issue, review etag unchanged', async () => {
    const monitor = registerActive({});
    const fx = makeFixture({
      comments: {
        issue: [comment(1, 'alice', 'hi', 'issue')],
        review: 'throw',
      },
    });
    await pollOneMonitor(fx.deps, monitor);

    expect(fx.wakes).toHaveLength(1);
    expect(fx.wakes[0].payload.comments).toHaveLength(1);
    expect(fx.wakes[0].payload.comments[0].source).toBe('issue');

    const after = getMonitor(monitor.id);
    expect(after.last_etag_issue).toBe('etag-issue-1');
    expect(after.last_etag_review).toBeNull();
  });

  it('wakeAgent throwing leaves monitor active for retry, seen rows still persisted', async () => {
    const monitor = registerActive({});
    const fx = makeFixture({
      comments: { issue: [comment(1, 'alice', 'hi', 'issue')] },
      wakeThrows: true,
    });
    const woke = await pollOneMonitor(fx.deps, monitor);
    expect(woke).toBe(false);

    // Seen row was upserted before wake; next attempt won't re-classify as NEW.
    const seenCount = (
      getDb().prepare('SELECT COUNT(*) AS c FROM coding_pr_monitor_seen WHERE monitor_id = ?').get(monitor.id) as {
        c: number;
      }
    ).c;
    expect(seenCount).toBe(1);
  });
});

describe('registerPrMonitor — idempotency', () => {
  it('returns the same id when called twice for the same (agent_group, repo, pr) active monitor', () => {
    const a = registerPrMonitor(getDb(), {
      agentGroupId: 'ag-1',
      messagingGroupId: 'mg-1',
      prNumber: 99,
      repo: 'o/r',
    });
    const b = registerPrMonitor(getDb(), {
      agentGroupId: 'ag-1',
      messagingGroupId: 'mg-1',
      prNumber: 99,
      repo: 'o/r',
    });
    expect(a).toBe(b);
    const count = (
      getDb()
        .prepare(
          "SELECT COUNT(*) AS c FROM coding_pr_monitors WHERE agent_group_id='ag-1' AND repo='o/r' AND pr_number=99",
        )
        .get() as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  it('inserts a new row if the prior monitor is completed', () => {
    const a = registerPrMonitor(getDb(), {
      agentGroupId: 'ag-1',
      messagingGroupId: 'mg-1',
      prNumber: 99,
      repo: 'o/r',
    });
    deactivatePrMonitor(getDb(), a);
    const b = registerPrMonitor(getDb(), {
      agentGroupId: 'ag-1',
      messagingGroupId: 'mg-1',
      prNumber: 99,
      repo: 'o/r',
    });
    expect(b).not.toBe(a);
  });
});

describe('pollDuePrMonitors — error isolation', () => {
  it('catches per-monitor errors so other monitors still run', async () => {
    setupAgentGroup('ag-2');
    // Use registerActive helper for the second monitor by overriding ag-id.
    const m1 = registerActive({});
    const m2id = registerPrMonitor(getDb(), {
      agentGroupId: 'ag-2',
      messagingGroupId: 'mg-2',
      prNumber: 7,
      repo: 'o/r2',
    });
    getDb().prepare('UPDATE coding_pr_monitors SET next_run_at = ? WHERE id = ?').run('2000-01-01T00:00:00Z', m2id);

    let calls = 0;
    const wakes: WakePayload[] = [];
    const deps: PrMonitorDeps = {
      db: getDb(),
      fetchPrState: async () => {
        calls++;
        if (calls === 1) throw new Error('first one is bad');
        return 'OPEN';
      },
      fetchComments: async () => ({ etag: 'e', comments: [comment(1, 'alice', 'hi', 'issue')] }),
      wakeAgent: async (_m, p) => {
        wakes.push(p);
      },
      cleanupCodingTask: async () => {},
      log: noopLog,
    };

    await pollDuePrMonitors(deps);
    // First call threw (first monitor), second monitor still progressed.
    expect(wakes).toHaveLength(1);
    expect(wakes[0].pr_number).toBe(7);
    // First monitor's next_run_at was advanced even though it failed.
    expect(getMonitor(m1.id).next_run_at).not.toBe('2000-01-01T00:00:00Z');
  });
});

describe('pollOneMonitor — state tracking', () => {
  it('updates last_state when state changes', async () => {
    const monitor = registerActive({});
    const fx = makeFixture({ state: 'OPEN' });
    await pollOneMonitor(fx.deps, monitor);
    expect(getMonitor(monitor.id).last_state).toBe('OPEN');
  });

  it('null state (transient error) does not update last_state and advances next_run_at', async () => {
    const monitor = registerActive({});
    const fx = makeFixture({ state: null, now: new Date('2026-01-15T12:00:00Z') });
    await pollOneMonitor(fx.deps, monitor);
    expect(getMonitor(monitor.id).last_state).toBeNull();
    expect(fx.wakes).toHaveLength(0);
    expect(getMonitor(monitor.id).next_run_at).toBe(new Date('2026-01-15T12:01:00Z').toISOString());
  });
});

// Silence vitest unused import warning for vi (kept for future spy tests).
vi;
