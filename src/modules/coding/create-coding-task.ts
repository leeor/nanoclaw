/**
 * `create_coding_task` delivery-action handler.
 *
 * Spawns a per-task coding agent group backed by a devcontainer in a fresh
 * git worktree. Wires bidirectional parent/child agent_destinations so the
 * parent can send to the new agent and the new agent can reply back.
 *
 * Flow:
 *   1. Translate `repo_master_path` (parent's container path) → host path
 *      via the parent group's `additionalMounts` table.
 *   2. `git worktree add <repo_dir>/<ticket-lower>` on a new branch.
 *   3. Create agent_group `coding_<ticket-lower>` + filesystem scaffold.
 *   4. Overwrite the new group's container.json with `containerBackend:
 *      devcontainer` + `devcontainer.workspaceFolder = <host worktree>`.
 *   5. Insert bidirectional agent_destinations rows.
 *   6. Project new destination into the parent's running container.
 *   7. Resolve a session for the new group (agent-shared) and write the
 *      `context` (+ optional plan_path) as its first message.
 *   8. Wake the new agent's container and notify the parent.
 *
 * Errors are surfaced to the parent via a system chat message back into
 * the parent's session.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { writeContainerConfig, readContainerConfig } from '../../container-config.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { wakeContainer } from '../../container-runner.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroup,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent, Session } from '../../types.js';
import { createDestination, getDestinationByName, normalizeName } from '../agent-to-agent/db/agent-destinations.js';
import { writeDestinations } from '../agent-to-agent/write-destinations.js';
import { getOwners, getGlobalAdmins, getAdminsOfAgentGroup } from '../permissions/db/user-roles.js';

import { createSlackChannelForCodingTask } from './slack-channel-create.js';

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

/**
 * Translate a parent-container path to a host path using the parent group's
 * additionalMounts. Mount containerPaths are relative; the runtime prefixes
 * them with `/workspace/extra/`.
 */
function translateToHostPath(parentFolder: string, containerPath: string): string | null {
  const parentConfig = readContainerConfig(parentFolder);
  for (const mount of parentConfig.additionalMounts ?? []) {
    const fullContainer = `/workspace/extra/${mount.containerPath}`.replace(/\/+$/, '');
    if (containerPath === fullContainer || containerPath.startsWith(fullContainer + '/')) {
      const rel = containerPath.slice(fullContainer.length);
      return path.join(mount.hostPath, rel);
    }
  }
  return null;
}

