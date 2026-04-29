/**
 * `monitor_pr` MCP tool — register a deterministic, host-driven poller
 * for a pull request.
 *
 * The agent calls this once per PR it cares about. The host then polls
 * `gh pr view`, comments (with ETag fast-path 304s), AND failed GitHub
 * Actions workflow runs on its own, and only wakes this session when
 * something the agent needs to act on arrives:
 *
 *   - fresh non-noise comments,
 *   - a freshly-failed workflow run on the PR's HEAD SHA (failed-step
 *     logs pre-downloaded to `/nanoclaw-group/ci-logs/<run_id>-failed.log`),
 *   - terminal PR state (MERGED / CLOSED) — the monitor sends a
 *     `[TERMINAL]` wake instructing the agent to call
 *     `delete_coding_task` so the cost summary is emitted from inside
 *     the container before teardown. After ~5 min of no response the
 *     host runs the cleanup itself and the cost summary is lost.
 *
 * Mechanics: write a kind='system' message to outbound.db with
 * action='register_pr_monitor'. The host's delivery loop sees it and
 * calls into `src/modules/coding/index.ts`, which inserts a row into
 * `coding_pr_monitors`. Idempotent server-side on
 * (agent_group, repo, pr_number, status='active').
 */
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const monitorPr: McpToolDefinition = {
  tool: {
    name: 'monitor_pr',
    description:
      'Start a deterministic poll of a GitHub pull request. The host polls comments, failed GitHub Actions workflow runs, AND PR state on its own, downloads failed-step logs to `/nanoclaw-group/ci-logs/<run_id>-failed.log`, and only wakes you when something new arrives — fresh comments, CI failures, or terminal PR state (MERGED / CLOSED). Quiescent PRs cost zero tokens. On terminal state the wake message is prefixed `[TERMINAL]` and tells you to call `delete_coding_task` immediately so the cost summary is emitted before teardown. Idempotent: calling this twice for the same PR returns the same monitor.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        pr_number: {
          type: 'number',
          description: 'PR number (e.g. 1758).',
        },
        repo: {
          type: 'string',
          description: 'GitHub repo in "owner/name" form (e.g. "anchor-g/mono").',
        },
        interval_ms: {
          type: 'number',
          description:
            'Optional polling interval in milliseconds. Default 60000 (60 s). Use longer intervals (300000 = 5 min) for low-traffic PRs to reduce GitHub API spend.',
        },
      },
      required: ['pr_number', 'repo'],
    },
  },
  async handler(args) {
    const prNumber = args.pr_number;
    const repo = args.repo as string | undefined;
    const intervalMs = args.interval_ms;

    if (typeof prNumber !== 'number' || !Number.isInteger(prNumber) || prNumber <= 0) {
      return err('pr_number must be a positive integer');
    }
    if (!repo || typeof repo !== 'string' || !repo.includes('/')) {
      return err('repo must be in "owner/name" form');
    }
    if (intervalMs !== undefined && (typeof intervalMs !== 'number' || intervalMs < 5_000)) {
      return err('interval_ms, when provided, must be a number >= 5000');
    }

    const r = getSessionRouting();
    const id = `pr-monitor-req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeMessageOut({
      id,
      kind: 'system',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({
        action: 'register_pr_monitor',
        pr_number: prNumber,
        repo,
        interval_ms: intervalMs,
      }),
    });

    log(`monitor_pr: registered pr=${prNumber} repo=${repo}${intervalMs ? ` interval=${intervalMs}` : ''}`);
    return ok(
      `PR monitor registered for ${repo}#${prNumber}. The host will wake you when new review comments arrive, a CI workflow run fails, OR the PR transitions to MERGED/CLOSED — you don't need to poll yourself. Failed-step logs are pre-downloaded to /nanoclaw-group/ci-logs/<run_id>-failed.log. On terminal state the wake is prefixed [TERMINAL] and instructs you to call delete_coding_task so your cost summary is emitted before teardown.`,
    );
  },
};

registerTools([monitorPr]);
