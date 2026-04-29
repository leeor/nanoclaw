/**
 * Coding-task MCP tool: create_coding_task.
 *
 * Spawns a per-task coding agent in a fresh git worktree backed by a
 * devcontainer. The host handler in `src/modules/coding/create-coding-task.ts`:
 *   1. Translates `repo_master_path` (caller's container path) to a host
 *      path via the caller's mounts.
 *   2. Adds a git worktree at `<repo_dir>/<ticket-lower>` on a new branch.
 *   3. Creates a sibling agent_group `coding_<ticket-lower>` with
 *      `containerBackend: devcontainer` + `devcontainerConfig.workspaceFolder`
 *      pointing at the worktree.
 *   4. Creates bidirectional agent_destinations rows (parent ↔ child).
 *   5. Sends `context` (and optional plan) as the first chat message to
 *      the new session.
 *
 * Admin-only — see filtering in mcp-tools/index.ts.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const createCodingTask: McpToolDefinition = {
  tool: {
    name: 'create_coding_task',
    description:
      'Spawn a per-task coding agent in a fresh git worktree with a devcontainer. Creates a sibling agent group named coding_<ticket-id> with bidirectional parent-child destinations, and sends `context` (and optional plan_path) as the first message. Admin-only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticket_id: {
          type: 'string',
          description: 'Ticket/issue ID (e.g. "ANCR-919"). Used as branch name + folder suffix (lowercased).',
        },
        repo_master_path: {
          type: 'string',
          description: 'Path to the repo master worktree, as seen from your container (e.g. /workspace/extra/repos/mono/master).',
        },
        context: {
          type: 'string',
          description: 'Ticket title, requirements, background. Sent as the first chat message to the new coding agent.',
        },
        plan_path: {
          type: 'string',
          description: 'Optional absolute container path to a committed plan file. If set, the coding agent skips the design step.',
        },
        base_branch: {
          type: 'string',
          description: 'Branch / ref to base the new worktree on. Defaults to "origin/last-green" (the green-CI baseline). Pass a specific ref like "origin/main" or "origin/release-2026-04" to override.',
        },
      },
      required: ['ticket_id', 'repo_master_path'],
    },
  },
  async handler(args) {
    const ticketId = typeof args.ticket_id === 'string' ? args.ticket_id.trim() : '';
    const repoMasterPath = typeof args.repo_master_path === 'string' ? args.repo_master_path.trim() : '';
    const context = typeof args.context === 'string' ? args.context : '';
    const planPath = typeof args.plan_path === 'string' ? args.plan_path : null;
    const baseBranch = typeof args.base_branch === 'string' && args.base_branch.trim() ? args.base_branch.trim() : null;

    if (!ticketId) return err('ticket_id is required');
    if (!repoMasterPath) return err('repo_master_path is required');
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(ticketId)) {
      return err('ticket_id must be alphanumeric (with -/_), starting with a letter, ≤64 chars');
    }

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'create_coding_task',
        requestId,
        ticket_id: ticketId,
        repo_master_path: repoMasterPath,
        context,
        plan_path: planPath,
        base_branch: baseBranch,
      }),
    });

    log(`create_coding_task: ${requestId} → "${ticketId}" (${repoMasterPath})`);
    return ok(`Spawning coding task for ${ticketId}. The agent will report back when ready.`);
  },
};

export const deleteCodingTask: McpToolDefinition = {
  tool: {
    name: 'delete_coding_task',
    description:
      'Delete a coding-task agent group: stop the devcontainer, archive the Slack channel, remove the worktree + branch, drop OneCLI agent, and clean up DB rows. Use after the task is done or if a previous spawn left state behind. Admin-only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticket_id: {
          type: 'string',
          description: 'Ticket/issue ID matching the original create_coding_task call (case-insensitive).',
        },
      },
      required: ['ticket_id'],
    },
  },
  async handler(args) {
    const ticketId = typeof args.ticket_id === 'string' ? args.ticket_id.trim() : '';
    if (!ticketId) return err('ticket_id is required');
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(ticketId)) {
      return err(`invalid ticket_id "${ticketId}"`);
    }

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'delete_coding_task',
        requestId,
        ticket_id: ticketId,
      }),
    });

    log(`delete_coding_task: ${requestId} → "${ticketId}"`);
    return ok(`Cleaning up coding task ${ticketId}. You'll be notified when it's done.`);
  },
};

registerTools([createCodingTask, deleteCodingTask]);
