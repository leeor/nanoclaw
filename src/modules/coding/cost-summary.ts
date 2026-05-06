/**
 * Cost summary — host-side aggregation + delivery.
 *
 * The container's poll-loop writes one row per SDK result message into the
 * session's outbound.db `cost_log` table (see
 * container/agent-runner/src/db/cost-log.ts). On coding-task cleanup the
 * host opens that DB read-only, calls `aggregateCostLog` to fold the rows
 * into a `CostSummary`, and posts the result via `postCostSummary` (channel
 * + PR comment, both best-effort).
 *
 * The legacy delivery-action handler `handleCostSummary` is still
 * registered for any caller that wants to push a pre-aggregated summary
 * via the messages_out path (e.g. an in-container MCP tool). Today the
 * primary trigger is host-driven from `cleanupCodingTaskInternal` —
 * the agent does not need to know it's about to be torn down.
 *
 * Payload shape for the delivery action variant:
 *
 *   {
 *     action: 'coding_cost_summary',
 *     ticketId: string,                     // user-facing task id
 *     reason: 'merged' | 'abandoned',
 *     assistantName: string,
 *     summary: CostSummary,                 // pre-aggregated
 *     rtkGain?: string | null,
 *     repo?: string,                        // 'owner/name'
 *     prNumber?: number,
 *     repoMasterPath?: string,              // cwd for `gh`
 *   }
 *
 * Both legs of `postCostSummary` are isolated — Slack failure does not
 * skip the PR comment, and `gh` failure does not throw past the handler
 * boundary.
 */
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';

import { getDeliveryAdapter } from '../../delivery.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

