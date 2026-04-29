/**
 * Runtime wiring for the deterministic PR monitor.
 *
 * Bridges the pure poller in `pr-monitor.ts` to real-world dependencies:
 *
 *   - `fetchPrStateGh`       → `gh pr view <n> --repo <repo> --json state`
 *   - `fetchCommentsGh`      → `gh api -i repos/<repo>/{issues,pulls}/<n>/comments`
 *                              with `If-None-Match` for ETag fast-path 304s
 *   - `wakeAgentForMonitor`  → resolve session for
 *                              (agent_group, messaging_group, thread_id),
 *                              insert a chat message into its inbound.db,
 *                              and wake the container
 *   - `cleanupCodingTaskStub` → stub for sub-task 9; orphan scanner picks
 *                              up the stranded session in the meantime
 *
 * The factory `buildPrMonitorDeps()` is the single place runtime deps are
 * assembled — host-sweep imports it lazily and feeds it to
 * `pollDuePrMonitors()`.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { getDb } from '../../db/connection.js';
import { GROUPS_DIR } from '../../config.js';
import { wakeContainer } from '../../container-runner.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { cleanupCodingTaskInternal } from './delete-coding-task.js';
import type {
  FetchCommentsResult,
  MonitorRow,
  PrComment,
  PrMonitorDeps,
  PrStateInfo,
  WakePayload,
  WorkflowRun,
} from './pr-monitor.js';

const GH_TIMEOUT_MS = 15_000;

interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runGh(args: string[]): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, GH_TIMEOUT_MS);
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ code: -1, stdout, stderr: stderr || String(err), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

/**
 * `gh pr view` returns state + headRefOid (HEAD commit SHA) — both come
 * from one call. Returns null on failure / unexpected response.
 */
export async function fetchPrStateGh(repo: string, n: number): Promise<PrStateInfo | null> {
  const res = await runGh(['pr', 'view', String(n), '--repo', repo, '--json', 'state,headRefOid']);
  if (res.code !== 0) {
    log.warn('pr-monitor: gh pr view failed', {
      repo,
      pr: n,
      code: res.code,
      stderr: res.stderr.slice(0, 500),
      timedOut: res.timedOut,
    });
    return null;
  }
  let parsed: { state?: string; headRefOid?: string };
  try {
    parsed = JSON.parse(res.stdout) as { state?: string; headRefOid?: string };
  } catch (err) {
    log.warn('pr-monitor: gh pr view returned non-JSON body', { repo, pr: n, err: String(err) });
    return null;
  }
  const state = parsed.state;
  const headSha = parsed.headRefOid;
  if (!headSha || (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED')) {
    log.warn('pr-monitor: gh pr view returned unexpected payload', { repo, pr: n, parsed });
    return null;
  }
  return { state, headSha };
}

/**
 * Fetch GitHub Actions workflow runs whose `head_sha` matches the PR's
 * current HEAD. Returns `null` for transient errors (caller preserves the
 * surfaced-run cache and retries next tick); returns `[]` on success with
 * zero matching runs.
 */
export async function fetchWorkflowRunsGh(repo: string, headSha: string): Promise<WorkflowRun[] | null> {
  const res = await runGh([
    'api',
    `repos/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=50`,
    '--jq',
    '[.workflow_runs[] | {id, name, head_sha, status, conclusion, html_url}]',
  ]);
  if (res.code !== 0) {
    log.warn('pr-monitor: fetchWorkflowRuns gh api failed', {
      repo,
      headSha,
      code: res.code,
      stderr: res.stderr.slice(0, 500),
      timedOut: res.timedOut,
    });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout || '[]');
  } catch (err) {
    log.warn('pr-monitor: fetchWorkflowRuns returned non-JSON body', { repo, headSha, err: String(err) });
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return (parsed as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    name: typeof r.name === 'string' ? r.name : '(unnamed)',
    head_sha: typeof r.head_sha === 'string' ? r.head_sha : headSha,
    status: (r.status as WorkflowRun['status']) ?? 'completed',
    conclusion: typeof r.conclusion === 'string' ? r.conclusion : null,
    html_url: typeof r.html_url === 'string' ? r.html_url : '',
  }));
}

