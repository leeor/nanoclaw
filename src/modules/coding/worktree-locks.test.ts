import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createSession } from '../../db/sessions.js';

import { acquireWorktreeLock, listWorktreeLocks, releaseWorktreeLock } from './worktree-locks.js';

function now() {
  return new Date().toISOString();
}

function makeAgentGroup(id = 'ag-1') {
  createAgentGroup({
    id,
    name: 'Coding',
    folder: 'coding',
    agent_provider: null,
    created_at: now(),
  });
}

function makeSession(id: string, agentGroupId = 'ag-1') {
  createSession({
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: null,
    created_at: now(),
  });
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('coding worktree locks', () => {
  it('acquires a fresh lock for a session', () => {
    makeAgentGroup();
    makeSession('sess-1');

    const lock = acquireWorktreeLock('/host/wt/feature-a', 'sess-1');
    expect(lock).not.toBeNull();
    expect(lock!.sessionId).toBe('sess-1');
    expect(lock!.worktreePath).toBe('/host/wt/feature-a');
    expect(lock!.acquiredAt).toBeTruthy();

    expect(listWorktreeLocks()).toHaveLength(1);
  });

  it('returns null when a different session already holds the lock', () => {
    makeAgentGroup();
    makeSession('sess-1');
    makeSession('sess-2');

    expect(acquireWorktreeLock('/host/wt/feature-a', 'sess-1')).not.toBeNull();
    expect(acquireWorktreeLock('/host/wt/feature-a', 'sess-2')).toBeNull();
  });

  it('re-acquire by the same session is a no-op success', () => {
    makeAgentGroup();
    makeSession('sess-1');

    const a = acquireWorktreeLock('/host/wt/feature-a', 'sess-1');
    const b = acquireWorktreeLock('/host/wt/feature-a', 'sess-1');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.acquiredAt).toBe(b!.acquiredAt);
    expect(listWorktreeLocks()).toHaveLength(1);
  });

  it('releaseWorktreeLock removes the row', () => {
    makeAgentGroup();
    makeSession('sess-1');

    acquireWorktreeLock('/host/wt/feature-a', 'sess-1');
    expect(listWorktreeLocks()).toHaveLength(1);

    releaseWorktreeLock('/host/wt/feature-a');
    expect(listWorktreeLocks()).toHaveLength(0);
  });

  it('releaseWorktreeLock is idempotent', () => {
    expect(() => releaseWorktreeLock('/host/wt/never-acquired')).not.toThrow();
  });

  it('cascade-deletes the lock when the session row is deleted', () => {
    makeAgentGroup();
    makeSession('sess-1');

    acquireWorktreeLock('/host/wt/feature-a', 'sess-1');

    // Need foreign_keys=ON, which initTestDb already enables.
    // Delete the session and confirm the lock vanishes.
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run('sess-1');

    expect(listWorktreeLocks()).toHaveLength(0);
  });

  it('different worktrees can be locked concurrently by different sessions', () => {
    makeAgentGroup();
    makeSession('sess-1');
    makeSession('sess-2');

    expect(acquireWorktreeLock('/host/wt/a', 'sess-1')).not.toBeNull();
    expect(acquireWorktreeLock('/host/wt/b', 'sess-2')).not.toBeNull();
    expect(listWorktreeLocks()).toHaveLength(2);
  });
});
