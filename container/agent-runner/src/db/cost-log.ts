/**
 * Per-result cost log writer (container side).
 *
 * Each SDK result message produced by the agent provider is appended here.
 * The host reads (and aggregates) these rows on coding-task cleanup —
 * that's the only time per-task spend is summarised. The split (container
 * writes, host aggregates) mirrors the messages_out / messages_in pattern:
 * container is the sole writer; host is the sole reader.
 *
 * Schema lives in `connection.ts`; this module just owns the insert.
 */
import { getOutboundDb } from './connection.js';

export interface CostLogModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

export interface AppendCostLogEntry {
  sessionId: string | null;
  subtype: string | null;
  durationMs: number | null;
  numTurns: number | null;
  totalCostUsd: number | null;
  modelUsage: Record<string, CostLogModelUsage>;
}

export function appendCostLog(entry: AppendCostLogEntry): void {
  const db = getOutboundDb();
  db.prepare(
    `INSERT INTO cost_log (ts, session_id, subtype, duration_ms, num_turns, total_cost_usd, model_usage)
     VALUES ($ts, $session_id, $subtype, $duration_ms, $num_turns, $total_cost_usd, $model_usage)`,
  ).run({
    $ts: new Date().toISOString(),
    $session_id: entry.sessionId,
    $subtype: entry.subtype,
    $duration_ms: entry.durationMs,
    $num_turns: entry.numTurns,
    $total_cost_usd: entry.totalCostUsd,
    $model_usage: JSON.stringify(entry.modelUsage),
  });
}
