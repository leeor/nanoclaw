/**
 * Coding-task cleanup — host-driven and agent-driven.
 *
 * Two entry points share the same teardown body:
 *
 *   - `handleDeleteCodingTask`  — `delete_coding_task` delivery action
 *     (parent agent or admin invokes via MCP). Notifies the parent on
 *     completion.
 *
 *   - `cleanupCodingTaskInternal` — host-side, no Session required. Used
 *     by the PR monitor when it observes terminal PR state (MERGED/CLOSED)
 *     and the agent never ran cleanup itself.
 *
 * Teardown body:
 *   1. Stop the devcontainer (`devcontainer stop --workspace-folder ...`),
 *      with `docker stop` fallback by id-label.
 *   2. Discover messaging_groups for this coding task. Two-pronged:
 *        a) any messaging_groups wired via `messaging_group_agents`, and
 *        b) any orphan slack `messaging_groups` whose name matches the
 *           per-task channel name pattern `coding-<ticket-lower>`. Catches
 *           rows whose wiring was previously deleted but never archived.
 *   3. Drop DB rows: messaging_group_agents, messaging_groups, agent_destinations,
 *      coding_worktree_locks, sessions, agent_groups.
 *   4. Archive Slack channels (best-effort).
 *   5. Delete the OneCLI agent matching the agent group's identifier.
 *   6. Remove the host worktree + branch (`git worktree remove --force`,
 *      `git branch -D`).
 *   7. Remove `groups/coding_<ticket-lower>` + `data/v2-sessions/<id>`.
 *
 * Each step is best-effort and logged on failure — partial state is
 * preferable to a stall.
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { WebClient } from '@slack/web-api';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { readContainerConfig } from '../../container-config.js';
import { getDb } from '../../db/connection.js';
import { deleteAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { wakeContainer } from '../../container-runner.js';
import { getSession } from '../../db/sessions.js';
import { writeSessionMessage } from '../../session-manager.js';

const DEVCONTAINER_BIN = process.env.DEVCONTAINER_BIN || 'devcontainer';
const ONECLI_BIN = process.env.ONECLI_BIN || 'onecli';

function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake parent after notification', { err }));
  }
}

function stopDevcontainer(workspaceFolder: string, agentGroupId: string): void {
  if (workspaceFolder && fs.existsSync(workspaceFolder)) {
    try {
      execSync(`${DEVCONTAINER_BIN} stop --workspace-folder ${JSON.stringify(workspaceFolder)}`, {
        stdio: 'pipe',
        timeout: 30_000,
      });
      return;
    } catch (err) {
      log.warn('devcontainer stop failed — falling back to docker stop by label', {
        agentGroupId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  try {
    const ids = execSync(`docker ps -q --filter label=nanoclaw.agent-group=${agentGroupId}`, { stdio: 'pipe' })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
    if (ids.length > 0) {
      execSync(`docker stop -t 5 ${ids.join(' ')}`, { stdio: 'pipe', timeout: 30_000 });
    }
  } catch (err) {
    log.warn('docker stop fallback failed', {
      agentGroupId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function archiveSlackChannel(channelId: string): Promise<void> {
  const env = readEnvFile(['SLACK_BOT_TOKEN']);
  if (!env.SLACK_BOT_TOKEN) {
    log.warn('SLACK_BOT_TOKEN not set — cannot archive coding-task channel', { channelId });
    return;
  }
  try {
    const client = new WebClient(env.SLACK_BOT_TOKEN);
    await client.conversations.archive({ channel: channelId });
  } catch (err) {
    const code = (err as { data?: { error?: string } })?.data?.error;
    if (code === 'already_archived') return;
    log.warn('Slack channel archive failed', { channelId, error: code ?? String(err) });
  }
}

function deleteOneCliAgent(agentGroupId: string): void {
  // The SDK doesn't expose list/delete agents; shell out to the CLI.
  try {
    const out = execSync(`${ONECLI_BIN} agents list`, { stdio: 'pipe' }).toString();
    const parsed = JSON.parse(out) as { data?: { id: string; identifier?: string }[] };
    const match = parsed.data?.find((a) => a.identifier === agentGroupId);
    if (!match) return;
    execSync(`${ONECLI_BIN} agents delete --id ${match.id}`, { stdio: 'pipe' });
  } catch (err) {
    log.warn('OneCLI agent delete failed', {
      agentGroupId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function removeWorktreeAndBranch(workspaceFolder: string, ticketLower: string): void {
  if (!workspaceFolder) return;
  // Find the master worktree: ../master sibling (matches create-coding-task layout).
  const masterDir = path.join(path.dirname(workspaceFolder), 'master');
  if (fs.existsSync(masterDir)) {
    try {
      execFileSync('git', ['-C', masterDir, 'worktree', 'remove', workspaceFolder, '--force'], {
        stdio: 'pipe',
      });
    } catch (err) {
      log.warn('git worktree remove failed', {
        workspaceFolder,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      execFileSync('git', ['-C', masterDir, 'branch', '-D', ticketLower], { stdio: 'pipe' });
    } catch (err) {
      log.warn('git branch -D failed', {
        branch: ticketLower,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (fs.existsSync(workspaceFolder)) {
    fs.rmSync(workspaceFolder, { recursive: true, force: true });
  }
}

/**
 * Discover all messaging_groups associated with this coding task.
 *
 * Two-pronged so neither leg breaks alone: missing wiring rows (auto-merge
 * cleanup ran a partial path before) still get cleaned up by the name-pattern
 * scan, and a manually-renamed channel still gets cleaned up by the wiring
 * scan. Slack channel names are globally unique, so the name pattern only
 * matches our task's channels.
 */
