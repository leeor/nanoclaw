/**
 * Audit-row insert for the prompt-gate skill.
 *
 * Hashes the message text via SHA-256; the hash + length are stored, the
 * raw text is not. To investigate a refusal, an admin correlates the
 * timestamp + agent_group_id + user_id back to the channel's own log and
 * recomputes the hash on the candidate text to confirm the match.
 */
import { createHash, randomUUID } from 'crypto';

import { getDb } from '../../../db/connection.js';

export interface PromptGateDecisionInput {
  user_id: string | null;
  agent_group_id: string;
  messaging_group_id: string;
  decision: 'allowed' | 'denied';
  reason: string | null;
  rule_matched: string | null;
  message_text: string;
}

export interface PromptGateDecisionRow {
  id: string;
  timestamp: string;
  user_id: string | null;
  agent_group_id: string;
  messaging_group_id: string;
  decision: 'allowed' | 'denied';
  reason: string | null;
  rule_matched: string | null;
  text_hash: string;
  text_length: number;
  created_at: string;
}

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function recordDecision(input: PromptGateDecisionInput): PromptGateDecisionRow {
  const now = new Date().toISOString();
  const row: PromptGateDecisionRow = {
    id: `pgd-${randomUUID()}`,
    timestamp: now,
    user_id: input.user_id,
    agent_group_id: input.agent_group_id,
    messaging_group_id: input.messaging_group_id,
    decision: input.decision,
    reason: input.reason,
    rule_matched: input.rule_matched,
    text_hash: hashText(input.message_text),
    text_length: input.message_text.length,
    created_at: now,
  };

  getDb()
    .prepare(
      `INSERT INTO prompt_gate_decisions (
         id, timestamp, user_id, agent_group_id, messaging_group_id,
         decision, reason, rule_matched, text_hash, text_length, created_at
       )
       VALUES (
         @id, @timestamp, @user_id, @agent_group_id, @messaging_group_id,
         @decision, @reason, @rule_matched, @text_hash, @text_length, @created_at
       )`,
    )
    .run(row);

  return row;
}

export function getDecision(id: string): PromptGateDecisionRow | undefined {
  return getDb().prepare('SELECT * FROM prompt_gate_decisions WHERE id = ?').get(id) as
    | PromptGateDecisionRow
    | undefined;
}
