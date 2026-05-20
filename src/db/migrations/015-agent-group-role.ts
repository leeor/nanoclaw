/**
 * Add `role` column to `agent_groups` to distinguish user-facing agents
 * (slack_main, telegram_main, etc.) from worker agents (per-task coding
 * agents).
 *
 * Two invariants enforced downstream by the agent-to-agent module:
 *
 *   1. user_facing agents must never emit `channel_type='agent'` outbound
 *      in response to a user message. They reply to humans on the channel
 *      they were spawned from; cross-agent dispatch happens through
 *      explicit MCP tools (e.g. `create_coding_task`), not via a
 *      `<message to="...">` block resolved to an a2a destination.
 *      Routing must never be content-driven.
 *
 *   2. worker agents must never message a user_facing agent. Workers
 *      communicate via their own dedicated channel (the coding task's
 *      Slack channel, Linear comment, PR review). A worker dispatching
 *      a2a back to a user_facing agent funnels content through a session
 *      that may be busy with unrelated work, where the message is likely
 *      to be queued behind a deep loop and lost to the user.
 *
 * Backfill: existing agent groups whose folder starts with `coding_` are
 * worker agents (per-task coding agents created by /add-coding-agent).
 * Everything else stays user_facing (default).
 *
 * Also purges any stale `agent_destinations` rows that violate the new
 * invariants — a user_facing → worker entry (or a worker → user_facing
 * entry) becomes unreachable under the new rules and should be removed
 * so writeDestinations doesn't project dead names into session DBs.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration015: Migration = {
  version: 15,
  name: 'agent-group-role',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE agent_groups
        ADD COLUMN role TEXT NOT NULL DEFAULT 'user_facing'
        CHECK(role IN ('user_facing', 'worker'));
    `);

    // Backfill: per-task coding agents have folder names like
    // `coding_ancr-1761`. Everything else (slack_main, telegram_main,
    // bespoke installs) stays user_facing.
    db.prepare(`UPDATE agent_groups SET role = 'worker' WHERE folder LIKE 'coding_%'`).run();

    // Purge stale a2a destinations that violate the new invariants. This is
    // a one-off cleanup: under the new rules these rows would either be
    // ignored (writeDestinations filter) or rejected at delivery time.
    // Removing them avoids confusing agents with destinations they can't
    // actually use, and lets the migration be the single source of truth
    // for the role transition.
    //
    // Guarded: the `agent_destinations` table only exists when the
    // agent-to-agent module migration ran. Skip silently otherwise.
    const hasA2A = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='agent_destinations'`).get();
    if (hasA2A) {
      // user_facing → worker
      db.prepare(
        `
        DELETE FROM agent_destinations
         WHERE target_type = 'agent'
           AND agent_group_id IN (SELECT id FROM agent_groups WHERE role = 'user_facing')
           AND target_id IN (SELECT id FROM agent_groups WHERE role = 'worker')
      `,
      ).run();
      // worker → user_facing
      db.prepare(
        `
        DELETE FROM agent_destinations
         WHERE target_type = 'agent'
           AND agent_group_id IN (SELECT id FROM agent_groups WHERE role = 'worker')
           AND target_id IN (SELECT id FROM agent_groups WHERE role = 'user_facing')
      `,
      ).run();
    }
  },
};
