/**
 * Prompt-gate configuration.
 *
 * Loads `data/prompt-gate.config.json` if present; otherwise falls back to
 * the baked-in defaults below. Schema is intentionally narrow — extend by
 * adding rules, not by reshaping the top-level keys.
 *
 * Pure (no module-level side effects). The module's public entry calls
 * loadPromptGateConfig() once at import time and passes the result into
 * the decision function. Tests can call the loader directly with their
 * own override.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';

export interface PromptInjectionRule {
  enabled: boolean;
  /**
   * Case-insensitive substrings. Each entry is an *exact phrase* match
   * (substring). Heavyweight regex / NLP detectors are out of scope for
   * this skill — that's what a remote scanner inspector would handle.
   */
  patterns: string[];
}

export interface SenderIdVerificationRule {
  enabled: boolean;
  /**
   * When true, missing userId on the inbound event denies the message.
   * When false (default), missing userId only denies if some other rule
   * also triggers — i.e. unverifiable sender alone isn't a refusal,
   * matching the rest of the router's allow-on-no-info posture.
   */
  strict: boolean;
}

export interface PromptGateConfig {
  version: 1;
  rules: {
    prompt_injection: PromptInjectionRule;
    sender_id_verification: SenderIdVerificationRule;
    /** Namespaced user IDs (e.g. "discord:123") that bypass content rules. */
    allow_list_user_ids: string[];
    /** Namespaced user IDs that are unconditionally refused. */
    deny_list_user_ids: string[];
  };
}

export const DEFAULT_CONFIG: PromptGateConfig = {
  version: 1,
  rules: {
    prompt_injection: {
      enabled: true,
      patterns: [
        'ignore previous instructions',
        'ignore all previous',
        'disregard all previous',
        'disregard previous instructions',
        'forget previous instructions',
        'forget all previous',
        'system prompt',
        'reveal your prompt',
        'reveal your instructions',
        'override your instructions',
      ],
    },
    sender_id_verification: { enabled: true, strict: false },
    allow_list_user_ids: [],
    deny_list_user_ids: [],
  },
};

const CONFIG_FILENAME = 'prompt-gate.config.json';

export function loadPromptGateConfig(dir: string = DATA_DIR): PromptGateConfig {
  const file = path.join(dir, CONFIG_FILENAME);
  if (!fs.existsSync(file)) return DEFAULT_CONFIG;

  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PromptGateConfig>;
    return mergeWithDefaults(parsed);
  } catch (err) {
    log.warn('prompt-gate: failed to load config, using defaults', { file, err });
    return DEFAULT_CONFIG;
  }
}

/**
 * Shallow-merge user config over defaults, key by key. Keeps the user's
 * config file minimal (they can override only the rules they care about).
 */
export function mergeWithDefaults(user: Partial<PromptGateConfig>): PromptGateConfig {
  const userRules = (user.rules ?? {}) as Partial<PromptGateConfig['rules']>;
  return {
    version: 1,
    rules: {
      prompt_injection: {
        ...DEFAULT_CONFIG.rules.prompt_injection,
        ...(userRules.prompt_injection ?? {}),
      },
      sender_id_verification: {
        ...DEFAULT_CONFIG.rules.sender_id_verification,
        ...(userRules.sender_id_verification ?? {}),
      },
      allow_list_user_ids: userRules.allow_list_user_ids ?? DEFAULT_CONFIG.rules.allow_list_user_ids,
      deny_list_user_ids: userRules.deny_list_user_ids ?? DEFAULT_CONFIG.rules.deny_list_user_ids,
    },
  };
}
