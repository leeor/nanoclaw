export interface AgentProvider {
  /**
   * True if the provider's underlying SDK handles slash commands natively and
   * wants them passed through as raw text. When false, the poll-loop formats
   * slash commands like any other chat message.
   */
  readonly supportsNativeSlashCommands: boolean;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /**
   * True if the given error indicates the stored continuation is invalid
   * (missing transcript, unknown session, etc.) and should be cleared.
   */
  isSessionInvalid(err: unknown): boolean;
}

/**
 * Options passed to provider constructors. Fields are common to most
 * providers; individual providers may ignore any they don't need.
 */
export interface ProviderOptions {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
  /**
   * Default model id (e.g. `claude-opus-4-7`, `claude-sonnet-4-6`). Used when
   * a per-query model is not specified. Undefined → provider's own default
   * (Claude Code CLI default for the Claude provider).
   */
  model?: string;
}

export interface QueryInput {
  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

  /**
   * Opaque continuation token from a previous query. The provider decides
   * what this means (session ID, thread ID, nothing at all).
   */
  continuation?: string;

  /** Working directory inside the container. */
  cwd: string;

  /**
   * System context to inject. Providers translate this into whatever their
   * SDK expects (preset append, full system prompt, per-turn injection…).
   */
  systemContext?: {
    instructions?: string;
  };

  /**
   * Per-query model override. Takes precedence over the provider's default
   * model. Set by the poll-loop from `session_state.agent_model` (set via the
   * `set_model` MCP tool) or from `NANOCLAW_DEFAULT_MODEL`.
   */
  model?: string;
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AgentQuery {
  /** Push a follow-up message into the active query. */
  push(message: string): void;

  /** Signal that no more input will be sent. */
  end(): void;

  /** Output event stream. */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query. */
  abort(): void;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'result'; text: string | null }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  /**
   * Liveness signal. Providers MUST yield this on every underlying SDK
   * event (tool call, thinking, partial message, anything) so the
   * poll-loop's idle timer stays honest during long tool runs.
   */
  | { type: 'activity' }
  /**
   * Per-turn usage + cost metadata, emitted alongside `result`. Optional
   * for providers that don't expose token usage. The poll-loop appends
   * this to outbound.db's `cost_log` table for the host to aggregate on
   * coding-task cleanup. Fields mirror the SDK result message; modelUsage
   * is keyed by model id with per-model token + cost breakdown.
   */
  | {
      type: 'result_meta';
      sessionId: string | null;
      subtype: string | null;
      durationMs: number | null;
      numTurns: number | null;
      totalCostUsd: number | null;
      modelUsage: Record<
        string,
        {
          inputTokens: number;
          outputTokens: number;
          cacheReadInputTokens: number;
          cacheCreationInputTokens: number;
          costUSD: number;
        }
      >;
    };
