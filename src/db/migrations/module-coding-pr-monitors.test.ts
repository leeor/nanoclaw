import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../connection.js';
import { runMigrations } from './index.js';
import { createAgentGroup } from '../agent-groups.js';

function now() {
  return new Date().toISOString();
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('coding-pr-monitors migration', () => {
  it('creates coding_pr_monitors with all expected columns', () => {
    const cols = (getDb().prepare("PRAGMA table_info('coding_pr_monitors')").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'agent_group_id',
        'messaging_group_id',
        'thread_id',
        'pr_number',
        'repo',
        'interval_ms',
        'next_run_at',
        'last_state',
        'last_etag_issue',
        'last_etag_review',
        'status',
        'created_at',
      ]),
    );
  });

  it('creates coding_pr_monitor_seen with composite PK', () => {
    const cols = (getDb()
      .prepare("PRAGMA table_info('coding_pr_monitor_seen')")
      .all() as Array<{ name: string; pk: number }>);
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);
    expect(pkCols.sort()).toEqual(['comment_id', 'monitor_id']);
  });

  it('has a FK from coding_pr_monitors → agent_groups with ON DELETE CASCADE', () => {
    const fks = getDb().prepare("PRAGMA foreign_key_list('coding_pr_monitors')").all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    const fk = fks.find((f) => f.table === 'agent_groups');
    expect(fk).toBeDefined();
    expect(fk!.from).toBe('agent_group_id');
    expect(fk!.to).toBe('id');
    expect(fk!.on_delete).toBe('CASCADE');
  });

  it('has a FK from coding_pr_monitor_seen → coding_pr_monitors with ON DELETE CASCADE', () => {
    const fks = getDb().prepare("PRAGMA foreign_key_list('coding_pr_monitor_seen')").all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    const fk = fks.find((f) => f.table === 'coding_pr_monitors');
    expect(fk).toBeDefined();
    expect(fk!.from).toBe('monitor_id');
    expect(fk!.on_delete).toBe('CASCADE');
  });

  it('creates idx_coding_pr_monitors_due index', () => {
    const idx = getDb()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='coding_pr_monitors' AND name='idx_coding_pr_monitors_due'",
      )
      .get() as { name: string } | undefined;
    expect(idx).toBeDefined();
  });

  it('cascades seen rows when monitor is deleted', () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'coding',
      folder: 'coding',
      agent_provider: null,
      created_at: now(),
    });
    const db = getDb();
    db.prepare(
      `INSERT INTO coding_pr_monitors (id, agent_group_id, messaging_group_id, thread_id, pr_number, repo, interval_ms, next_run_at, status, created_at)
       VALUES (?, 'ag-1', 'mg-1', NULL, 42, 'o/r', 60000, ?, 'active', ?)`,
    ).run('m1', now(), now());
    db.prepare(
      `INSERT INTO coding_pr_monitor_seen (monitor_id, comment_id, updated_at) VALUES ('m1', 100, ?)`,
    ).run(now());
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM coding_pr_monitor_seen').get() as { c: number }).c,
    ).toBe(1);
    db.prepare('DELETE FROM coding_pr_monitors WHERE id = ?').run('m1');
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM coding_pr_monitor_seen').get() as { c: number }).c,
    ).toBe(0);
  });

  it('cascades monitor + seen rows when agent group is deleted', () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'coding',
      folder: 'coding',
      agent_provider: null,
      created_at: now(),
    });
    const db = getDb();
    db.prepare(
      `INSERT INTO coding_pr_monitors (id, agent_group_id, messaging_group_id, thread_id, pr_number, repo, interval_ms, next_run_at, status, created_at)
       VALUES (?, 'ag-1', 'mg-1', NULL, 42, 'o/r', 60000, ?, 'active', ?)`,
    ).run('m1', now(), now());
    db.prepare(
      `INSERT INTO coding_pr_monitor_seen (monitor_id, comment_id, updated_at) VALUES ('m1', 100, ?)`,
    ).run(now());
    db.prepare('DELETE FROM agent_groups WHERE id = ?').run('ag-1');
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM coding_pr_monitors').get() as { c: number }).c,
    ).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM coding_pr_monitor_seen').get() as { c: number }).c,
    ).toBe(0);
  });
});