function discoverMessagingGroupIds(agentGroupId: string, ticketLower: string): string[] {
  const db = getDb();
  const ids = new Set<string>();

  const wired = db
    .prepare('SELECT messaging_group_id FROM messaging_group_agents WHERE agent_group_id = ?')
    .all(agentGroupId) as { messaging_group_id: string }[];
  for (const row of wired) ids.add(row.messaging_group_id);

  const orphanByName = db
    .prepare("SELECT id FROM messaging_groups WHERE channel_type = 'slack' AND name = ?")
    .all(`coding-${ticketLower}`) as { id: string }[];
  for (const row of orphanByName) ids.add(row.id);

  return [...ids];
}

function deleteDbRows(agentGroupId: string, ticketLower: string): { archivedChannelIds: string[] } {
  const db = getDb();
  const archivedChannelIds: string[] = [];

  // Capture messaging group ids that this agent group is wired to BEFORE we
  // drop the wiring rows. We delete a messaging_group only if (a) its name
  // matches our coding-<ticket> pattern, OR (b) it has no other agent wired
  // to it after we remove our wiring.
  const candidateMgIds = discoverMessagingGroupIds(agentGroupId, ticketLower);

  db.prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?').run(agentGroupId);

  for (const mgId of candidateMgIds) {
    const mg = db.prepare('SELECT name, platform_id FROM messaging_groups WHERE id = ?').get(mgId) as
      | { name?: string; platform_id?: string }
      | undefined;
    if (!mg) continue;

    const isCodingChannel = mg.name === `coding-${ticketLower}`;
    if (!isCodingChannel) {
      // Wired-only path: safe-delete only when no other agent is on it.
      const remaining = db
        .prepare('SELECT COUNT(*) as c FROM messaging_group_agents WHERE messaging_group_id = ?')
        .get(mgId) as { c: number };
      if (remaining.c > 0) continue;
    }

    if (mg.platform_id?.startsWith('slack:')) {
      archivedChannelIds.push(mg.platform_id.slice('slack:'.length));
    }
    db.prepare('DELETE FROM messaging_groups WHERE id = ?').run(mgId);
  }

  // agent_destinations: drop both directions.
  if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_destinations'").get()) {
    db.prepare('DELETE FROM agent_destinations WHERE agent_group_id = ? OR target_id = ?').run(
      agentGroupId,
      agentGroupId,
    );
  }
  // Worktree-lock rows for this group.
  if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='coding_worktree_locks'").get()) {
    db.prepare(
      'DELETE FROM coding_worktree_locks WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
    ).run(agentGroupId);
  }
  db.prepare('DELETE FROM sessions WHERE agent_group_id = ?').run(agentGroupId);
  deleteAgentGroup(agentGroupId);

  return { archivedChannelIds };
}

export interface CleanupCodingTaskArgs {
  agentGroupId: string;
  ticketId: string;
  reason?: 'merged' | 'abandoned' | 'manual';
}

