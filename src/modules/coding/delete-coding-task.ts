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
import {
  aggregateCostLogFromPath,
  captureRtkGain,
  containerRtkRunner,
  formatCostSummary,
  postCostSummary,
  type CostSummary,
} from './cost-summary.js';

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

function stopDevcontainer(_workspaceFolder: string, agentGroupId: string): void {
  // The `@devcontainers/cli` package has no `stop` subcommand (verified up to
  // 0.86.0 — supports up / set-up / build / run-user-commands /
  // read-configuration / outdated / upgrade / features / templates / exec).
  // Calling `devcontainer stop` always errors with "Unknown arguments". Stop
  // the running container directly via docker by label — this is the same
  // path the previous fallback used and works regardless of CLI version.
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
    log.warn('docker stop failed — container may still be running', {
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

  // FK ordering: with `PRAGMA foreign_keys = ON`, every table that points at
  // messaging_groups (sessions, user_dms, pending_channel_approvals,
  // pending_sender_approvals) blocks the messaging_groups DELETE until its
  // rows are gone. Same for everything pointing at agent_groups (sessions,
  // agent_destinations, messaging_group_agents, coding_pr_monitors). Deletes
  // run inside a single transaction so a partial failure can't leave the
  // wiring orphaned (the bug that left ag-1777497141508-lsc4wq half-cleaned).
  const tableExists = (name: string): boolean =>
    !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);

  const txn = db.transaction(() => {
    // 1. Drop coding_worktree_locks first — it FK-points at sessions.
    if (tableExists('coding_worktree_locks')) {
      db.prepare(
        'DELETE FROM coding_worktree_locks WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
      ).run(agentGroupId);
    }
    // 2. Drop coding_pr_monitors (and seen rows cascade) — it FK-points at
    // agent_groups. Cascades on DELETE FROM agent_groups, but we delete
    // explicitly so other cleanup ordering isn't surprised.
    if (tableExists('coding_pr_monitors')) {
      db.prepare('DELETE FROM coding_pr_monitors WHERE agent_group_id = ?').run(agentGroupId);
    }
    // 3. Drop sessions (FK-points at agent_groups AND messaging_groups).
    db.prepare('DELETE FROM sessions WHERE agent_group_id = ?').run(agentGroupId);
    // 4. Drop wiring rows.
    db.prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?').run(agentGroupId);
    if (tableExists('agent_destinations')) {
      db.prepare('DELETE FROM agent_destinations WHERE agent_group_id = ? OR target_id = ?').run(
        agentGroupId,
        agentGroupId,
      );
    }

    // 5. Now safe to delete messaging_groups (or skip if other agents share
    // it). For coding-<ticket> channels we always force-delete; otherwise
    // delete only when empty. user_dms and pending_*_approvals also FK-point
    // at messaging_groups — clear those references first so the delete can
    // succeed even when the channel had a stale DM cache or a pending
    // approval.
    for (const mgId of candidateMgIds) {
      const mg = db.prepare('SELECT name, platform_id FROM messaging_groups WHERE id = ?').get(mgId) as
        | { name?: string; platform_id?: string }
        | undefined;
      if (!mg) continue;

      const isCodingChannel = mg.name === `coding-${ticketLower}`;
      if (!isCodingChannel) {
        const remaining = db
          .prepare('SELECT COUNT(*) as c FROM messaging_group_agents WHERE messaging_group_id = ?')
          .get(mgId) as { c: number };
        if (remaining.c > 0) continue;
      }

      if (mg.platform_id?.startsWith('slack:')) {
        archivedChannelIds.push(mg.platform_id.slice('slack:'.length));
      }
      if (tableExists('user_dms')) {
        db.prepare('DELETE FROM user_dms WHERE messaging_group_id = ?').run(mgId);
      }
      if (tableExists('pending_channel_approvals')) {
        db.prepare('DELETE FROM pending_channel_approvals WHERE messaging_group_id = ?').run(mgId);
      }
      if (tableExists('pending_sender_approvals')) {
        db.prepare('DELETE FROM pending_sender_approvals WHERE messaging_group_id = ?').run(mgId);
      }
      db.prepare('DELETE FROM messaging_groups WHERE id = ?').run(mgId);
    }

    // 6. Finally the agent_group itself.
    deleteAgentGroup(agentGroupId);
  });
  txn();

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

function mergeSummaries(parts: CostSummary[]): CostSummary | null {
  if (parts.length === 0) return null;

  const perModel = new Map<string, CostSummary['models'][number]>();
  let totalCostUSD = 0;
  let totalDurationMs = 0;
  let totalTurns = 0;
  let resultCount = 0;
  let firstTs: string | undefined;
  let lastTs: string | undefined;

  for (const s of parts) {
    totalCostUSD += s.totalCostUSD;
    totalDurationMs += s.totalDurationMs;
    totalTurns += s.totalTurns;
    resultCount += s.resultCount;
    if (s.firstTs && (!firstTs || s.firstTs < firstTs)) firstTs = s.firstTs;
    if (s.lastTs && (!lastTs || s.lastTs > lastTs)) lastTs = s.lastTs;
    for (const m of s.models) {
      const acc = perModel.get(m.model) ?? {
        model: m.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0,
      };
      acc.inputTokens += m.inputTokens;
      acc.outputTokens += m.outputTokens;
      acc.cacheReadInputTokens += m.cacheReadInputTokens;
      acc.cacheCreationInputTokens += m.cacheCreationInputTokens;
      acc.costUSD += m.costUSD;
      perModel.set(m.model, acc);
    }
  }
  if (resultCount === 0) return null;

  return {
    totalCostUSD,
    totalDurationMs,
    totalTurns,
    resultCount,
    models: Array.from(perModel.values()).sort((a, b) => b.costUSD - a.costUSD),
    firstTs: firstTs ?? '',
    lastTs: lastTs ?? '',
  };
}

interface PostCostSummaryForCleanupArgs {
  agentGroupId: string;
  ticketId: string;
  reason: 'merged' | 'abandoned' | 'manual' | undefined;
  assistantName: string;
  workspaceFolder: string;
  /**
   * Captured `rtk gain` output from inside the devcontainer. Caller must
   * capture BEFORE stopping the container — once stopped, the runner
   * fails and the RTK section is omitted.
   */
  rtkGain: string | null;
}

async function postCostSummaryForCleanup(args: PostCostSummaryForCleanupArgs): Promise<void> {
  try {
    const sessionRoot = path.join(DATA_DIR, 'v2-sessions', args.agentGroupId);
    if (!fs.existsSync(sessionRoot)) return;

    const sessionDirs = fs
      .readdirSync(sessionRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('sess-'))
      .map((d) => path.join(sessionRoot, d.name));

    const partials: CostSummary[] = [];
    for (const dir of sessionDirs) {
      const dbPath = path.join(dir, 'outbound.db');
      if (!fs.existsSync(dbPath)) continue;
      const partial = aggregateCostLogFromPath(dbPath);
      if (partial) partials.push(partial);
    }

    const summary = mergeSummaries(partials);
    if (!summary) {
      log.info('cost summary: no cost_log rows — skipping post', {
        agentGroupId: args.agentGroupId,
        ticketId: args.ticketId,
      });
      return;
    }

    // Map cleanup `reason` to the public 'merged' | 'abandoned' label.
    // 'manual' (operator-invoked delete) reports as 'abandoned'.
    const reason: 'merged' | 'abandoned' = args.reason === 'merged' ? 'merged' : 'abandoned';

    // Resolve channel + PR routing from the host DB. coding_pr_monitors is
    // the canonical source for repo+pr_number+messaging_group_id+thread_id.
    // If no monitor row exists (PR was never opened), fall back to any
    // wired messaging group for channel post; PR comment is skipped.
    const db = getDb();
    let channelType: string | null = null;
    let platformId: string | null = null;
    let threadId: string | null = null;
    let repo: string | undefined;
    let prNumber: number | undefined;

    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='coding_pr_monitors'").get()) {
      const monitor = db
        .prepare(
          `SELECT messaging_group_id, thread_id, pr_number, repo
             FROM coding_pr_monitors
             WHERE agent_group_id = ?
             ORDER BY created_at DESC
             LIMIT 1`,
        )
        .get(args.agentGroupId) as
        | { messaging_group_id: string; thread_id: string | null; pr_number: number; repo: string }
        | undefined;
      if (monitor) {
        repo = monitor.repo;
        prNumber = monitor.pr_number;
        threadId = monitor.thread_id;
        const mg = db
          .prepare('SELECT channel_type, platform_id FROM messaging_groups WHERE id = ?')
          .get(monitor.messaging_group_id) as { channel_type?: string; platform_id?: string } | undefined;
        if (mg) {
          channelType = mg.channel_type ?? null;
          platformId = mg.platform_id ?? null;
        }
      }
    }

    if (!channelType || !platformId) {
      const mg = db
        .prepare(
          `SELECT mg.channel_type AS channel_type, mg.platform_id AS platform_id
             FROM messaging_group_agents mga
             JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
             WHERE mga.agent_group_id = ?
             LIMIT 1`,
        )
        .get(args.agentGroupId) as { channel_type?: string; platform_id?: string } | undefined;
      if (mg) {
        channelType = mg.channel_type ?? null;
        platformId = mg.platform_id ?? null;
      }
    }

    const rtkGain = args.rtkGain;

    const slackMarkdown = formatCostSummary(summary, {
      ticketId: args.ticketId,
      reason,
      assistantName: args.assistantName,
      rtkGain,
      target: 'slack',
    });
    const githubMarkdown = formatCostSummary(summary, {
      ticketId: args.ticketId,
      reason,
      assistantName: args.assistantName,
      rtkGain,
      target: 'github',
    });

    await postCostSummary({
      slackMarkdown,
      githubMarkdown,
      channelType,
      platformId,
      threadId,
      repo,
      prNumber,
      repoMasterPath: args.workspaceFolder ? path.join(path.dirname(args.workspaceFolder), 'master') : undefined,
    });
  } catch (err) {
    log.warn('cost summary post failed', {
      agentGroupId: args.agentGroupId,
      ticketId: args.ticketId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
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

  // Capture `rtk gain` from inside the devcontainer BEFORE stopping it —
  // those savings belong to this coding task. Once the container exits
  // the runner fails and the RTK section is omitted.
  const rtkGain = captureRtkGain(containerRtkRunner(group.id));

  stopDevcontainer(workspaceFolder, group.id);

  // After the container exits the outbound.db is safe to read. Aggregate
  // the per-result cost log into a single CostSummary and post it (channel
  // + PR comment) BEFORE we drop messaging_groups / coding_pr_monitors —
  // both are looked up here for routing. Best-effort: failure to summarise
  // must never block the rest of cleanup.
  await postCostSummaryForCleanup({
    agentGroupId: group.id,
    ticketId: args.ticketId,
    reason: args.reason,
    assistantName: group.name,
    workspaceFolder,
    rtkGain,
  });

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
