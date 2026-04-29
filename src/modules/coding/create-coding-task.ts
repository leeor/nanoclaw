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
import { GROUPS_DIR } from '../../config.js';
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

interface ResolvedRepo {
  /** The container path to the master worktree (input to translateToHostPath). */
  repoMasterContainer: string;
  /** Optional registry-supplied default base branch. Caller's `base_branch` arg always wins. */
  defaultBaseBranch: string | null;
  /** Optional registry-supplied worktree root, in **container path** form. */
  worktreeRootContainer: string | null;
}

/**
 * Resolve a `repo` registry name against the parent group's container.json
 * `repos` field. Returns null when unconfigured. The registry stores paths
 * RELATIVE to /workspace/extra/ (mirroring additionalMounts), so we prepend
 * that prefix here and let translateToHostPath do the rest.
 */
function resolveRepoRegistry(parentFolder: string, repoName: string): ResolvedRepo | null {
  const parentConfig = readContainerConfig(parentFolder);
  const entry = parentConfig.repos?.[repoName];
  if (!entry) return null;
  const cp = entry.containerPath.replace(/^\/+/, '').replace(/\/+$/, '');
  const wr = entry.worktreeRoot ? entry.worktreeRoot.replace(/^\/+/, '').replace(/\/+$/, '') : null;
  return {
    repoMasterContainer: `/workspace/extra/${cp}`,
    defaultBaseBranch: entry.defaultBaseBranch ?? null,
    worktreeRootContainer: wr ? `/workspace/extra/${wr}` : null,
  };
}

export async function handleCreateCodingTask(content: Record<string, unknown>, session: Session): Promise<void> {
  const ticketId = (content.ticket_id as string)?.trim();
  const repoName = ((content.repo as string) || '').trim();
  const explicitRepoMasterContainer = ((content.repo_master_path as string) || '').trim();
  const ctx = (content.context as string) ?? '';
  const planPath = (content.plan_path as string) || null;
  // Caller-supplied base ref overrides any registry default; if neither is
  // set we fall back to `origin/last-green` (mono parity).
  const callerBaseBranch = ((content.base_branch as string) || '').trim() || null;

  if (!ticketId) {
    notifyAgent(session, 'create_coding_task failed: ticket_id is required.');
    return;
  }
  if (!repoName && !explicitRepoMasterContainer) {
    notifyAgent(session, 'create_coding_task failed: one of `repo` or `repo_master_path` is required.');
    return;
  }
  if (repoName && explicitRepoMasterContainer) {
    notifyAgent(session, 'create_coding_task failed: pass `repo` or `repo_master_path`, not both.');
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

  // Resolve `repo` against the parent's registry, or fall back to the
  // explicit container path. registryDefaultBase / worktreeRootContainer are
  // null in the explicit-path branch — the worktree placement falls back to
  // `dirname(master)/<ticket>` and the base branch to `origin/last-green`.
  let repoMasterContainer: string;
  let registryDefaultBase: string | null = null;
  let worktreeRootContainer: string | null = null;
  if (repoName) {
    const resolved = resolveRepoRegistry(parentGroup.folder, repoName);
    if (!resolved) {
      notifyAgent(
        session,
        `create_coding_task failed: repo "${repoName}" is not defined in your container.json \`repos\` registry.`,
      );
      return;
    }
    repoMasterContainer = resolved.repoMasterContainer;
    registryDefaultBase = resolved.defaultBaseBranch;
    worktreeRootContainer = resolved.worktreeRootContainer;
  } else {
    repoMasterContainer = explicitRepoMasterContainer;
  }

  const baseBranch = callerBaseBranch ?? registryDefaultBase ?? 'origin/last-green';

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

  // Worktree placement:
  //   - registry `worktreeRoot` provided → translate to host, append ticket.
  //   - else → sibling of master, named after ticket (legacy mono layout).
  let worktreeHostPath: string;
  if (worktreeRootContainer) {
    const hostRoot = translateToHostPath(parentGroup.folder, worktreeRootContainer);
    if (!hostRoot) {
      notifyAgent(
        session,
        `create_coding_task failed: could not translate worktreeRoot "${worktreeRootContainer}" to a host path. Add an additionalMount that covers it.`,
      );
      return;
    }
    worktreeHostPath = path.join(hostRoot, ticketLower);
  } else {
    worktreeHostPath = path.join(path.dirname(hostMaster), ticketLower);
  }
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
  // Slack channel creation is later in the flow; predict its existence from
  // the parent's channel type. The dedicated channel is created iff the parent
  // is wired to Slack — same predicate the slack-channel-create branch uses below.
  const parentMgForHeader = session.messaging_group_id
    ? (getMessagingGroup(session.messaging_group_id)?.channel_type ?? '')
    : '';
  const channelDest = parentMgForHeader === 'slack' ? `coding-${ticketLower}` : null;
  const replyGuidance = channelDest
    ? `Post status, design summaries, and questions to your dedicated Slack channel ` +
      `via \`mcp__nanoclaw__send_message(to="${channelDest}", text=...)\`. ` +
      `Use \`<message to="parent">\` ONLY for creation/completion handoffs ` +
      `(initial spawn ack, terminal task summary) — NOT for ongoing dialog.`
    : `Reply to your parent with \`<message to="parent">...</message>\`.`;
  const taskHeader =
    `# ${ticketId}\n\nCoding task agent. Worktree: ${worktreeHostPath}\nBranch: ${ticketLower} (off ${baseBranch})\n\n` +
    (planPath ? `Plan: ${planPath}\n\n` : '') +
    `Use \`gh\`, \`devcontainer_exec\`, \`monitor_pr\` for PR work. ${replyGuidance}`;
  // Inherit operator's coding-agent playbook from groups/coding_global. The
  // template is the source of truth for Implementation Workflow, PR Monitor
  // Workflow, Local Review, etc. — every coding task gets the same instructions
  // by construction. If coding_global has no template (fresh install), the new
  // task falls back to just the per-task header + module-coding-task fragment.
  const operatorTemplatePath = path.join(GROUPS_DIR, 'coding_global', 'CLAUDE.local.md');
  let operatorTemplate = '';
  try {
    if (fs.existsSync(operatorTemplatePath)) {
      operatorTemplate = fs.readFileSync(operatorTemplatePath, 'utf-8').trim();
    }
  } catch (err) {
    log.warn('Failed to read coding_global/CLAUDE.local.md template — falling back to per-task header only', {
      operatorTemplatePath,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  const taskInstructions = operatorTemplate ? `${taskHeader}\n\n---\n\n${operatorTemplate}` : taskHeader;
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
        // agent-shared (not 'shared') so the router's threaded-adapter override
        // can't split a single coding task into per-thread sessions. The
        // coding-task contract is "one container per task" — every Slack message
        // in the dedicated coding-<ticket> channel must hit the same container,
        // regardless of which Slack thread the user happens to start.
        session_mode: 'agent-shared',
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

  // Single-container contract: agent-shared regardless of messaging group, so
  // every Slack message in the coding-<ticket> channel (any thread) and every
  // parent-routed message land in the same session.
  const { session: childSession } = resolveSession(agentGroupId, childMessagingGroupId, null, 'agent-shared');

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
