/**
 * Central index of channel-delivered platform messages (migration 016).
 *
 * Lookup primitive used by the chat-sdk-bridge's `onReaction` handler to
 * decide whether an incoming reaction targets a message one of our agents
 * posted. Reactions on third-party messages are discarded; reactions on
 * agent messages are forwarded to the posting agent's session.
 *
 * Insert path: `delivery.ts:deliverMessage` calls `recordPlatformDelivery`
 * after `markDelivered`, for channel-kind deliveries only (a2a has no
 * platform_message_id, system actions aren't user-visible).
 */
import { getDb } from './connection.js';

export interface PlatformDeliveryLookup {
  agentGroupId: string;
  sessionId: string;
  messageOutId: string;
}

/**
 * Record that an agent's outbound delivered to a specific platform message
 * id on a specific channel. Idempotent — if the same triple is inserted
 * twice (rare, but possible if the delivery is replayed) the existing row
 * wins.
 */
export function recordPlatformDelivery(args: {
  channelType: string;
  platformId: string;
  platformMessageId: string;
  agentGroupId: string;
  sessionId: string;
  messageOutId: string;
}): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO delivered_platform_messages
        (channel_type, platform_id, platform_message_id, agent_group_id, session_id, message_out_id, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      args.channelType,
      args.platformId,
      args.platformMessageId,
      args.agentGroupId,
      args.sessionId,
      args.messageOutId,
    );
}

/**
 * Find which agent (and session) posted a given platform message. Returns
 * `null` when the platform message isn't one of ours — caller should
 * discard whatever event triggered the lookup (e.g. a reaction on a user
 * message, a reply to a non-agent post).
 */
export function findAgentForPlatformMessage(
  channelType: string,
  platformId: string,
  platformMessageId: string,
): PlatformDeliveryLookup | null {
  const row = getDb()
    .prepare(
      `SELECT agent_group_id AS agentGroupId, session_id AS sessionId, message_out_id AS messageOutId
         FROM delivered_platform_messages
        WHERE channel_type = ? AND platform_id = ? AND platform_message_id = ?
        LIMIT 1`,
    )
    .get(channelType, platformId, platformMessageId) as PlatformDeliveryLookup | undefined;
  return row ?? null;
}