const LOG_DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * Download failed-step logs for a workflow run into the agent group's
 * `ci-logs/` folder (RW mounted at `/nanoclaw-group/` inside the
 * container). Uses `gh run view --log-failed` so the file is plain text
 * scoped to failed steps only — much smaller than the raw zip from
 * `actions/runs/{id}/logs` and trivially grep-able by the agent.
 */
export async function downloadWorkflowLogsGh(
  repo: string,
  runId: number,
  agentGroupId: string,
): Promise<{ logPath: string } | { error: string }> {
  const group = getAgentGroup(agentGroupId);
  if (!group) return { error: 'agent_group not found' };

  const logsDir = path.join(GROUPS_DIR, group.folder, 'ci-logs');
  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch (err) {
    return { error: `mkdir failed: ${(err as Error).message}` };
  }
  const filename = `${runId}-failed.log`;
  const hostPath = path.join(logsDir, filename);

  const res = await new Promise<ShellResult>((resolve) => {
    const child = spawn('gh', ['run', 'view', String(runId), '--repo', repo, '--log-failed'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, LOG_DOWNLOAD_TIMEOUT_MS);
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ code: -1, stdout, stderr: stderr || String(err), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });

  if (res.code !== 0) {
    return {
      error: `gh run view --log-failed exit ${res.code}${res.timedOut ? ' (timed out)' : ''}: ${res.stderr.slice(0, 200)}`,
    };
  }

  try {
    fs.writeFileSync(hostPath, res.stdout);
  } catch (err) {
    return { error: `write failed: ${(err as Error).message}` };
  }

  // The container sees the agent group dir at `/nanoclaw-group/` (mounted
  // RW by `src/container-runner.ts`), so translate the host absolute path
  // into that container-relative form for the agent.
  return { logPath: `/nanoclaw-group/ci-logs/${filename}` };
}

/**
 * Parse the `gh api -i` raw HTTP response. The `-i` flag prepends the
 * status line + headers before the body. We do a single split on the
 * first blank line to separate header block from body.
 */
function parseGhApiResponse(raw: string): { status: number; headers: Record<string, string>; body: string } {
  // Normalise CRLF before splitting — gh emits CRLF on Linux too.
  const normalised = raw.replace(/\r\n/g, '\n');
  const headerEnd = normalised.indexOf('\n\n');
  if (headerEnd === -1) {
    return { status: 0, headers: {}, body: normalised };
  }
  const headerBlock = normalised.slice(0, headerEnd);
  const body = normalised.slice(headerEnd + 2);

  const lines = headerBlock.split('\n');
  const statusLine = lines.shift() ?? '';
  // `HTTP/2.0 304 Not Modified` or `HTTP/1.1 200 OK`
  const statusMatch = /^HTTP\/[\d.]+\s+(\d+)/.exec(statusLine);
  const status = statusMatch ? Number(statusMatch[1]) : 0;

  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[key] = value;
  }
  return { status, headers, body };
}

interface RawIssueComment {
  id: number;
  user: { login: string } | null;
  body: string | null;
  updated_at: string;
  html_url: string;
}
interface RawReviewComment extends RawIssueComment {
  path?: string;
}

function mapIssueComment(c: RawIssueComment): PrComment {
  return {
    id: c.id,
    user: { login: c.user?.login ?? 'unknown' },
    body: c.body ?? '',
    updated_at: c.updated_at,
    html_url: c.html_url,
    source: 'issue',
  };
}

