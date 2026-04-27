/**
 * Cost summary delivery action handler.
 *
 * The container-side agent writes a `messages_out` row with kind='system' and
 * action='coding_cost_summary' on task completion. The container has already
 * aggregated its own per-result JSONL log (no shared filesystem in v2 — the
 * host can't read in-container files), so the payload arrives ready-to-render:
 *
 *   {
 *     action: 'coding_cost_summary',
 *     ticketId: string,                     // user-facing task id (e.g. ANCR-107)
 *     reason: 'merged' | 'abandoned',
 *     assistantName: string,
 *     summary: CostSummary,                 // pre-aggregated by the container
 *     rtkGain?: string | null,              // optional rtk-gain text
 *     repo?: string,                        // 'owner/name' — for `gh pr comment`
 *     prNumber?: number,                    // PR to attach the comment to
 *     repoMasterPath?: string,              // cwd for the gh CLI (host worktree path)
 *   }
 *
 * On receipt the host:
 *   1. Renders two flavours of markdown — `target: 'slack'` (code-fenced
 *      table) and `target: 'github'` (raw markdown table).
 *   2. Posts the channel flavour back to the originating messaging group via
 *      the registered delivery adapter.
 *   3. If `repo` + `prNumber` are present, posts the github flavour as a PR
 *      comment via `gh pr comment <pr> --repo <repo> --body-file -`.
 *
 * Both legs are best-effort and isolated — Slack failure does not skip the
 * PR comment, and gh failure does not throw past the handler boundary.
 *
 * v1 reference: `~/repos/nanoclaw/src/coding-cost-summary.ts`. The v1 `gh pr
 * list --head <branch>` lookup is dropped — the agent now knows its own PR
 * number directly (it opened the PR), so the host doesn't need to re-derive
 * it from a branch name. `aggregateCostLog` is also dropped from the host
 * surface; the container does its own aggregation. Both helpers stay
 * exported below as pure functions in case callers want them.
 */
import { execFileSync } from 'child_process';
import type Database from 'better-sqlite3';

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
