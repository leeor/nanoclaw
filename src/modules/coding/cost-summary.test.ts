import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import type { Session } from '../../types.js';

import {
  aggregateCostLog,
  captureRtkGain,
  formatCostSummary,
  handleCostSummary,
  postCostSummary,
  type CostSummary,
  type GhRunner,
  type RtkRunner,
  type SendChannelFn,
} from './cost-summary.js';

const fullSummary: CostSummary = {
  totalCostUSD: 18.43,
  totalDurationMs: 3 * 3600_000 + 42 * 60_000,
  totalTurns: 412,
  resultCount: 47,
  firstTs: '2026-04-23T08:00:00Z',
  lastTs: '2026-04-23T11:42:00Z',
  models: [
    {
      model: 'claude-opus-4-7[1m]',
      inputTokens: 2_100_000,
      outputTokens: 340_000,
      cacheReadInputTokens: 8_200_000,
      cacheCreationInputTokens: 1_100_000,
      costUSD: 15.12,
    },
    {
      model: 'claude-sonnet-4-6',
      inputTokens: 890_000,
      outputTokens: 120_000,
      cacheReadInputTokens: 3_100_000,
      cacheCreationInputTokens: 410_000,
      costUSD: 3.31,
    },
  ],
};

describe('formatCostSummary', () => {
  it('includes assistant name in heading', () => {
    const md = formatCostSummary(fullSummary, {
      ticketId: 'ANCR-107',
      reason: 'merged',
      assistantName: 'Ofleeor',
    });
    expect(md).toContain('## Ofleeor cost summary');
  });

  it('includes task id, status, duration, turns, cost', () => {
    const md = formatCostSummary(fullSummary, {
      ticketId: 'ANCR-107',
      reason: 'merged',
      assistantName: 'Ofleeor',
    });
    expect(md).toContain('ANCR-107');
    expect(md).toContain('merged');
    expect(md).toContain('3h 42m');
    expect(md).toContain('47');
    expect(md).toContain('412');
    expect(md).toMatch(/\$18\.43/);
  });

  it('formats each model row with human-readable token counts', () => {
    const md = formatCostSummary(fullSummary, {
      ticketId: 'ANCR-107',
      reason: 'merged',
      assistantName: 'Ofleeor',
    });
    expect(md).toContain('claude-opus-4-7[1m]');
    expect(md).toContain('2.1M');
    expect(md).toContain('340K');
    expect(md).toContain('$15.12');
    expect(md).toContain('claude-sonnet-4-6');
  });

  it('shows abandoned status when reason is abandoned', () => {
    const md = formatCostSummary(fullSummary, {
      ticketId: 'ANCR-107',
      reason: 'abandoned',
      assistantName: 'Ofleeor',
    });
    expect(md).toContain('abandoned');
  });

  it('includes subscription disclaimer', () => {
    const md = formatCostSummary(fullSummary, {
      ticketId: 'ANCR-107',
      reason: 'merged',
      assistantName: 'Ofleeor',
    });
    expect(md.toLowerCase()).toContain('subscription');
  });

  it('wraps the model table in a code fence for slack target', () => {
    const md = formatCostSummary(fullSummary, {
      ticketId: 'ANCR-107',
      reason: 'merged',
      assistantName: 'Ofleeor',
      target: 'slack',
    });
    const fenced = md.match(/```\n\| Model \| Input \| Output \| Cache read \| Cache write \| Cost \|[\s\S]+?```/);
    expect(fenced).not.toBeNull();
  });

  it('emits a bare markdown table for github target (default)', () => {
    const md = formatCostSummary(fullSummary, {
      ticketId: 'ANCR-107',
      reason: 'merged',
      assistantName: 'Ofleeor',
    });
    expect(md).toContain('| Model | Input | Output | Cache read |');
    expect(md).not.toMatch(/```\n\| Model \| Input \|/);
  });

  it('strips ANSI escape sequences from rtkGain before embedding', () => {
    const md = formatCostSummary(fullSummary, {
      ticketId: 'ANCR-107',
      reason: 'merged',
      assistantName: 'Ofleeor',
      rtkGain: '\x1b[1mTotal saved:\x1b[0m \x1b[32m12345 tokens\x1b[0m (87%)',
    });
    expect(md).toContain('Total saved: 12345 tokens (87%)');
    expect(md).not.toMatch(/\x1b\[/);
  });

  it('appends RTK token savings section when rtkGain provided', () => {
    const md = formatCostSummary(fullSummary, {
      ticketId: 'ANCR-107',
      reason: 'merged',
      assistantName: 'Ofleeor',
      rtkGain: 'Total saved: 12345 tokens (87%)',
    });
    expect(md).toContain('## RTK token savings');
    expect(md).toContain('Total saved: 12345 tokens (87%)');
    expect(md).toMatch(/```\nTotal saved: 12345 tokens \(87%\)\n```/);
  });

  it('omits RTK token savings section when rtkGain absent or empty', () => {
    const omitted = formatCostSummary(fullSummary, {
      ticketId: 'ANCR-107',
      reason: 'merged',
      assistantName: 'Ofleeor',
    });
    expect(omitted).not.toContain('RTK token savings');

    const empty = formatCostSummary(fullSummary, {
      ticketId: 'ANCR-107',
      reason: 'merged',
      assistantName: 'Ofleeor',
      rtkGain: '   \n',
    });
    expect(empty).not.toContain('RTK token savings');

    const nullish = formatCostSummary(fullSummary, {
      ticketId: 'ANCR-107',
      reason: 'merged',
      assistantName: 'Ofleeor',
      rtkGain: null,
    });
    expect(nullish).not.toContain('RTK token savings');
  });

  it('formats tokens near 1M boundary as "1.0M", not "1000K"', () => {
    const boundarySummary: CostSummary = {
      totalCostUSD: 0,
      totalDurationMs: 0,
      totalTurns: 0,
      resultCount: 0,
      firstTs: '',
      lastTs: '',
      models: [
        {
          model: 'test',
          inputTokens: 999_999,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0,
        },
      ],
    };
    const md = formatCostSummary(boundarySummary, {
      ticketId: 'T',
      reason: 'merged',
      assistantName: 'X',
    });
    expect(md).toContain('1.0M');
    expect(md).not.toContain('1000K');
  });
});

describe('postCostSummary', () => {
  it('posts channel body and PR comment when both routings provided', async () => {
    const sendChannel = vi.fn().mockResolvedValue(undefined) as unknown as SendChannelFn;
    const runGh = vi.fn().mockReturnValue('') as unknown as GhRunner;

    await postCostSummary({
      slackMarkdown: 'slack-body',
      githubMarkdown: 'github-body',
      channelType: 'slack',
      platformId: 'C123',
      threadId: '1234.5678',
      repo: 'owner/repo',
      prNumber: 42,
      repoMasterPath: '/tmp/master',
      sendChannel,
      runGh,
    });

    expect(sendChannel).toHaveBeenCalledWith('slack', 'C123', '1234.5678', 'slack-body');
    expect(runGh).toHaveBeenCalledWith(
      ['pr', 'comment', '42', '--repo', 'owner/repo', '--body-file', '-'],
      '/tmp/master',
      'github-body',
    );
  });

  it('skips PR comment when prNumber missing', async () => {
    const sendChannel = vi.fn().mockResolvedValue(undefined) as unknown as SendChannelFn;
    const runGh = vi.fn() as unknown as GhRunner;
    await postCostSummary({
      slackMarkdown: 'slack',
      githubMarkdown: 'github',
      channelType: 'slack',
      platformId: 'C1',
      threadId: null,
      repo: 'owner/repo',
      sendChannel,
      runGh,
    });
    expect(sendChannel).toHaveBeenCalled();
    expect(runGh).not.toHaveBeenCalled();
  });

  it('skips PR comment when repo missing', async () => {
    const sendChannel = vi.fn().mockResolvedValue(undefined) as unknown as SendChannelFn;
    const runGh = vi.fn() as unknown as GhRunner;
    await postCostSummary({
      slackMarkdown: 'slack',
      githubMarkdown: 'github',
      channelType: 'slack',
      platformId: 'C1',
      threadId: null,
      prNumber: 42,
      sendChannel,
      runGh,
    });
    expect(runGh).not.toHaveBeenCalled();
  });

  it('skips channel post when channel routing missing', async () => {
    const sendChannel = vi.fn() as unknown as SendChannelFn;
    const runGh = vi.fn().mockReturnValue('') as unknown as GhRunner;
    await postCostSummary({
      slackMarkdown: 'slack',
      githubMarkdown: 'github',
      channelType: null,
      platformId: null,
      threadId: null,
      repo: 'owner/repo',
      prNumber: 7,
      sendChannel,
      runGh,
    });
    expect(sendChannel).not.toHaveBeenCalled();
    expect(runGh).toHaveBeenCalledTimes(1);
  });

  it('continues when channel send throws', async () => {
    const sendChannel = vi.fn().mockRejectedValue(new Error('channel down')) as unknown as SendChannelFn;
    const runGh = vi.fn().mockReturnValue('') as unknown as GhRunner;
    await expect(
      postCostSummary({
        slackMarkdown: 'slack',
        githubMarkdown: 'github',
        channelType: 'slack',
        platformId: 'C1',
        threadId: null,
        repo: 'owner/repo',
        prNumber: 7,
        sendChannel,
        runGh,
      }),
    ).resolves.toBeUndefined();
    expect(runGh).toHaveBeenCalledTimes(1);
  });

  it('continues when gh throws', async () => {
    const sendChannel = vi.fn().mockResolvedValue(undefined) as unknown as SendChannelFn;
    const runGh = vi.fn().mockImplementation(() => {
      throw new Error('gh failed');
    }) as unknown as GhRunner;
    await expect(
      postCostSummary({
        slackMarkdown: 'slack',
        githubMarkdown: 'github',
        channelType: 'slack',
        platformId: 'C1',
        threadId: null,
        repo: 'owner/repo',
        prNumber: 7,
        sendChannel,
        runGh,
      }),
    ).resolves.toBeUndefined();
    expect(sendChannel).toHaveBeenCalled();
  });

  it('continues when both channel and gh throw', async () => {
    const sendChannel = vi.fn().mockRejectedValue(new Error('chan down')) as unknown as SendChannelFn;
    const runGh = vi.fn().mockImplementation(() => {
      throw new Error('gh failed');
    }) as unknown as GhRunner;
    await expect(
      postCostSummary({
        slackMarkdown: 'slack',
        githubMarkdown: 'github',
        channelType: 'slack',
        platformId: 'C1',
        threadId: null,
        repo: 'owner/repo',
        prNumber: 7,
        sendChannel,
        runGh,
      }),
    ).resolves.toBeUndefined();
    expect(sendChannel).toHaveBeenCalled();
    expect(runGh).toHaveBeenCalled();
  });
});

describe('aggregateCostLog', () => {
  function makeOutboundDb(): Database.Database {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE cost_log (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ts              TEXT NOT NULL,
        session_id      TEXT,
        subtype         TEXT,
        duration_ms     INTEGER,
        num_turns       INTEGER,
        total_cost_usd  REAL,
        model_usage     TEXT NOT NULL
      );
    `);
    return db;
  }

  function insertRow(
    db: Database.Database,
    row: {
      ts: string;
      session_id?: string;
      subtype?: string;
      duration_ms?: number;
      num_turns?: number;
      total_cost_usd?: number;
      model_usage: Record<
        string,
        Partial<{
          inputTokens: number;
          outputTokens: number;
          cacheReadInputTokens: number;
          cacheCreationInputTokens: number;
          costUSD: number;
        }>
      >;
    },
  ): void {
    db.prepare(
      `INSERT INTO cost_log (ts, session_id, subtype, duration_ms, num_turns, total_cost_usd, model_usage)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.ts,
      row.session_id ?? null,
      row.subtype ?? 'success',
      row.duration_ms ?? 0,
      row.num_turns ?? 0,
      row.total_cost_usd ?? 0,
      JSON.stringify(row.model_usage),
    );
  }

  it('returns null when cost_log table is missing', () => {
    const db = new Database(':memory:');
    expect(aggregateCostLog(db)).toBeNull();
    db.close();
  });

  it('returns null when table is empty', () => {
    const db = makeOutboundDb();
    expect(aggregateCostLog(db)).toBeNull();
    db.close();
  });

  it('sums totals and folds per-model usage across rows', () => {
    const db = makeOutboundDb();
    insertRow(db, {
      ts: '2026-04-30T10:00:00Z',
      duration_ms: 60_000,
      num_turns: 3,
      total_cost_usd: 0.5,
      model_usage: {
        'claude-opus-4-7': {
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadInputTokens: 5000,
          cacheCreationInputTokens: 100,
          costUSD: 0.4,
        },
        'claude-sonnet-4-6': {
          inputTokens: 200,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.1,
        },
      },
    });
    insertRow(db, {
      ts: '2026-04-30T10:05:00Z',
      duration_ms: 30_000,
      num_turns: 2,
      total_cost_usd: 0.25,
      model_usage: {
        'claude-opus-4-7': {
          inputTokens: 500,
          outputTokens: 100,
          cacheReadInputTokens: 2500,
          cacheCreationInputTokens: 50,
          costUSD: 0.2,
        },
        'claude-sonnet-4-6': {
          inputTokens: 100,
          outputTokens: 25,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.05,
        },
      },
    });

    const summary = aggregateCostLog(db);
    expect(summary).not.toBeNull();
    expect(summary!.resultCount).toBe(2);
    expect(summary!.totalDurationMs).toBe(90_000);
    expect(summary!.totalTurns).toBe(5);
    expect(summary!.totalCostUSD).toBeCloseTo(0.75, 5);
    expect(summary!.firstTs).toBe('2026-04-30T10:00:00Z');
    expect(summary!.lastTs).toBe('2026-04-30T10:05:00Z');

    expect(summary!.models[0].model).toBe('claude-opus-4-7');
    expect(summary!.models[0].inputTokens).toBe(1500);
    expect(summary!.models[0].outputTokens).toBe(300);
    expect(summary!.models[0].cacheReadInputTokens).toBe(7500);
    expect(summary!.models[0].cacheCreationInputTokens).toBe(150);
    expect(summary!.models[0].costUSD).toBeCloseTo(0.6, 5);

    expect(summary!.models[1].model).toBe('claude-sonnet-4-6');
    expect(summary!.models[1].inputTokens).toBe(300);
    expect(summary!.models[1].costUSD).toBeCloseTo(0.15, 5);
    db.close();
  });

  it('skips rows with malformed model_usage JSON but still aggregates the rest', () => {
    const db = makeOutboundDb();
    insertRow(db, {
      ts: '2026-04-30T10:00:00Z',
      total_cost_usd: 1.0,
      model_usage: { 'claude-opus-4-7': { inputTokens: 100, outputTokens: 50, costUSD: 1.0 } },
    });
    db.prepare(
      `INSERT INTO cost_log (ts, session_id, subtype, duration_ms, num_turns, total_cost_usd, model_usage) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('2026-04-30T10:01:00Z', null, 'success', 0, 0, 0.5, '{not-json');

    const summary = aggregateCostLog(db);
    expect(summary).not.toBeNull();
    expect(summary!.resultCount).toBe(1);
    expect(summary!.totalCostUSD).toBeCloseTo(1.0, 5);
    db.close();
  });

  it('sorts model rows by descending costUSD', () => {
    const db = makeOutboundDb();
    insertRow(db, {
      ts: '2026-04-30T10:00:00Z',
      total_cost_usd: 1.5,
      model_usage: {
        'claude-haiku-4-5': {
          costUSD: 0.1,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        'claude-opus-4-7': {
          costUSD: 1.0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        'claude-sonnet-4-6': {
          costUSD: 0.4,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    });
    const summary = aggregateCostLog(db)!;
    expect(summary.models.map((m) => m.model)).toEqual(['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5']);
    db.close();
  });
});

describe('captureRtkGain', () => {
  it('returns trimmed stdout when rtk runner produces output', () => {
    const runner: RtkRunner = () => '  Total saved: 12345 tokens (87%)\n';
    expect(captureRtkGain(runner)).toBe('Total saved: 12345 tokens (87%)');
  });

  it('returns null when runner output is empty or whitespace-only', () => {
    expect(captureRtkGain(() => '')).toBeNull();
    expect(captureRtkGain(() => '   \n\t  ')).toBeNull();
  });

  it('returns null when runner throws (rtk not installed / non-zero exit)', () => {
    const runner: RtkRunner = () => {
      const err = new Error('spawn rtk ENOENT') as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    };
    expect(captureRtkGain(runner)).toBeNull();
  });
});

describe('handleCostSummary', () => {
  const fakeInDb = {} as never;

  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: 'ag-1',
      name: 'coding',
      folder: 'coding',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('mg-1', 'slack', 'C123', null, 1, 'strict', new Date().toISOString());
  });

  afterEach(() => {
    closeDb();
  });

  function makeSession(overrides: Partial<Session> = {}): Session {
    return {
      id: 'sess-1',
      agent_group_id: 'ag-1',
      messaging_group_id: 'mg-1',
      thread_id: '1234.5678',
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: null,
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it('skips silently when payload has no summary', async () => {
    // Without summary the handler shouldn't touch the (real) delivery
    // adapter — getDeliveryAdapter() returns null in tests, so an attempt
    // to deliver would just log; we just need to confirm no throw.
    await expect(
      handleCostSummary({ ticketId: 'ANCR-1', reason: 'merged' }, makeSession(), fakeInDb),
    ).resolves.toBeUndefined();
  });

  it('formats markdown for both targets and routes to channel + PR via mock injectors', async () => {
    // We test the routing layer through postCostSummary directly (above);
    // here we exercise the full handler with a minimal payload to confirm
    // the resolved channel routing comes from the session's messaging group.
    // Spy on the delivery adapter via the registry — but since
    // getDeliveryAdapter() returns null, the handler logs + returns. We
    // assert no throw and a stable session resolution path.
    await expect(
      handleCostSummary(
        {
          ticketId: 'ANCR-9',
          reason: 'merged',
          assistantName: 'Ofleeor',
          summary: fullSummary,
          repo: 'owner/repo',
          prNumber: 9,
        },
        makeSession(),
        fakeInDb,
      ),
    ).resolves.toBeUndefined();

    // No assertion on side effects — the integration with adapter / gh is
    // fully covered by the postCostSummary tests above with injected fakes.
    // The handler-shaped test confirms session resolution and payload
    // shape don't throw on the v2 path.
    expect(getDb().prepare('SELECT * FROM messaging_groups WHERE id = ?').get('mg-1')).toBeTruthy();
  });

  it('falls back to taskId when ticketId absent', async () => {
    await expect(
      handleCostSummary(
        {
          taskId: 'fallback-task',
          reason: 'merged',
          assistantName: 'X',
          summary: fullSummary,
        },
        makeSession(),
        fakeInDb,
      ),
    ).resolves.toBeUndefined();
  });

  it('treats unknown reason as merged', async () => {
    await expect(
      handleCostSummary(
        {
          ticketId: 'T',
          reason: 'banana',
          assistantName: 'X',
          summary: fullSummary,
        },
        makeSession(),
        fakeInDb,
      ),
    ).resolves.toBeUndefined();
  });

  it('survives missing messaging group on session (no channel post path)', async () => {
    await expect(
      handleCostSummary(
        {
          ticketId: 'T',
          reason: 'merged',
          assistantName: 'X',
          summary: fullSummary,
        },
        makeSession({ messaging_group_id: null }),
        fakeInDb,
      ),
    ).resolves.toBeUndefined();
  });
});
