/**
 * Cost summary delivery action handler.
 *
 * The container-side agent writes a `messages_out` row with kind='system'
 * and action='coding_cost_summary' on task completion. The content payload
 * carries:
 *   - taskId: the v2 session id
 *   - prUrl: PR URL if one was opened
 *   - branchName: the worktree branch name
 *   - summary: text summary the agent generated
 *   - tokens: usage breakdown
 *   - costUsd: dollar estimate
 *
 * This handler formats and posts the summary back to the originating
 * channel (Slack, etc.) and optionally adds a PR comment via the
 * container-side gh MCP — handled in a later sub-task.
 *
 * NOTE: full implementation lives in sub-task 4. This stub is registered
 * by index.ts so the action is recognized; until the impl lands the
 * handler logs and acks the message.
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import type { Session } from '../../types.js';

export async function handleCostSummary(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  log.info('coding_cost_summary received (handler stub — sub-task 4 will format + deliver)', {
    sessionId: session.id,
    taskId: content.taskId,
    prUrl: content.prUrl,
    costUsd: content.costUsd,
  });
}
