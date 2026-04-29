/**
 * DB-layer tests for `delete-coding-task`.
 *
 * The full `cleanupCodingTaskInternal` body has shell + filesystem + Slack
 * side effects that need integration coverage. Here we cover only the SQL
 * paths via the `__test` seam — specifically the messaging-group discovery
 * fallbacks that explain why DAT-82 / ANCR-988 / ANCR-869 ended up with
 * orphaned channels in the wild.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent, getMessagingGroup } from '../../db/messaging-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent } from '../../types.js';

import { __test } from './delete-coding-task.js';

const { discoverMessagingGroupIds, deleteDbRows } = __test;

function seedAgentGroup(args: { id: string; folder: string }): AgentGroup {
  const ag: AgentGroup = {
    id: args.id,
    name: args.folder,
    folder: args.folder,
    agent_provider: null,
    created_at: new Date().toISOString(),
  };
  createAgentGroup(ag);
  return ag;
}

function seedMessagingGroup(args: { id: string; name: string; platform_id: string }): MessagingGroup {
  const mg: MessagingGroup = {
    id: args.id,
    channel_type: 'slack',
    platform_id: args.platform_id,
    name: args.name,
    is_group: 1,
    unknown_sender_policy: 'request_approval',
    created_at: new Date().toISOString(),
  };
  createMessagingGroup(mg);
  return mg;
}

function seedWiring(args: { messagingGroupId: string; agentGroupId: string }): void {
  const mga: MessagingGroupAgent = {
    id: `mga-${args.agentGroupId}-${args.messagingGroupId}`,
    messaging_group_id: args.messagingGroupId,
    agent_group_id: args.agentGroupId,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'agent-shared',
    priority: 0,
    created_at: new Date().toISOString(),
  };
  createMessagingGroupAgent(mga);
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('discoverMessagingGroupIds', () => {
  it('returns wired messaging groups', () => {
    seedAgentGroup({ id: 'ag-1', folder: 'coding_foo-1' });
    seedMessagingGroup({ id: 'mg-w', name: 'coding-foo-1', platform_id: 'slack:C1' });
    seedWiring({ messagingGroupId: 'mg-w', agentGroupId: 'ag-1' });

    const ids = discoverMessagingGroupIds('ag-1', 'foo-1');
    expect(ids).toEqual(['mg-w']);
  });

  it('includes orphan slack messaging_group with matching coding-<ticket> name even when wiring is empty', () => {
    seedAgentGroup({ id: 'ag-2', folder: 'coding_foo-2' });
    // No wiring rows — simulates the partial-cleanup state from the wild.
    seedMessagingGroup({ id: 'mg-orphan', name: 'coding-foo-2', platform_id: 'slack:C-ORPHAN' });

    const ids = discoverMessagingGroupIds('ag-2', 'foo-2');
    expect(ids).toEqual(['mg-orphan']);
  });

  it('deduplicates when an orphan and a wired row both match', () => {
    seedAgentGroup({ id: 'ag-3', folder: 'coding_foo-3' });
    seedMessagingGroup({ id: 'mg-w', name: 'coding-foo-3', platform_id: 'slack:C1' });
    seedWiring({ messagingGroupId: 'mg-w', agentGroupId: 'ag-3' });
    // Second mg with same name (the ANCR-869 duplicate-channel case).
    seedMessagingGroup({ id: 'mg-w2', name: 'coding-foo-3', platform_id: 'slack:C2' });

    const ids = discoverMessagingGroupIds('ag-3', 'foo-3').sort();
    expect(ids).toEqual(['mg-w', 'mg-w2']);
  });

  it('does not match non-coding messaging groups by accident', () => {
    seedAgentGroup({ id: 'ag-4', folder: 'coding_foo-4' });
    seedMessagingGroup({ id: 'mg-other', name: 'general', platform_id: 'slack:C-OTHER' });

    const ids = discoverMessagingGroupIds('ag-4', 'foo-4');
    expect(ids).toEqual([]);
  });
});

describe('deleteDbRows', () => {
  it('archives + deletes orphan messaging_groups by name pattern when wiring is gone', () => {
    seedAgentGroup({ id: 'ag-1', folder: 'coding_dat-82' });
    seedMessagingGroup({ id: 'mg-orphan', name: 'coding-dat-82', platform_id: 'slack:C0B0KTXS3S8' });
    // No wiring row — exactly the DAT-82 / ANCR-988 in-the-wild state.

    const result = deleteDbRows('ag-1', 'dat-82');

    expect(result.archivedChannelIds).toEqual(['C0B0KTXS3S8']);
    expect(getMessagingGroup('mg-orphan')).toBeUndefined();
  });

  it('archives + deletes BOTH duplicate messaging_groups for a single coding task', () => {
    seedAgentGroup({ id: 'ag-869', folder: 'coding_ancr-869' });
    seedMessagingGroup({ id: 'mg-a', name: 'coding-ancr-869', platform_id: 'slack:C0B06NYKW9Z' });
    seedMessagingGroup({ id: 'mg-b', name: 'coding-ancr-869', platform_id: 'slack:C0B0ESGD87L' });
    seedWiring({ messagingGroupId: 'mg-a', agentGroupId: 'ag-869' });

    const result = deleteDbRows('ag-869', 'ancr-869');

    expect(result.archivedChannelIds.sort()).toEqual(['C0B06NYKW9Z', 'C0B0ESGD87L']);
    expect(getMessagingGroup('mg-a')).toBeUndefined();
    expect(getMessagingGroup('mg-b')).toBeUndefined();
  });

  it('preserves a non-coding messaging_group that another agent is wired to', () => {
    seedAgentGroup({ id: 'ag-coding', folder: 'coding_foo-9' });
    seedAgentGroup({ id: 'ag-other', folder: 'other_group' });
    seedMessagingGroup({ id: 'mg-shared', name: 'shared-channel', platform_id: 'slack:C-SHARED' });
    seedWiring({ messagingGroupId: 'mg-shared', agentGroupId: 'ag-coding' });
    seedWiring({ messagingGroupId: 'mg-shared', agentGroupId: 'ag-other' });

    const result = deleteDbRows('ag-coding', 'foo-9');

    expect(result.archivedChannelIds).toEqual([]);
    expect(getMessagingGroup('mg-shared')).toBeDefined();
  });
});