function mapReviewComment(c: RawReviewComment): PrComment {
  return {
    id: c.id,
    user: { login: c.user?.login ?? 'unknown' },
    body: c.body ?? '',
    updated_at: c.updated_at,
    path: c.path,
    html_url: c.html_url,
    source: 'review',
  };
}

/**
 * Fetch issue or review comments for a PR with ETag short-circuit.
 *
 * GitHub returns 304 for `If-None-Match` matches — we propagate that as
 * `{ notModified: true }` so the poller can skip dedupe entirely. On 200
 * we return the new ETag and parsed comments.
 *
 * The poller treats `throw` as "transient — preserve etag, retry next
 * tick", so we throw on every non-304 / non-200 outcome rather than
 * returning a sentinel.
 */
export async function fetchCommentsGh(
  repo: string,
  n: number,
  source: 'issue' | 'review',
  etag: string | null,
): Promise<FetchCommentsResult> {
  const path = source === 'issue' ? `repos/${repo}/issues/${n}/comments` : `repos/${repo}/pulls/${n}/comments`;
  const args = ['api', '-i', path];
  if (etag) {
    args.push('-H', `If-None-Match: ${etag}`);
  }
  const res = await runGh(args);

  if (res.code !== 0 && res.timedOut) {
    throw new Error(`gh api ${path} timed out after ${GH_TIMEOUT_MS}ms`);
  }
  // gh exits non-zero on 304 (it considers it an error). Parse the body
  // either way — the status line is in stdout.
  const parsed = parseGhApiResponse(res.stdout);
  if (parsed.status === 304) {
    return { notModified: true };
  }
  if (parsed.status !== 200) {
    throw new Error(`gh api ${path} returned HTTP ${parsed.status} (exit ${res.code}): ${res.stderr.slice(0, 200)}`);
  }

  const newEtag = parsed.headers['etag'];
  if (!newEtag) {
    // No ETag returned — propagate empty string so we still update column;
    // next tick will re-fetch without If-None-Match.
    log.warn('pr-monitor: gh api returned 200 without ETag header', { repo, pr: n, source });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(parsed.body);
  } catch (err) {
    throw new Error(`gh api ${path} returned non-JSON body: ${(err as Error).message}`);
  }
  if (!Array.isArray(raw)) {
    throw new Error(`gh api ${path} returned non-array body`);
  }

  const comments: PrComment[] =
    source === 'issue'
      ? (raw as RawIssueComment[]).map(mapIssueComment)
      : (raw as RawReviewComment[]).map(mapReviewComment);

  return { etag: newEtag ?? '', comments };
}

/**
 * Format a fresh-comments wake message as a human-readable preamble plus
 * a structured payload block. The agent reads the preamble and acts on
 * the structured payload; the structured form makes it cheap to extract
 * file paths + comment ids without re-parsing prose.
 *
 * When the host has just observed MERGED / CLOSED, `payload.terminal` is
 * set and the message is a terminal-wake instruction: it tells the agent
 * to call `mcp__nanoclaw__delete_coding_task` so the cost summary is
 * emitted from inside the container before the host's grace-period
 * fallback kicks in. Terminal wakes always carry empty `comments` /
 * `ci_failures` because the poller short-circuits both fetches once it
 * sees terminal state. `ticketId`, when known, is interpolated into the
 * tool-call snippet so the agent has a copy-pasteable invocation.
 */
