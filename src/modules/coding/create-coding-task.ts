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
 *      devcontainer` + `devcontainerConfig.workspaceFolder = <host worktree>`.
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
import { wakeContainer } from '../../container-runner.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, Session } from '../../types.js';
import { createDestination, getDestinationByName, normalizeName } from '../agent-to-agent/db/agent-destinations.js';
import { writeDestinations } from '../agent-to-agent/write-destinations.js';

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

  // Create the worktree on a new branch named after the ticket.
  try {
    execFileSync('git', ['-C', hostMaster, 'worktree', 'add', worktreeHostPath, '-b', ticketLower], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString() ?? String(err);
    notifyAgent(session, `create_coding_task failed: git worktree add failed:\n${stderr.slice(0, 500)}`);
    log.error('git worktree add failed', { hostMaster, worktreeHostPath, stderr });
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
    `# ${ticketId}\n\nCoding task agent. Worktree: ${worktreeHostPath}\n\n` +
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
    devcontainerConfig: { workspaceFolder: worktreeHostPath },
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

  // Project the new destination into the parent's running container.
  writeDestinations(session.agent_group_id, session.id);

  // Resolve a session for the new agent (agent-shared — one session per
  // coding task, not per-thread).
  const { session: childSession } = resolveSession(agentGroupId, null, null, 'agent-shared');

  // Send the kickoff message into the child's inbound.db.
  const firstMsgParts: string[] = [];
  if (ctx) firstMsgParts.push(ctx.trim());
  if (planPath) firstMsgParts.push(`Plan committed at: ${planPath}`);
  firstMsgParts.push(`Worktree (host): ${worktreeHostPath}\nBranch: ${ticketLower}\nTicket: ${ticketId}`);
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
  wakeContainer(childSession).catch((err) =>
    log.error('Failed to wake new coding-task container', { agentGroupId, err }),
  );

  notifyAgent(
    session,
    `Coding task "${ticketId}" spawned. Send updates with <message to="${childName}">...</message>.`,
  );
  log.info('Coding task created', {
    agentGroupId,
    ticketId,
    folder,
    worktreeHostPath,
    parentGroupId: parentGroup.id,
  });
}