export interface AggregateModelStats {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

export interface CostSummary {
  totalCostUSD: number;
  totalDurationMs: number;
  totalTurns: number;
  resultCount: number;
  models: AggregateModelStats[];
  firstTs: string;
  lastTs: string;
}

export type CostSummaryTarget = 'github' | 'slack';

interface CostLogRow {
  ts: string;
  session_id: string | null;
  subtype: string | null;
  duration_ms: number | null;
  num_turns: number | null;
  total_cost_usd: number | null;
  model_usage: string;
}

interface RawModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

/**
 * Fold every cost_log row in the given outbound.db into a single
 * CostSummary. Returns null when the table is missing or empty —
 * callers should treat that as "no cost data available", not an error.
 *
 * Accepts an open DB handle so cleanup can keep its own readonly
 * connection scoped to the call site (see `aggregateCostLogFromPath`
 * for the path-based convenience wrapper).
 */
export function aggregateCostLog(db: Database.Database): CostSummary | null {
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cost_log'").get();
  if (!tableExists) return null;

  const rows = db
    .prepare(
      `SELECT ts, session_id, subtype, duration_ms, num_turns, total_cost_usd, model_usage
         FROM cost_log
         ORDER BY id ASC`,
    )
    .all() as CostLogRow[];
  if (rows.length === 0) return null;

  const perModel = new Map<string, AggregateModelStats>();
  let totalCostUSD = 0;
  let totalDurationMs = 0;
  let totalTurns = 0;
  let resultCount = 0;
  let firstTs: string | undefined;
  let lastTs: string | undefined;
  let skipped = 0;

  for (const row of rows) {
    let parsed: Record<string, RawModelUsage>;
    try {
      parsed = JSON.parse(row.model_usage) as Record<string, RawModelUsage>;
    } catch {
      skipped++;
      continue;
    }
    resultCount++;
    totalCostUSD += row.total_cost_usd ?? 0;
    totalDurationMs += row.duration_ms ?? 0;
    totalTurns += row.num_turns ?? 0;
    if (row.ts) {
      if (!firstTs || row.ts < firstTs) firstTs = row.ts;
      if (!lastTs || row.ts > lastTs) lastTs = row.ts;
    }
    for (const [model, u] of Object.entries(parsed)) {
      const acc = perModel.get(model) ?? {
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0,
      };
      acc.inputTokens += u.inputTokens ?? 0;
      acc.outputTokens += u.outputTokens ?? 0;
      acc.cacheReadInputTokens += u.cacheReadInputTokens ?? 0;
      acc.cacheCreationInputTokens += u.cacheCreationInputTokens ?? 0;
      acc.costUSD += u.costUSD ?? 0;
      perModel.set(model, acc);
    }
  }

  if (skipped > 0) log.warn('aggregateCostLog: skipped malformed model_usage rows', { skipped });
  if (resultCount === 0) return null;

  const models = Array.from(perModel.values()).sort((a, b) => b.costUSD - a.costUSD);
  return {
    totalCostUSD,
    totalDurationMs,
    totalTurns,
    resultCount,
    models,
    firstTs: firstTs ?? '',
    lastTs: lastTs ?? '',
  };
}

/**
 * Convenience wrapper: open the given outbound.db read-only, aggregate,
 * close. Returns null on any open / read failure (the file may not exist
 * for sessions that crashed before the container ever booted).
 */
export function aggregateCostLogFromPath(outboundDbPath: string): CostSummary | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(outboundDbPath, { readonly: true, fileMustExist: true });
    return aggregateCostLog(db);
  } catch (err) {
    log.warn('aggregateCostLogFromPath: failed to read outbound.db', {
      outboundDbPath,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    db?.close();
  }
}

function formatTokens(n: number): string {
  if (n >= 999_950) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function formatUSD(n: number): string {
  return `$${n.toFixed(2)}`;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * Pure markdown renderer. Slack target wraps the model table in a code
 * fence (Slack does not render markdown tables). GitHub target leaves the
 * table bare.
 */
export function formatCostSummary(
  summary: CostSummary,
  opts: {
    ticketId: string;
    reason: 'merged' | 'abandoned';
    assistantName: string;
    rtkGain?: string | null;
    target?: CostSummaryTarget;
  },
): string {
  const target: CostSummaryTarget = opts.target ?? 'github';

  const rows = summary.models
    .map(
      (m) =>
        `| ${m.model} | ${formatTokens(m.inputTokens)} | ${formatTokens(m.outputTokens)} | ${formatTokens(
          m.cacheReadInputTokens,
        )} | ${formatTokens(m.cacheCreationInputTokens)} | ${formatUSD(m.costUSD)} |`,
    )
    .join('\n');

  const tableLines = [
    '| Model | Input | Output | Cache read | Cache write | Cost |',
    '|-------|------:|-------:|-----------:|------------:|-----:|',
    rows,
  ];

  const tableBlock = target === 'slack' ? ['```', ...tableLines, '```'] : tableLines;

  const sections = [
    `## ${opts.assistantName} cost summary`,
    '',
    `**Task:** ${opts.ticketId} · **Status:** ${opts.reason}`,
    `**Duration:** ${formatDuration(summary.totalDurationMs)} · **Result messages:** ${summary.resultCount} · **Turns:** ${summary.totalTurns}`,
    `**Cost:** ~${formatUSD(summary.totalCostUSD)}`,
    '',
    ...tableBlock,
    '',
    '_Subscription users: notional API-equivalent cost, not an actual charge._',
  ];

  const rtkRaw = opts.rtkGain ? stripAnsi(opts.rtkGain).trim() : '';
  if (rtkRaw) {
    sections.push('', '## RTK token savings', '', '```', rtkRaw, '```');
  }

  return sections.join('\n');
}

/**
 * Shell-out shape for `rtk gain`. Injectable for tests.
 *
 * The savings we want to attribute belong to the coding agent's work,
 * which happens inside the per-task devcontainer. Running `rtk gain` on
 * the host returns the host operator's lifetime savings — unrelated to
 * this task. The default runner therefore execs `rtk gain` inside the
 * coding agent's devcontainer, located by the
 * `nanoclaw.agent-group=<id>` label that `container-runner` stamps on
 * every spawned container. Caller must invoke before the container is
 * stopped during cleanup.
 *
 * Best-effort: if `rtk` is not installed in the container, the docker
 * exec fails, or stdout is empty, the RTK section is omitted rather
 * than failing cleanup.
 */
export type RtkRunner = () => string;

/**
 * Build a runner that execs `rtk gain` inside the coding agent's
 * devcontainer (located by id-label). Container must still be running.
 */
export function containerRtkRunner(agentGroupId: string): RtkRunner {
  return () => {
    const ids = execFileSync('docker', ['ps', '-q', '--filter', `label=nanoclaw.agent-group=${agentGroupId}`], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    })
      .trim()
      .split('\n')
      .filter(Boolean);
    if (ids.length === 0) {
      throw new Error(`no running container for agent group ${agentGroupId}`);
    }
    return execFileSync('docker', ['exec', ids[0], 'rtk', 'gain'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
  };
}

/**
 * Run `rtk gain` and return the trimmed stdout, or null when the command
 * is unavailable / fails / produces no output. Never throws.
 */
export function captureRtkGain(runner: RtkRunner): string | null {
  try {
    const out = runner();
    const trimmed = (out ?? '').trim();
    return trimmed ? trimmed : null;
  } catch (err) {
    log.info('captureRtkGain: rtk gain unavailable — omitting RTK section', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Shell-out shape for `gh pr comment`. Injectable for tests.
 *
 * Args mirror the v1 signature so the existing test scenarios port over
 * with minimal change. The handler always invokes with
 * `['pr', 'comment', '<n>', '--repo', '<owner/name>', '--body-file', '-']`
 * and pipes the body via stdin.
 */
export type GhRunner = (args: string[], cwd: string | undefined, stdin: string) => string;

const defaultGhRunner: GhRunner = (args, cwd, stdin) => {
  return execFileSync('gh', args, {
    cwd,
    input: stdin,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
  });
};

/**
 * Channel-deliver shape. The handler resolves the channel adapter via the
 * delivery-adapter registry by default; tests pass a fake.
 */
export type SendChannelFn = (
  channelType: string,
  platformId: string,
  threadId: string | null,
  text: string,
) => Promise<void>;

const defaultSend: SendChannelFn = async (channelType, platformId, threadId, text) => {
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('coding_cost_summary: no delivery adapter — channel post skipped', { channelType });
    return;
  }
  // Wrap text into the same { text } envelope the rest of the system uses.
  await adapter.deliver(channelType, platformId, threadId, 'chat', JSON.stringify({ text }));
};

export interface PostCostSummaryOpts {
  slackMarkdown: string;
  githubMarkdown: string;
  /** Channel routing for the channel-side post. All three are required for delivery. */
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
  /** PR routing for the GitHub-side comment. Skip the comment when either is missing. */
  repo?: string;
  prNumber?: number;
  /** Optional cwd for `gh` (host worktree path). gh respects --repo, but cwd helps with auth context. */
  repoMasterPath?: string;
  sendChannel?: SendChannelFn;
  runGh?: GhRunner;
}

/**
 * Two-leg cost-summary post: channel adapter + PR comment. Both legs are
 * isolated — one failing does not skip or fail the other.
 */
export async function postCostSummary(opts: PostCostSummaryOpts): Promise<void> {
  const sendChannel = opts.sendChannel ?? defaultSend;
  const runGh = opts.runGh ?? defaultGhRunner;

  // Leg 1: channel post.
  if (opts.channelType && opts.platformId) {
    try {
      await sendChannel(opts.channelType, opts.platformId, opts.threadId, opts.slackMarkdown);
    } catch (err) {
      log.warn('coding_cost_summary: channel post failed', {
        channelType: opts.channelType,
        platformId: opts.platformId,
        err,
      });
    }
  } else {
    log.info('coding_cost_summary: no channel routing — skipping channel post');
  }

  // Leg 2: PR comment.
  if (!opts.repo || !opts.prNumber) {
    log.info('coding_cost_summary: no repo/prNumber — skipping PR comment');
    return;
  }
  try {
    runGh(
      ['pr', 'comment', String(opts.prNumber), '--repo', opts.repo, '--body-file', '-'],
      opts.repoMasterPath,
      opts.githubMarkdown,
    );
    log.info('coding_cost_summary: posted PR comment', { repo: opts.repo, prNumber: opts.prNumber });
  } catch (err) {
    log.warn('coding_cost_summary: PR comment failed', { repo: opts.repo, prNumber: opts.prNumber, err });
  }
}

interface CostSummaryPayload {
  ticketId?: string;
  taskId?: string;
  reason?: 'merged' | 'abandoned';
  assistantName?: string;
  summary?: CostSummary;
  rtkGain?: string | null;
  repo?: string;
  prNumber?: number;
  repoMasterPath?: string;
}

/**
 * Delivery-action handler. Resolves the originating messaging group from the
 * session and dispatches to `postCostSummary`. Failures log but do not
 * throw — a cost summary that fails to post must not stall the session's
 * outbound queue.
 */
export async function handleCostSummary(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const payload = content as CostSummaryPayload;
  const summary = payload.summary;
  if (!summary || typeof summary !== 'object') {
    log.warn('coding_cost_summary: missing summary in payload — skipping', { sessionId: session.id });
    return;
  }
  const ticketId = payload.ticketId ?? payload.taskId ?? session.id;
  const reason: 'merged' | 'abandoned' = payload.reason === 'abandoned' ? 'abandoned' : 'merged';
  const assistantName = payload.assistantName ?? 'Assistant';
  const rtkGain = payload.rtkGain ?? null;

  const githubMarkdown = formatCostSummary(summary, {
    ticketId,
    reason,
    assistantName,
    rtkGain,
    target: 'github',
  });
  const slackMarkdown = formatCostSummary(summary, {
    ticketId,
    reason,
    assistantName,
    rtkGain,
    target: 'slack',
  });

  // Resolve channel routing from the session's messaging group. Missing
  // messaging group → skip channel post; PR comment may still proceed.
  let channelType: string | null = null;
  let platformId: string | null = null;
  if (session.messaging_group_id) {
    const mg = getMessagingGroup(session.messaging_group_id);
    if (mg) {
      channelType = mg.channel_type;
      platformId = mg.platform_id;
    }
  }

  await postCostSummary({
    slackMarkdown,
    githubMarkdown,
    channelType,
    platformId,
    threadId: session.thread_id,
    repo: payload.repo,
    prNumber: payload.prNumber,
    repoMasterPath: payload.repoMasterPath,
  });
}