export function formatWakeMessage(payload: WakePayload, ticketId?: string | null): string {
  if (payload.terminal) {
    return formatTerminalWakeMessage(payload, ticketId);
  }

  const ciFailures = payload.ci_failures ?? [];
  const counts: string[] = [];
  if (payload.comments.length > 0) {
    counts.push(`${payload.comments.length} review comment${payload.comments.length === 1 ? '' : 's'}`);
  }
  if (ciFailures.length > 0) {
    counts.push(`${ciFailures.length} CI failure${ciFailures.length === 1 ? '' : 's'}`);
  }
  const summary = counts.length > 0 ? counts.join(' + ') : 'an update';
  const header = `PR #${payload.pr_number} in ${payload.repo} — ${summary} to address.\n`;

  const sections: string[] = [];

  if (ciFailures.length > 0) {
    const ciBlocks = ciFailures.map((f) => {
      const logLine = f.log_path
        ? `Failed-step logs: ${f.log_path}`
        : `Logs unavailable on host (${f.log_error ?? 'unknown error'}); fetch with \`gh run view ${f.run_id} --repo ${payload.repo} --log-failed\``;
      return `[CI FAILURE] ${f.name} (run #${f.run_id})\nConclusion: ${f.conclusion}\nURL: ${f.html_url}\n${logLine}`;
    });
    sections.push(ciBlocks.join('\n\n'));
  }

  if (payload.comments.length > 0) {
    const blocks = payload.comments.map((c) => {
      const pathLabel = c.path ? c.path : '(general)';
      return `[${c.kind}] #${c.id} by ${c.author} — ${pathLabel}\n> ${c.body.replace(/\n/g, '\n> ')}\n${c.html_url}`;
    });
    sections.push(blocks.join('\n\n'));
  }

  return `${header}\n${sections.join('\n\n')}\n\nAddress per the PR Monitor Workflow in CLAUDE.md.`;
}

/**
 * Render the structured terminal-wake block. The caller resolves the
 * ticket id from the agent group's folder (`coding_<ticket-lower>`); we
 * just interpolate it into the tool-call snippet. Falls back to the
 * literal `<TICKET>` placeholder when the caller can't resolve it — the
 * agent already knows the ticket id from its own state and will fill in
 * the right value.
 */
function formatTerminalWakeMessage(payload: WakePayload, ticketId?: string | null): string {
  const t = payload.terminal!;
  const verb = t.reason === 'merged' ? 'merged' : 'closed without merge';
  const header = `[TERMINAL] PR #${payload.pr_number} in ${payload.repo} — ${verb} (state=${t.state}).`;
  const idArg = ticketId && ticketId.trim().length > 0 ? ticketId : '<TICKET>';
  const action =
    t.reason === 'merged'
      ? `Call \`mcp__nanoclaw__delete_coding_task({ ticket_id: "${idArg}" })\` immediately so your in-container cost summary is emitted to the PR before teardown.`
      : `Call \`mcp__nanoclaw__delete_coding_task({ ticket_id: "${idArg}" })\` immediately to emit your in-container cost summary; the branch will be preserved on the remote as a backup.`;
  const fallback =
    'If you do not call delete_coding_task within the host grace period (5 minutes), the host runs the cleanup itself and the cost summary is lost — in-container telemetry is unreachable from outside. Calling it twice is safe; the second call is a no-op.';
  return `${header}\n\n${action}\n\n${fallback}`;
}

/**
 * Recover the ticket id from an agent group's folder name. The
 * coding-task creation flow always uses `coding_<ticket-lower>`. Returns
 * null if the folder doesn't match — the caller falls back to the
 * `<TICKET>` placeholder in the formatted message.
 */
function ticketIdFromAgentGroupFolder(agentGroupId: string): string | null {
  const group = getAgentGroup(agentGroupId);
  if (!group) return null;
  if (!group.folder.startsWith('coding_')) return null;
  const lower = group.folder.slice('coding_'.length);
  return lower.length > 0 ? lower.toUpperCase() : null;
}

/**
 * Resolve a session for the monitor and write a wake message into its
 * inbound.db, then ping the container. Mirrors the routing path
 * `src/router.ts` uses for normal inbound messages.
 *
 * Session mode is `shared` — PR monitor wakes are not thread-scoped at
 * the SQLite level even when a thread_id is set, because the same agent
 * group should keep one session per PR-task regardless of where the
 * monitor message is delivered.
 */