export interface CleanupCodingTaskResult {
  ok: boolean;
  /** When agent group was already gone — no work was needed. */
  alreadyGone?: boolean;
  archivedChannelIds: string[];
}

/**
 * Host-driven cleanup. Idempotent — calling on an already-deleted agent
 * group returns `{ ok: true, alreadyGone: true }`.
 */
export async function cleanupCodingTaskInternal(args: CleanupCodingTaskArgs): Promise<CleanupCodingTaskResult> {
  const ticketLower = args.ticketId.toLowerCase();
  const folder = `coding_${ticketLower}`;
  const group = getAgentGroup(args.agentGroupId) ?? getAgentGroupByFolder(folder);
  if (!group) {
    log.info('cleanupCodingTaskInternal: agent group already gone — checking for orphan messaging_groups', {
      agentGroupId: args.agentGroupId,
      ticketId: args.ticketId,
    });
    // Even with no agent_group, orphan messaging_groups may exist (the
    // partial-cleanup state DAT-82 / ANCR-988 fell into). Sweep them.
    const orphanIds = getDb()
      .prepare("SELECT id, platform_id FROM messaging_groups WHERE channel_type = 'slack' AND name = ?")
      .all(`coding-${ticketLower}`) as { id: string; platform_id: string }[];
    const archivedChannelIds: string[] = [];
    for (const row of orphanIds) {
      if (row.platform_id?.startsWith('slack:')) archivedChannelIds.push(row.platform_id.slice('slack:'.length));
      getDb().prepare('DELETE FROM messaging_groups WHERE id = ?').run(row.id);
    }
    for (const channelId of archivedChannelIds) await archiveSlackChannel(channelId);
    return { ok: true, alreadyGone: true, archivedChannelIds };
  }

  const cfg = readContainerConfig(group.folder) as unknown as {
    devcontainer?: { workspaceFolder?: string };
  };
  const workspaceFolder = cfg.devcontainer?.workspaceFolder ?? '';

  stopDevcontainer(workspaceFolder, group.id);

  const { archivedChannelIds } = deleteDbRows(group.id, ticketLower);

  for (const channelId of archivedChannelIds) await archiveSlackChannel(channelId);

  deleteOneCliAgent(group.id);

  removeWorktreeAndBranch(workspaceFolder, ticketLower);

  const groupDir = path.join(GROUPS_DIR, group.folder);
  if (fs.existsSync(groupDir)) fs.rmSync(groupDir, { recursive: true, force: true });
  const sessionRoot = path.join(DATA_DIR, 'v2-sessions', group.id);
  if (fs.existsSync(sessionRoot)) fs.rmSync(sessionRoot, { recursive: true, force: true });

  log.info('Coding task cleaned up', {
    agentGroupId: group.id,
    ticketId: args.ticketId,
    folder: group.folder,
    workspaceFolder,
    archivedChannelIds,
    reason: args.reason ?? 'manual',
  });
  return { ok: true, archivedChannelIds };
}

/** Test-only seam — exposed for DB-layer assertions. */
export const __test = {
  discoverMessagingGroupIds,
  deleteDbRows,
};

export async function handleDeleteCodingTask(content: Record<string, unknown>, session: Session): Promise<void> {
  const ticketId = (content.ticket_id as string)?.trim();
  if (!ticketId) {
    notifyAgent(session, 'delete_coding_task failed: ticket_id is required.');
    return;
  }

  const ticketLower = ticketId.toLowerCase();
  const folder = `coding_${ticketLower}`;
  const group = getAgentGroupByFolder(folder);
  if (!group) {
    // Still try to sweep orphan messaging_groups (no-op if none).
    await cleanupCodingTaskInternal({ agentGroupId: '', ticketId, reason: 'manual' });
    notifyAgent(session, `delete_coding_task: no coding agent for "${ticketId}" — nothing to clean up.`);
    return;
  }

  const result = await cleanupCodingTaskInternal({
    agentGroupId: group.id,
    ticketId,
    reason: 'manual',
  });

  notifyAgent(
    session,
    `Coding task "${ticketId}" cleaned up.${
      result.archivedChannelIds.length
        ? ` Slack channel${result.archivedChannelIds.length === 1 ? '' : 's'} archived.`
        : ''
    }`,
  );
}
