/**
 * Central index of channel-delivered platform messages.
 *
 * Each row maps `(channel_type, platform_id, platform_message_id)` →
 * `(agent_group_id, session_id, message_out_id)`. Lets the host resolve
 * "did one of our agents post this platform message?" in O(1) without
 * scanning every session's `delivered` table.
 *
 * Use case: inbound reaction events arrive with a target platform message
 * id; the chat-sdk-bridge looks up this table to decide whether the
 * reaction targets an agent message (forward to the agent) or someone
 * else's message (discard). Adapting the existing per-session `delivered`
 * table for this would require a global scan on every reaction tick,
 * which doesn't scale and races mid-write.
 *
 * Insert path: delivery.ts deliverMessage, AFTER markDelivered, for
 * `channel_type ∉ {agent, system}` only. a2a messages don't have a
 * platform_message_id; system messages aren't visible to users.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'delivered-platform-messages',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS delivered_platform_messages (
        channel_type        TEXT NOT NULL,
        platform_id         TEXT NOT NULL,
        platform_message_id TEXT NOT NULL,
        agent_group_id      TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message_out_id      TEXT NOT NULL,
        delivered_at        TEXT NOT NULL,
        PRIMARY KEY (channel_type, platform_id, platform_message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_delivered_platform_messages_session
        ON delivered_platform_messages(session_id);
    `);
  },
};