export async function wakeAgentForMonitor(monitor: MonitorRow, payload: WakePayload): Promise<void> {
  const { session, created } = resolveSession(
    monitor.agent_group_id,
    monitor.messaging_group_id,
    monitor.thread_id,
    'shared',
  );

  const messageId = `pr-monitor-${monitor.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Terminal wakes interpolate the ticket id into the tool-call snippet;
  // for non-terminal wakes the second arg is ignored so the lookup is
  // wasted work — gate it behind `payload.terminal` to avoid the DB hit.
  const ticketId = payload.terminal ? ticketIdFromAgentGroupFolder(monitor.agent_group_id) : null;
  const text = formatWakeMessage(payload, ticketId);

  writeSessionMessage(session.agent_group_id, session.id, {
    id: messageId,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    // Carry routing so the agent's reply lands back on the same thread.
    platformId: null,
    channelType: null,
    threadId: monitor.thread_id,
    content: JSON.stringify({
      text,
      sender: 'pr-monitor',
      senderId: 'pr-monitor',
      // Structured payload alongside the human-readable text — handy for
      // the agent to extract programmatically without parsing prose.
      pr_monitor: payload,
    }),
  });

  const fresh = getSession(session.id) ?? session;
  await wakeContainer(fresh);

  log.info('pr-monitor: woke session', {
    monitorId: monitor.id,
    sessionId: session.id,
    sessionCreated: created,
    freshCount: payload.comments.length,
    ciFailureCount: payload.ci_failures?.length ?? 0,
    terminal: payload.terminal ? payload.terminal.state : null,
  });
}

/**
 * Terminal-state cleanup driver. Called by `pollOneMonitor` when a PR
 * transitions to MERGED/CLOSED.
 *
 * The agent's CLAUDE.md tells it to call `delete_coding_task` itself when it
 * observes a terminal PR — that path emits the cost summary first. This is
 * the host-side safety net for the (common) case where the agent is idle
 * when the PR is merged and never observes the transition. We do a direct
 * teardown via `cleanupCodingTaskInternal` and accept losing the cost
 * summary — the in-container JSONL log is unreachable from the host.
 *
 * The agent_group's folder follows the `coding_<ticket-lower>` convention
 * established in `create-coding-task.ts`; we strip the prefix to recover
 * the ticket id used by `cleanupCodingTaskInternal` for the channel name
 * pattern fallback.
 */
export async function cleanupCodingTaskOnTerminal(agentGroupId: string, reason: 'merged' | 'abandoned'): Promise<void> {
  const group = getAgentGroup(agentGroupId);
  if (!group) {
    log.warn('pr-monitor terminal cleanup: agent_group not found — nothing to do', { agentGroupId, reason });
    return;
  }
  if (!group.folder.startsWith('coding_')) {
    log.warn(
      'pr-monitor terminal cleanup: agent_group folder does not match coding_ prefix — refusing to derive ticketId',
      {
        agentGroupId,
        folder: group.folder,
      },
    );
    return;
  }
  const ticketId = group.folder.slice('coding_'.length);
  try {
    const result = await cleanupCodingTaskInternal({ agentGroupId, ticketId, reason });
    log.info('pr-monitor terminal cleanup: completed', {
      agentGroupId,
      ticketId,
      reason,
      archivedChannelIds: result.archivedChannelIds,
    });
  } catch (err) {
    log.error('pr-monitor terminal cleanup: cleanupCodingTaskInternal threw', {
      agentGroupId,
      ticketId,
      reason,
      err,
    });
  }
}

export function buildPrMonitorDeps(): PrMonitorDeps {
  return {
    db: getDb(),
    fetchPrState: fetchPrStateGh,
    fetchComments: fetchCommentsGh,
    fetchWorkflowRuns: fetchWorkflowRunsGh,
    downloadWorkflowLogs: downloadWorkflowLogsGh,
    wakeAgent: wakeAgentForMonitor,
    cleanupCodingTask: cleanupCodingTaskOnTerminal,
    log,
  };
}
