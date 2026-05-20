/**
 * Agent-to-agent message routing.
 *
 * Outbound messages with `channel_type === 'agent'` target another agent
 * group rather than a channel. Permission is enforced via `agent_destinations` —
 * the source agent must have a row for the target. Content is copied into the
 * target's inbound DB; if the source message had `files` (from `send_file`),
 * the actual bytes are copied from the source's outbox into the target's
 * `inbox/<a2a-msg-id>/` directory and surfaced to the target agent as
 * `attachments` (existing formatter convention — see formatter.ts:230).
 * The target agent can then forward the file onward via its own `send_file`
 * call using the absolute `/workspace/inbox/<a2a-msg-id>/<filename>` path.
 *
 * Self-messages are always allowed (used for system notes injected back into
 * an agent's own session, e.g. post-approval follow-up prompts).
 *
 * Core delivery.ts dispatches into this via a dynamic import guarded by a
 * `channel_type === 'agent'` check. When the module is absent the check in
 * core throws with a "module not installed" message so retry → mark failed.
 */
import fs from 'fs';
import path from 'path';

import { isSafeAttachmentName } from '../../attachment-safety.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { getProcessingClaims } from '../../db/session-db.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { openOutboundDb, resolveSession, sessionDir, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { hasDestination } from './db/agent-destinations.js';

/**
 * How long a target session may hold a `processing` claim before an incoming
 * a2a route is demoted to the source's origin chat. The default 10 minutes
 * matches the practical "this agent is in a deep work loop and won't read
 * a new prompt anytime soon" threshold — below this, in-flight short turns
 * shouldn't trip the guard; above, we'd rather the human see the message
 * directly than have it queued behind a long task.
 *
 * Exported so tests can pass shorter values; production uses the default.
 */
export const TARGET_BUSY_MS = 10 * 60 * 1000;

export { isSafeAttachmentName };

export interface ForwardedAttachment {
  name: string;
  filename: string;
  type: 'file';
  localPath: string;
}

/**
 * Copy file attachments from the source agent's outbox into the target
 * agent's inbox. Returns attachments using the formatter's existing
 * `{name, type, localPath}` convention — target agent reads `localPath`
 * as relative to `/workspace/`, matching how channel-inbound attachments
 * are surfaced today.
 *
 * Missing source files and unsafe (path-traversal) filenames are skipped
 * with a warning rather than failing the whole route — a bad filename
 * reference shouldn't kill the accompanying text.
 */
export function forwardAttachedFiles(
  source: { agentGroupId: string; sessionId: string; messageId: string; filenames: string[] },
  target: { agentGroupId: string; sessionId: string; messageId: string },
): ForwardedAttachment[] {
  if (source.filenames.length === 0) return [];

  const sourceDir = path.join(sessionDir(source.agentGroupId, source.sessionId), 'outbox', source.messageId);
  if (!fs.existsSync(sourceDir)) {
    log.warn('agent-route: source outbox dir missing, no files forwarded', {
      sourceMsgId: source.messageId,
      sourceDir,
    });
    return [];
  }

  const targetInboxDir = path.join(sessionDir(target.agentGroupId, target.sessionId), 'inbox', target.messageId);
  fs.mkdirSync(targetInboxDir, { recursive: true });

  const attachments: ForwardedAttachment[] = [];
  for (const filename of source.filenames) {
    if (!isSafeAttachmentName(filename)) {
      log.warn('agent-route: rejecting unsafe attachment filename (path traversal attempt?)', {
        sourceMsgId: source.messageId,
        filename,
      });
      continue;
    }
    const src = path.join(sourceDir, filename);
    if (!fs.existsSync(src)) {
      log.warn('agent-route: referenced file missing in source outbox, skipped', {
        sourceMsgId: source.messageId,
        filename,
      });
      continue;
    }
    const dst = path.join(targetInboxDir, filename);
    fs.copyFileSync(src, dst);
    attachments.push({
      name: filename,
      filename,
      type: 'file',
      localPath: `inbox/${target.messageId}/${filename}`,
    });
  }
  return attachments;
}

export interface RoutableAgentMessage {
  id: string;
  platform_id: string | null;
  content: string;
}

/**
 * Source agent has no `agent_destinations` row pointing at the target. Thrown
 * separately from generic Error so delivery.ts can demote the outbound to a
 * channel reply (sending the body to the session's origin chat) instead of
 * silently dropping the agent's response after retry exhaustion.
 */
export class UnauthorizedAgentRouteError extends Error {
  constructor(
    public readonly sourceAgentGroupId: string,
    public readonly targetAgentGroupId: string,
  ) {
    super(`unauthorized agent-to-agent: ${sourceAgentGroupId} has no destination for ${targetAgentGroupId}`);
    this.name = 'UnauthorizedAgentRouteError';
  }
}

/** Target agent group id resolves to no row in `agent_groups`. Demotable, same as Unauthorized. */
export class UnknownAgentTargetError extends Error {
  constructor(
    public readonly targetAgentGroupId: string,
    messageId: string,
  ) {
    super(`target agent group ${targetAgentGroupId} not found for message ${messageId}`);
    this.name = 'UnknownAgentTargetError';
  }
}

/**
 * Target session already has a long-running `processing` claim. Demotable —
 * the source should learn (via its origin chat) that the target was busy
 * and the message wasn't queued behind a deep work loop where it would
 * never be seen in time.
 */
export class TargetBusyError extends Error {
  constructor(
    public readonly targetAgentGroupId: string,
    public readonly targetSessionId: string,
    public readonly claimAgeMs: number,
  ) {
    super(
      `target agent ${targetAgentGroupId} session ${targetSessionId} has been processing for ${Math.round(claimAgeMs / 1000)}s — demoting to origin chat`,
    );
    this.name = 'TargetBusyError';
  }
}

/**
 * Source is a user_facing agent (e.g. slack_main) attempting to emit an
 * agent-to-agent message. user_facing agents converse with humans only —
 * cross-agent dispatch goes through MCP tools (e.g. `create_coding_task`)
 * rather than a destinations entry. Demoted to the origin chat so the body
 * still reaches the human.
 */
export class UserFacingNoA2AError extends Error {
  constructor(public readonly sourceAgentGroupId: string) {
    super(
      `user_facing agent ${sourceAgentGroupId} attempted agent-to-agent outbound — must dispatch via MCP tool, not a2a destination`,
    );
    this.name = 'UserFacingNoA2AError';
  }
}

/**
 * Source is a worker agent attempting to message a user_facing agent.
 * Workers communicate via their own dedicated channel (the coding task's
 * Slack channel, Linear comments, PR review). Routing a reply back to a
 * user_facing agent risks queueing the message behind a deep work loop in
 * the user_facing agent's session and losing it. Demoted to the worker's
 * origin chat (its dedicated channel).
 */
export class WorkerToUserFacingError extends Error {
  constructor(
    public readonly sourceAgentGroupId: string,
    public readonly targetAgentGroupId: string,
  ) {
    super(
      `worker agent ${sourceAgentGroupId} attempted to message user_facing agent ${targetAgentGroupId} — workers communicate via their own channel`,
    );
    this.name = 'WorkerToUserFacingError';
  }
}

export async function routeAgentMessage(msg: RoutableAgentMessage, session: Session): Promise<void> {
  const targetAgentGroupId = msg.platform_id;
  if (!targetAgentGroupId) {
    throw new Error(`agent-to-agent message ${msg.id} is missing a target agent group id`);
  }
  // Self-messages (system notes injected back into an agent's own session)
  // bypass destination + role checks. Everything else is policed below.
  const isSelf = targetAgentGroupId === session.agent_group_id;

  // Role-based guards (migration 015). user_facing agents must never emit
  // a2a outbound; worker agents must never target user_facing agents.
  // Apply before the authorization check so the message lands in the
  // demote path for the more specific (role) reason rather than getting
  // tagged "unauthorized destination" — clearer logs, clearer telemetry.
  if (!isSelf) {
    const source = getAgentGroup(session.agent_group_id);
    if (source?.role === 'user_facing') {
      throw new UserFacingNoA2AError(session.agent_group_id);
    }
    const target = getAgentGroup(targetAgentGroupId);
    if (source?.role === 'worker' && target?.role === 'user_facing') {
      throw new WorkerToUserFacingError(session.agent_group_id, targetAgentGroupId);
    }
  }

  if (!isSelf && !hasDestination(session.agent_group_id, 'agent', targetAgentGroupId)) {
    throw new UnauthorizedAgentRouteError(session.agent_group_id, targetAgentGroupId);
  }
  if (!getAgentGroup(targetAgentGroupId)) {
    throw new UnknownAgentTargetError(targetAgentGroupId, msg.id);
  }
  const { session: targetSession } = resolveSession(targetAgentGroupId, null, null, 'agent-shared');

  // Busy-target guard: if the target's agent-shared session has been
  // sitting on a `processing` claim past TARGET_BUSY_MS, the target is
  // mid-deep-work-loop. Queueing more inbound onto it means the source's
  // message will sit unread until the target finishes — which for a long
  // coding-task agent could be hours. Demote to origin chat instead so
  // the human sees the body now and can re-dispatch deliberately.
  //
  // Self-messages are exempt — internal notes back into the same session
  // are not subject to "the target is busy" semantics.
  if (targetAgentGroupId !== session.agent_group_id) {
    const claimAge = readLongestProcessingClaimAgeMs(targetAgentGroupId, targetSession.id);
    if (claimAge !== null && claimAge > TARGET_BUSY_MS) {
      throw new TargetBusyError(targetAgentGroupId, targetSession.id, claimAge);
    }
  }

  const a2aMsgId = `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // If the source message references files (via `send_file`), forward the
  // bytes from the source's outbox into the target's inbox so the target
  // agent can actually see and re-send them. Without this, agent-to-agent
  // file attachments look like they arrive but the target has no way to
  // read the bytes — they live in a session dir it doesn't mount.
  const forwardedContent = forwardFileAttachments(msg, a2aMsgId, session, targetAgentGroupId, targetSession.id);

  writeSessionMessage(targetAgentGroupId, targetSession.id, {
    id: a2aMsgId,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: forwardedContent,
  });
  log.info('Agent message routed', {
    from: session.agent_group_id,
    to: targetAgentGroupId,
    targetSession: targetSession.id,
    a2aMsgId,
    forwardedFileCount: countForwardedFiles(forwardedContent),
  });
  const fresh = getSession(targetSession.id);
  if (fresh) await wakeContainer(fresh);
}

/**
 * Parse source content, copy any referenced `files` from source outbox to
 * target inbox, and return a JSON string with an `attachments` array added
 * (formatter.ts:223 already knows how to render this shape).
 *
 * If the source content isn't JSON or has no files, returns the original
 * content string unchanged — this is safe to call on every route.
 */
function forwardFileAttachments(
  msg: RoutableAgentMessage,
  a2aMsgId: string,
  sourceSession: Session,
  targetAgentGroupId: string,
  targetSessionId: string,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(msg.content);
  } catch {
    return msg.content;
  }
  const files = parsed.files as unknown;
  if (!Array.isArray(files) || files.length === 0) return msg.content;
  const filenames = files.filter((f): f is string => typeof f === 'string');
  if (filenames.length === 0) return msg.content;

  const attachments = forwardAttachedFiles(
    {
      agentGroupId: sourceSession.agent_group_id,
      sessionId: sourceSession.id,
      messageId: msg.id,
      filenames,
    },
    {
      agentGroupId: targetAgentGroupId,
      sessionId: targetSessionId,
      messageId: a2aMsgId,
    },
  );

  // Merge into any existing `attachments` (unlikely in a2a context but safe).
  const existing = Array.isArray(parsed.attachments) ? (parsed.attachments as Record<string, unknown>[]) : [];
  parsed.attachments = [...existing, ...attachments];

  return JSON.stringify(parsed);
}

function countForwardedFiles(contentStr: string): number {
  try {
    const parsed = JSON.parse(contentStr);
    return Array.isArray(parsed.attachments) ? parsed.attachments.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Read the target session's `processing_ack` claims and return the age (ms)
 * of the oldest still-`processing` row. Returns `null` if no claims are
 * outstanding, or if the outbound.db can't be opened (no container has
 * ever run for this session — definitionally not busy).
 */
function readLongestProcessingClaimAgeMs(agentGroupId: string, sessionId: string): number | null {
  let outDb;
  try {
    outDb = openOutboundDb(agentGroupId, sessionId);
  } catch {
    return null;
  }
  try {
    const claims = getProcessingClaims(outDb);
    if (claims.length === 0) return null;
    const now = Date.now();
    let maxAge = 0;
    for (const c of claims) {
      const t = Date.parse(c.status_changed);
      if (Number.isNaN(t)) continue;
      const age = now - t;
      if (age > maxAge) maxAge = age;
    }
    return maxAge > 0 ? maxAge : null;
  } finally {
    outDb.close();
  }
}
