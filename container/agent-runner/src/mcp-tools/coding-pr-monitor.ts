/**
 * `monitor_pr` MCP tool — register a deterministic, host-driven poller
 * for a pull request.
 *
 * The agent calls this once per PR it cares about. The host then polls
 * `gh pr view` + comments on its own (with ETag fast-path 304s) and
 * only wakes this session when fresh non-noise comments arrive — the
 * agent does NOT spend tokens on quiescent PRs.
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
      'Start a deterministic poll of a GitHub pull request. The host polls comments on its own and only wakes you when something new arrives — quiescent PRs cost zero tokens. Idempotent: calling this twice for the same PR returns the same monitor.',
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
      `PR monitor registered for ${repo}#${prNumber}. The host will wake you when new review comments arrive — you don't need to poll yourself.`,
    );
  },
};

registerTools([monitorPr]);