export async function handleCreateCodingTask(content: Record<string, unknown>, session: Session): Promise<void> {
  const ticketId = (content.ticket_id as string)?.trim();
  const repoMasterContainer = (content.repo_master_path as string)?.trim();
  const ctx = (content.context as string) ?? '';
  const planPath = (content.plan_path as string) || null;
  // Base ref the new worktree branches off of. Defaults to
  // origin/last-green (v1 parity — the last green-CI baseline). Caller
  // can override via the create_coding_task `base_branch` arg.
  const baseBranch = ((content.base_branch as string) || '').trim() || 'origin/last-green';

  if (!ticketId || !repoMasterContainer) {
    notifyAgent(session, 'create_coding_task failed: ticket_id and repo_master_path are required.');
    return;
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(ticketId)) {
    notifyAgent(session, `create_coding_task failed: invalid ticket_id "${ticketId}".`);
    return;
  }

  const parentGroup = getAgentGroup(session.agent_group_id);
  if (!parentGroup) {
    notifyAgent(session, 'create_coding_task failed: parent agent group not found.');
    return;
  }

  const hostMaster = translateToHostPath(parentGroup.folder, repoMasterContainer);
  if (!hostMaster) {
    notifyAgent(
      session,
      `create_coding_task failed: could not translate "${repoMasterContainer}" to a host path. Add an additionalMount in your container.json that covers the repo root.`,
    );
    return;
  }
  if (!fs.existsSync(hostMaster) || !fs.statSync(hostMaster).isDirectory()) {
    notifyAgent(session, `create_coding_task failed: ${repoMasterContainer} (host: ${hostMaster}) is not a directory.`);
    return;
  }

  const ticketLower = ticketId.toLowerCase();
  const folder = `coding_${ticketLower}`;

  if (getAgentGroupByFolder(folder)) {
    notifyAgent(session, `create_coding_task failed: a coding agent for "${ticketId}" already exists.`);
    return;
  }

  // Worktree path: sibling of master, named after ticket.
  const worktreeHostPath = path.join(path.dirname(hostMaster), ticketLower);
  if (fs.existsSync(worktreeHostPath)) {
    notifyAgent(session, `create_coding_task failed: worktree path ${worktreeHostPath} already exists on host.`);
    return;
  }

  // Refresh remote refs so `origin/last-green` (or the caller-supplied
  // base) reflects the latest CI state. Best-effort — offline / network-
  // restricted hosts can still proceed using whatever ref was last fetched.
  try {
    execFileSync('git', ['-C', hostMaster, 'fetch', 'origin', '--quiet'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
  } catch (err) {
    log.warn('git fetch origin failed before worktree add — proceeding with local refs', {
      hostMaster,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // Create the worktree on a new branch named after the ticket, branched
  // off `baseBranch` so unrelated drift on master doesn't get included.
  try {
    execFileSync('git', ['-C', hostMaster, 'worktree', 'add', worktreeHostPath, '-b', ticketLower, baseBranch], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString() ?? String(err);
    notifyAgent(
      session,
      `create_coding_task failed: git worktree add failed (base=${baseBranch}):\n${stderr.slice(0, 500)}`,
    );
    log.error('git worktree add failed', { hostMaster, worktreeHostPath, baseBranch, stderr });
    return;
  }

  // Create the agent_group + filesystem scaffold.
  const agentGroupId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const localName = normalizeName(ticketId);
  const now = new Date().toISOString();
  const newGroup: AgentGroup = {
    id: agentGroupId,
    name: ticketId,
    folder,
    agent_provider: null,
    created_at: now,
  };
  createAgentGroup(newGroup);
  const taskInstructions =
    `# ${ticketId}\n\nCoding task agent. Worktree: ${worktreeHostPath}\nBranch: ${ticketLower} (off ${baseBranch})\n\n` +
    (planPath ? `Plan: ${planPath}\n\n` : '') +
    `Use \`gh\`, \`devcontainer_exec\`, \`monitor_pr\` for PR work. ` +
    `Reply to your parent with \`<message to="parent">...</message>\`.`;
  initGroupFilesystem(newGroup, { instructions: taskInstructions });

  // Overwrite container.json with devcontainer backend pointing at the
  // newly-created host worktree.
  writeContainerConfig(folder, {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
    groupName: ticketId,
    assistantName: ticketId,
    agentGroupId,
    containerBackend: 'devcontainer',
    devcontainer: { workspaceFolder: worktreeHostPath },
  } as ReturnType<typeof readContainerConfig>);

  // Bidirectional destinations (parent ↔ child).
  let childName = localName;
  let suffix = 2;
  while (getDestinationByName(parentGroup.id, childName)) {
    childName = `${localName}-${suffix}`;
    suffix++;
  }
  createDestination({
    agent_group_id: parentGroup.id,
    local_name: childName,
    target_type: 'agent',
    target_id: agentGroupId,
    created_at: now,
  });
  let parentName = 'parent';
  let parentSuffix = 2;
  while (getDestinationByName(agentGroupId, parentName)) {
    parentName = `parent-${parentSuffix}`;
    parentSuffix++;
  }
  createDestination({
    agent_group_id: agentGroupId,
    local_name: parentName,
    target_type: 'agent',
    target_id: parentGroup.id,
    created_at: now,
  });

  // Try to create a per-task Slack channel + wire it as the child's
  // messaging group. Mirrors v1 behavior. If the parent isn't on Slack
  // (or SLACK_BOT_TOKEN is missing / scopes are insufficient), fall back
  // to an agent-shared session reachable only via the parent destination.
  const parentChannelType = session.messaging_group_id
    ? (getMessagingGroup(session.messaging_group_id)?.channel_type ?? '')
    : '';

  let childMessagingGroupId: string | null = null;
  let childChannelInfo: { channelId: string; channelName: string; reused: boolean } | null = null;

  if (parentChannelType === 'slack') {
    try {
      // Collect Slack user IDs to invite: scoped admins of the new group,
      // global admins, owners. Strip the `slack:` prefix.
      const slackUserIds = new Set<string>();
      const collect = (id: string): void => {
        if (id.startsWith('slack:')) slackUserIds.add(id.slice('slack:'.length));
      };
      for (const r of getAdminsOfAgentGroup(agentGroupId)) collect(r.user_id);
      for (const r of getGlobalAdmins()) collect(r.user_id);
      for (const r of getOwners()) collect(r.user_id);

      childChannelInfo = await createSlackChannelForCodingTask({
        name: `coding-${ticketLower}`,
        inviteUserIds: [...slackUserIds],
      });

      const platformId = `slack:${childChannelInfo.channelId}`;
      // Reuse an existing messaging_group row for this Slack channel if one
      // is left over from a prior coding task (or a manual wiring) — the
      // (channel_type, platform_id) UNIQUE index forbids inserting a
      // duplicate, and re-using the row keeps any deeper bookkeeping
      // (denied_at, unknown_sender_policy customizations) intact.
      const existingMg = getMessagingGroupByPlatform('slack', platformId);
      if (existingMg) {
        childMessagingGroupId = existingMg.id;
      } else {
        const mg: MessagingGroup = {
          id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          channel_type: 'slack',
          platform_id: platformId,
          name: childChannelInfo.channelName,
          is_group: 1,
          unknown_sender_policy: 'request_approval',
          created_at: now,
        };
        createMessagingGroup(mg);
        childMessagingGroupId = mg.id;
      }

      const mga: MessagingGroupAgent = {
        id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        messaging_group_id: childMessagingGroupId,
        agent_group_id: agentGroupId,
        engage_mode: 'pattern',
        engage_pattern: '.',
        sender_scope: 'all',
        ignored_message_policy: 'drop',
        session_mode: 'shared',
        priority: 0,
        created_at: now,
      };
      createMessagingGroupAgent(mga);

      log.info('Coding-task Slack channel wired', {
        agentGroupId,
        channelId: childChannelInfo.channelId,
        channelName: childChannelInfo.channelName,
        reused: childChannelInfo.reused,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('Coding-task Slack channel creation failed — falling back to agent-shared session', {
        agentGroupId,
        ticketId,
        err: msg,
      });
      notifyAgent(
        session,
        `Note: could not create per-task Slack channel ("${msg}"). The agent will run with agent-to-agent only — message it via <message to="${childName}">.`,
      );
    }
  }

  // Project the new destinations into the parent's running container so it
  // sees both the child agent and (if created) the new channel destination.
  writeDestinations(session.agent_group_id, session.id);

  // Resolve session: per-channel `shared` if we wired Slack, otherwise
  // `agent-shared` so the agent still has a session reachable via parent.
  const { session: childSession } = childMessagingGroupId
    ? resolveSession(agentGroupId, childMessagingGroupId, null, 'shared')
    : resolveSession(agentGroupId, null, null, 'agent-shared');

  // Send the kickoff message into the child's inbound.db.
  const firstMsgParts: string[] = [];
  if (ctx) firstMsgParts.push(ctx.trim());
  if (planPath) firstMsgParts.push(`Plan committed at: ${planPath}`);
  firstMsgParts.push(
    `Worktree (host): ${worktreeHostPath}\nBranch: ${ticketLower} (off ${baseBranch})\nTicket: ${ticketId}`,
  );
  writeSessionMessage(agentGroupId, childSession.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: parentGroup.id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({
      text: firstMsgParts.join('\n\n'),
      sender: parentGroup.name,
      senderId: parentGroup.id,
    }),
  });
  // Also post the kickoff context to the new Slack channel so the user has
  // visible context while the coding agent's devcontainer is still spinning
  // up. Best-effort — the agent itself will follow up once it's running.
  if (childChannelInfo) {
    const adapter = getChannelAdapter('slack');
    if (adapter) {
      const headerLines = [
        `*Coding task ${ticketId} started*`,
        `Branch: \`${ticketLower}\` (off \`${baseBranch}\`)`,
        `Worktree: \`${worktreeHostPath}\``,
      ];
      if (planPath) headerLines.push(`Plan: \`${planPath}\``);
      const channelKickoff = `${headerLines.join('\n')}${ctx ? `\n\n${ctx.trim()}` : ''}`;
      adapter
        .deliver(`slack:${childChannelInfo.channelId}`, null, {
          kind: 'chat',
          content: { text: channelKickoff },
        })
        .catch((err) =>
          log.warn('Coding-task channel kickoff post failed', {
            channelId: childChannelInfo?.channelId,
            err: err instanceof Error ? err.message : String(err),
          }),
        );
    }
  }

  wakeContainer(childSession).catch((err) =>
    log.error('Failed to wake new coding-task container', { agentGroupId, err }),
  );

  const channelHint = childChannelInfo
    ? ` Slack channel: <#${childChannelInfo.channelId}|${childChannelInfo.channelName}>.`
    : '';
  notifyAgent(
    session,
    `Coding task "${ticketId}" spawned.${channelHint} Send updates with <message to="${childName}">...</message>.`,
  );
  log.info('Coding task created', {
    agentGroupId,
    ticketId,
    folder,
    worktreeHostPath,
    parentGroupId: parentGroup.id,
    messagingGroupId: childMessagingGroupId,
  });
}
