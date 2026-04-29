/**
 * Pure decision function for the prompt-gate inspector.
 *
 * Given a message + the resolved sender + the active config, return a
 * MessageInspectorResult plus enough metadata for the audit row. Keeping
 * this pure (no DB, no fs, no log) makes the rule tree exhaustively
 * unit-testable and lets the index module wire it into both the router
 * hook and the audit-row insert without duplicating logic.
 *
 * Rule precedence (first match wins):
 *   1. allow_list  → allow (overrides everything, including deny lists)
 *   2. deny_list   → deny  ('deny_list')
 *   3. sender_id_verification.strict + missing userId → deny ('sender_id_missing')
 *   4. prompt_injection patterns     → deny ('prompt_injection.<slug>')
 *   else                              → allow
 */
import type { MessageInspectorResult } from '../../router.js';
import type { PromptGateConfig } from './config.js';

export interface DecisionOutcome {
  result: MessageInspectorResult;
  /** Stable identifier of the rule that fired ('allow_list', 'deny_list', 'prompt_injection.<slug>', etc.). */
  ruleMatched: string | null;
}

export function decide(userId: string | null, messageText: string, config: PromptGateConfig): DecisionOutcome {
  const rules = config.rules;
  const text = messageText ?? '';
  const lower = text.toLowerCase();

  // 1. Allow list short-circuit. Allow > deny so admins can whitelist
  //    themselves out of false positives without editing the patterns.
  if (userId && rules.allow_list_user_ids.includes(userId)) {
    return { result: { allowed: true }, ruleMatched: 'allow_list' };
  }

  // 2. Deny list. Refuses regardless of content.
  if (userId && rules.deny_list_user_ids.includes(userId)) {
    return { result: { allowed: false, reason: 'deny_list' }, ruleMatched: 'deny_list' };
  }

  // 3. Strict sender-ID verification. With strict=false (default), a
  //    missing userId is tolerated — the router's identity gates already
  //    handled it.
  if (rules.sender_id_verification.enabled && rules.sender_id_verification.strict && !userId) {
    return {
      result: { allowed: false, reason: 'sender_id_missing' },
      ruleMatched: 'sender_id_verification.strict',
    };
  }

  // 4. Prompt-injection substring scan. Case-insensitive. First pattern
  //    that fires wins so the audit row points at a single, actionable
  //    rule rather than "one of these N triggered".
  if (rules.prompt_injection.enabled) {
    for (const pattern of rules.prompt_injection.patterns) {
      const needle = pattern.toLowerCase();
      if (needle.length > 0 && lower.includes(needle)) {
        return {
          result: { allowed: false, reason: 'prompt_injection' },
          ruleMatched: `prompt_injection.${slugify(pattern)}`,
        };
      }
    }
  }

  return { result: { allowed: true }, ruleMatched: null };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
