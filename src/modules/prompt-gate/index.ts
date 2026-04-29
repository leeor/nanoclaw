/**
 * Prompt-gate module — content validation for inbound messages.
 *
 * Registers the single message-content inspector (see
 * `setMessageInspector` in src/router.ts). Hooks fire after the access
 * gate + sender-scope gate succeed, so this only sees messages that
 * would otherwise be delivered.
 *
 * What it does:
 *   - Loads `data/prompt-gate.config.json` (or bakes in defaults) once
 *     at import time.
 *   - Runs each message through the pure `decide()` function.
 *   - Records every decision (allowed and denied) in
 *     `prompt_gate_decisions` for audit. Storage-minimized: text hash +
 *     length, never the full text.
 *   - Returns `{ allowed: false, reason }` to the router on refusal.
 *
 * Without this module: `setMessageInspector` is never called and the
 * router treats every message as content-clean (default allow).
 */
import { setMessageInspector, type MessageInspectorResult } from '../../router.js';
import { log } from '../../log.js';
import type { InboundEvent } from '../../channels/adapter.js';
import type { MessagingGroup } from '../../types.js';
import { loadPromptGateConfig, type PromptGateConfig } from './config.js';
import { decide } from './decision.js';
import { recordDecision } from './db/decisions.js';

let cachedConfig: PromptGateConfig | null = null;

function getConfig(): PromptGateConfig {
  if (!cachedConfig) cachedConfig = loadPromptGateConfig();
  return cachedConfig;
}

/** Test-only: drop the cached config so the next inspector call re-reads. */
export function _resetConfigForTests(): void {
  cachedConfig = null;
}

setMessageInspector(
  (
    _event: InboundEvent,
    userId: string | null,
    mg: MessagingGroup,
    agentGroupId: string,
    messageText: string,
  ): MessageInspectorResult => {
    const config = getConfig();
    const outcome = decide(userId, messageText, config);

    try {
      recordDecision({
        user_id: userId,
        agent_group_id: agentGroupId,
        messaging_group_id: mg.id,
        decision: outcome.result.allowed ? 'allowed' : 'denied',
        reason: outcome.result.allowed ? null : outcome.result.reason,
        rule_matched: outcome.ruleMatched,
        message_text: messageText,
      });
    } catch (err) {
      // Audit failure must NOT escape — the inspector is failsafe-block
      // on throw, so a transient DB error would deny every message.
      // Log and continue with whatever the rule engine decided.
      log.error('prompt-gate: failed to record decision', {
        agentGroupId,
        messagingGroupId: mg.id,
        err,
      });
    }

    return outcome.result;
  },
);
