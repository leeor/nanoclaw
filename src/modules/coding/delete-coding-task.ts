/**
 * `delete_coding_task` delivery-action handler.
 *
 * Tears down the per-task state created by `handleCreateCodingTask`:
 *   1. Stop the devcontainer (`devcontainer stop --workspace-folder ...`),
 *      with `docker stop` fallback by id-label.
 *   2. Archive the per-task Slack channel (best-effort).
 *   3. Delete the OneCLI agent matching the agent group's identifier.
 *   4. Drop DB rows: messaging_group_agents, messaging_groups (only the
 *      coding-task channel), agent_destinations, sessions, agent_groups.
 *   5. Remove the host worktree + branch (`git worktree remove --force`,
 *      `git branch -D`).
 *   6. Remove `groups/coding_<ticket-lower>` + `data/v2-sessions/<id>`.
 *   7. Notify the parent agent.
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
import { deleteAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
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

function deleteDbRows(agentGroupId: string): { archivedChannelIds: string[] } {
  const db = getDb();
  const archivedChannelIds: string[] = [];

  // Capture messaging group ids that this agent group is wired to BEFORE we
  // drop the wiring rows. We only delete a messaging_group if it was created
  // exclusively for this coding task — i.e. no other agent group wired to it.
  const wirings = db
    .prepare('SELECT messaging_group_id FROM messaging_group_agents WHERE agent_group_id = ?')
    .all(agentGroupId) as { messaging_group_id: string }[];
  const candidateMgIds = wirings.map((r) => r.messaging_group_id);

  db.prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?').run(agentGroupId);

  for (const mgId of candidateMgIds) {
    const remaining = db
      .prepare('SELECT COUNT(*) as c FROM messaging_group_agents WHERE messaging_group_id = ?')
      .get(mgId) as { c: number };
    if (remaining.c > 0) continue;
    const mg = db.prepare('SELECT platform_id FROM messaging_groups WHERE id = ?').get(mgId) as
      | { platform_id?: string }
      | undefined;
    if (mg?.platform_id?.startsWith('slack:')) archivedChannelIds.push(mg.platform_id.slice('slack:'.length));
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
    notifyAgent(session, `delete_coding_task: no coding agent for "${ticketId}" — nothing to clean up.`);
    return;
  }

  // 1. Pull workspaceFolder from the group's container.json BEFORE we wipe
  //    files so we can stop the devcontainer + remove the worktree.
  const cfg = readContainerConfig(folder) as unknown as {
    devcontainer?: { workspaceFolder?: string };
  };
  const workspaceFolder = cfg.devcontainer?.workspaceFolder ?? '';

  // 2. Stop devcontainer (best-effort).
  stopDevcontainer(workspaceFolder, group.id);

  // 3. Drop DB rows + collect Slack channel ids for archival.
  const { archivedChannelIds } = deleteDbRows(group.id);

  // 4. Archive Slack channels (best-effort).
  for (const channelId of archivedChannelIds) {
    await archiveSlackChannel(channelId);
  }

  // 5. Delete OneCLI agent.
  deleteOneCliAgent(group.id);

  // 6. Remove worktree + branch.
  removeWorktreeAndBranch(workspaceFolder, ticketLower);

  // 7. Remove on-disk artifacts.
  const groupDir = path.join(GROUPS_DIR, folder);
  if (fs.existsSync(groupDir)) fs.rmSync(groupDir, { recursive: true, force: true });
  const sessionRoot = path.join(DATA_DIR, 'v2-sessions', group.id);
  if (fs.existsSync(sessionRoot)) fs.rmSync(sessionRoot, { recursive: true, force: true });

  notifyAgent(
    session,
    `Coding task "${ticketId}" cleaned up.${archivedChannelIds.length ? ` Slack channel archived.` : ''}`,
  );
  log.info('Coding task deleted', {
    agentGroupId: group.id,
    ticketId,
    folder,
    workspaceFolder,
    archivedChannelIds,
  });
}
