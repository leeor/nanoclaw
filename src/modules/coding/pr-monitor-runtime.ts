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

import { getDb } from '../../db/connection.js';
import { wakeContainer } from '../../container-runner.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import type {
  FetchCommentsResult,
  MonitorRow,
  PrComment,
  PrMonitorDeps,
  PrState,
  WakePayload,
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

/** `gh pr view` returns the state in `.state`. Returns null on failure / unexpected. */
export async function fetchPrStateGh(repo: string, n: number): Promise<PrState | null> {
  const res = await runGh(['pr', 'view', String(n), '--repo', repo, '--json', 'state', '--jq', '.state']);
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
  const state = res.stdout.trim();
  if (state === 'OPEN' || state === 'MERGED' || state === 'CLOSED') return state;
  log.warn('pr-monitor: gh pr view returned unexpected state', { repo, pr: n, state });
  return null;
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
    throw new Error(
      `gh api ${path} returned HTTP ${parsed.status} (exit ${res.code}): ${res.stderr.slice(0, 200)}`,
    );
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
 */
export function formatWakeMessage(payload: WakePayload): string {
  const header = `PR #${payload.pr_number} in ${payload.repo} — ${payload.comments.length} review comment${
    payload.comments.length === 1 ? '' : 's'
  } to address.\n`;
  const blocks = payload.comments.map((c) => {
    const pathLabel = c.path ? c.path : '(general)';
    return `[${c.kind}] #${c.id} by ${c.author} — ${pathLabel}\n> ${c.body.replace(/\n/g, '\n> ')}\n${c.html_url}`;
  });
  return `${header}\n${blocks.join('\n\n')}\n\nAddress per the PR Monitor Workflow in CLAUDE.md.`;
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
  const text = formatWakeMessage(payload);

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

  log.info('pr-monitor: woke session for fresh comments', {
    monitorId: monitor.id,
    sessionId: session.id,
    sessionCreated: created,
    freshCount: payload.comments.length,
  });
}

/**
 * Stub cleanup hook. Sub-task 9 will replace this with a proper
 * graceful-shutdown call into the coding session. Until then the orphan
 * scanner reconciles stranded devcontainers, so the only thing this hook
 * actually needs to do today is record intent. Wire-through is preserved
 * so swapping in the real impl is a one-line change in `buildPrMonitorDeps`.
 */
export async function cleanupCodingTaskStub(
  agentGroupId: string,
  reason: 'merged' | 'abandoned',
): Promise<void> {
  log.info('pr-monitor: cleanupCodingTask stub (sub-task 9 will implement)', {
    agentGroupId,
    reason,
  });
}

export function buildPrMonitorDeps(): PrMonitorDeps {
  return {
    db: getDb(),
    fetchPrState: fetchPrStateGh,
    fetchComments: fetchCommentsGh,
    wakeAgent: wakeAgentForMonitor,
    cleanupCodingTask: cleanupCodingTaskStub,
    log,
  };
}
