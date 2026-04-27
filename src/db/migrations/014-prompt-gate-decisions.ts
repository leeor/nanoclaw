/**
 * Audit table for the prompt-gate skill (`/add-prompt-gate`).
 *
 * Records every inspector decision (allowed and denied) for forensic
 * investigation. Storage-minimized: the original message text is NOT
 * persisted — only a SHA-256 hash + length so admins can correlate a
 * refusal back to a specific inbound row in the channel's own log without
 * the audit table itself becoming a privacy liability.
 *
 * Module-owned. The base router doesn't read or write this table; the
 * prompt-gate module's `recordDecision` helper inserts rows after each
 * inspector run. If the skill is uninstalled, the table is left in place
 * (harmless) but no new rows accrue.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration014: Migration = {
  version: 14,
  name: 'prompt-gate-decisions',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_gate_decisions (
        id                  TEXT PRIMARY KEY,
        timestamp           TEXT NOT NULL,
        user_id             TEXT,
        agent_group_id      TEXT NOT NULL,
        messaging_group_id  TEXT NOT NULL,
        decision            TEXT NOT NULL,           -- 'allowed' | 'denied'
        reason              TEXT,                    -- denial reason (NULL when allowed)
        rule_matched        TEXT,                    -- which rule fired (e.g. 'prompt_injection.ignore_previous_instructions')
        text_hash           TEXT NOT NULL,           -- sha256 hex of the message text
        text_length         INTEGER NOT NULL,
        created_at          TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_prompt_gate_decisions_user
        ON prompt_gate_decisions(user_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_prompt_gate_decisions_agent
        ON prompt_gate_decisions(agent_group_id, timestamp);
    `);
  },
};
