/**
 * Persistent key/value state for the container. Lives in outbound.db
 * (container-owned, already scoped per channel/thread).
 *
 * Primary use: remember each provider's opaque continuation id so the
 * agent's conversation resumes across container restarts. Keyed per
 * provider because continuations are provider-private — a Claude
 * conversation id means nothing to Codex and vice versa. Switching
 * providers is therefore lossless: each provider's last thread stays
 * on file and resumes cleanly if the user flips back.
 */
import { getOutboundDb } from './connection.js';

const LEGACY_KEY = 'sdk_session_id';

function continuationKey(providerName: string): string {
  return `continuation:${providerName.toLowerCase()}`;
}

function getValue(key: string): string | undefined {
  const row = getOutboundDb()
    .prepare('SELECT value FROM session_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function setValue(key: string, value: string): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, new Date().toISOString());
}

function deleteValue(key: string): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(key);
}

/**
 * One-time migration of the pre-per-provider continuation row.
 *
 * Before this was keyed per provider, continuations lived under the
 * single key `sdk_session_id`. On container start, if that legacy row
 * exists and the current provider has no continuation of its own, adopt
 * the legacy value into the current provider's slot (best-guess — the
 * legacy row was written by whatever provider ran last). The legacy row
 * is always deleted so future provider flips never re-read a stale id
 * through the wrong lens.
 *
 * Returns the continuation the caller should use at startup (either the
 * current provider's existing value, the adopted legacy value, or
 * undefined).
 */
export function migrateLegacyContinuation(providerName: string): string | undefined {
  const legacy = getValue(LEGACY_KEY);
  const currentKey = continuationKey(providerName);
  const current = getValue(currentKey);

  if (legacy === undefined) return current;

  // Always drop the legacy row so no future provider reads it.
  deleteValue(LEGACY_KEY);

  // Prefer the current provider's own slot if one already exists.
  if (current !== undefined) return current;

  setValue(currentKey, legacy);
  return legacy;
}

export function getContinuation(providerName: string): string | undefined {
  return getValue(continuationKey(providerName));
}

export function setContinuation(providerName: string, id: string): void {
  setValue(continuationKey(providerName), id);
}

export function clearContinuation(providerName: string): void {
  deleteValue(continuationKey(providerName));
}

// ── Model / handoff / restart ──
//
// Model: the active Claude model id for this session. Persisted so it
// survives container restarts. Provider-agnostic key — only Claude
// reads it today, but if/when other providers grow a notion of "model"
// they can use the same slot.
//
// Pending handoff: a self-contained prompt left by `set_model` with
// freshSession=true. The poll-loop consumes it on its next outer
// iteration, runs a fresh query (no continuation), and clears the slot.
//
// Restart flag: a one-shot signal raised by `set_model` to abort the
// in-flight provider query. The poll-loop's inner tick consumes the
// flag, calls query.abort(), and falls back to its outer loop where it
// then sees the pending handoff and the new model.
//
// MCP tools run in a separate process from the poll-loop; in-memory
// state would not be visible across the boundary, so all three signals
// flow through this DB-backed store.
const MODEL_KEY = 'agent_model';
const HANDOFF_KEY = 'pending_handoff';
const RESTART_KEY = 'restart_requested';

export function getModel(): string | undefined {
  return getValue(MODEL_KEY);
}

export function setModel(model: string): void {
  setValue(MODEL_KEY, model);
}

export function clearModel(): void {
  deleteValue(MODEL_KEY);
}

export function getPendingHandoff(): string | undefined {
  return getValue(HANDOFF_KEY);
}

export function setPendingHandoff(text: string): void {
  setValue(HANDOFF_KEY, text);
}

export function clearPendingHandoff(): void {
  deleteValue(HANDOFF_KEY);
}

export function setRestartFlag(): void {
  setValue(RESTART_KEY, '1');
}

export function consumeRestartFlag(): boolean {
  const v = getValue(RESTART_KEY);
  if (!v) return false;
  deleteValue(RESTART_KEY);
  return true;
}
