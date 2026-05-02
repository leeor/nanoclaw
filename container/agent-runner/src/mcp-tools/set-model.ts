/**
 * `set_model` MCP tool.
 *
 * Lets the agent switch the active Claude model for the current session.
 * Three behaviors:
 *
 *   1. Plain switch (`{ model }`): persist the new model id to
 *      `session_state.agent_model`. Takes effect on the next turn — the
 *      poll-loop reads the stored model when it spawns the next provider
 *      query. The current turn finishes on the old model.
 *
 *   2. Fresh session (`{ model, freshSession: true, context: '...' }`):
 *      persist the new model, clear the provider continuation (so the
 *      next query starts a clean SDK session), park the supplied
 *      `context` as a pending handoff prompt, and raise the restart flag
 *      so the poll-loop's inner tick aborts the in-flight query. The
 *      next outer iteration sees the handoff and runs a brand-new query
 *      whose only prompt is the handoff brief — the planning context
 *      does not carry over (which is the whole point — it would
 *      otherwise fill the new session's context window for free).
 *
 * The MCP server runs in a separate process from the poll-loop, so
 * every signal here flows through `session_state` (outbound.db, which
 * the container owns). See `db/session-state.ts` for the storage keys.
 *
 * `clearContinuation` needs the provider name, which the MCP subprocess
 * receives via `NANOCLAW_PROVIDER_NAME` (set by `index.ts` when it
 * registers the nanoclaw MCP server config).
 */
import {
  clearContinuation,
  setModel,
  setPendingHandoff,
  setRestartFlag,
} from '../db/session-state.js';
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

const ALLOWED_MODELS = new Set([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]);

export const setModelTool: McpToolDefinition = {
  tool: {
    name: 'set_model',
    description:
      'Switch the active Claude model for this agent session. With `freshSession: true` and a `context` brief, clears the conversation continuation and uses `context` as the next prompt — used at the planning→implementation handoff so the planning context does not carry over.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        model: {
          type: 'string',
          description: 'Target model id (e.g. claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5)',
        },
        freshSession: {
          type: 'boolean',
          description: 'If true, start a fresh session: clear the provider continuation and use `context` as the next prompt.',
        },
        context: {
          type: 'string',
          description: 'Self-contained handoff brief used as the next prompt when freshSession is true.',
        },
      },
      required: ['model'],
    },
  },
  async handler(args) {
    const model = args.model as string | undefined;
    if (!model) return err('model is required');
    if (!ALLOWED_MODELS.has(model)) {
      return err(`unknown model "${model}" — valid: ${[...ALLOWED_MODELS].join(', ')}`);
    }

    setModel(model);

    if (!args.freshSession) {
      log(`set_model: ${model} (next-turn switch, continuation preserved)`);
      return ok(`Model set to ${model}. Will take effect on the next turn.`);
    }

    const context = (args.context as string | undefined)?.trim();
    if (!context) {
      return err('freshSession=true requires a `context` handoff brief — the new session starts with NO prior memory and needs the brief as its first prompt.');
    }

    const providerName = process.env.NANOCLAW_PROVIDER_NAME;
    if (!providerName) {
      return err('NANOCLAW_PROVIDER_NAME not set in MCP environment — cannot clear continuation. The agent-runner must inject it when registering the nanoclaw MCP server.');
    }

    clearContinuation(providerName);
    setPendingHandoff(context);
    setRestartFlag();

    log(`set_model: ${model} (freshSession; continuation cleared, handoff queued)`);
    return ok(
      `Model set to ${model} and fresh session queued. The current turn will be aborted and a new session will start with your handoff context as its first prompt.`,
    );
  },
};

registerTools([setModelTool]);
