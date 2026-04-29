/**
 * Per-group container config, stored as a plain JSON file at
 * `groups/<folder>/container.json`. Mounted read-only inside the container
 * at `/workspace/agent/container.json` — the runner reads it at startup but
 * cannot modify it. Config changes go through the self-mod approval flow.
 *
 * All fields are optional — a missing file or a partial file both resolve
 * to sensible defaults. Writes are atomic-enough (write-then-rename is not
 * worth the ceremony here since there's only one writer in practice: the
 * host, from the delivery thread that processes approved system actions).
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { readEnvFile } from './env.js';

export type McpServerConfig = McpStdioConfig | McpHttpConfig | McpSseConfig;

export interface McpStdioConfig {
  /** Optional discriminator. Omitted = stdio (back-compat). */
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Always-in-context guidance. When set, the host writes the content to
   * `.claude-fragments/mcp-<name>.md` at spawn and imports it into the
   * composed CLAUDE.md.
   */
  instructions?: string;
}

export interface McpHttpConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  instructions?: string;
}

export interface McpSseConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
  instructions?: string;
}

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/**
 * Per-repo entry in a parent agent's container.json `repos` registry.
 * Consumed by `create_coding_task` to resolve a friendly repo name to a
 * worktree path + sane defaults. See /add-coding-agent for the full schema.
 */
export interface CodingRepoConfig {
  /**
   * Path to the repo's master worktree, **as you see it from the parent's
   * container** (e.g. `repos/mono/master`). Leading `/workspace/extra/` is
   * implied — the path is appended to it. Must lie under one of this
   * config's `additionalMounts` so the host can translate it.
   */
  containerPath: string;
  /**
   * Default base ref the new worktree branches off when the caller does not
   * pass `base_branch`. Defaults to `origin/last-green` (mono parity) when
   * unset.
   */
  defaultBaseBranch?: string;
  /**
   * Override worktree placement. If set, the new worktree is created at
   * `<worktreeRoot>/<ticket-lower>` (host path) instead of as a sibling of
   * `containerPath`. Same translation rules as `containerPath` apply.
   */
  worktreeRoot?: string;
}

export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  /** Which skills to enable — array of skill names or "all" (default). */
  skills: string[] | 'all';
  /** Agent provider name (e.g. "claude", "opencode"). Default: "claude". */
  provider?: string;
  /** Agent group display name (used in transcript archiving). */
  groupName?: string;
  /** Assistant display name (used in system prompt / responses). */
  assistantName?: string;
  /** Agent group ID — set by the host, read by the runner. */
  agentGroupId?: string;
  /** Max messages per prompt. Falls back to code default if unset. */
  maxMessagesPerPrompt?: number;
  /**
   * Selects a container backend. Backends are registered via
   * `src/container-backends/`. Defaults to `'docker'` when unset. If the
   * named backend is not registered the spawn aborts (logged) — there is
   * no silent fallback.
   */
  containerBackend?: string;
  /**
   * Per-repo registry consumed by `create_coding_task`. Keys are friendly
   * repo names the parent agent uses (e.g. `"mono"`, `"billing"`); values
   * carry the master path and per-repo defaults. See /add-coding-agent.
   */
  repos?: Record<string, CodingRepoConfig>;
}

// ${VAR} placeholder used in container.json string fields. Resolved at read
// time against the host's .env (NOT process.env — see env.ts). Missing vars
// are left literal and a warning is logged so a downstream connection error
// surfaces clearly rather than silently substituting empty strings.
const VAR_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

function collectVarNames(value: unknown, names: Set<string>): void {
  if (typeof value === 'string') {
    let m: RegExpExecArray | null;
    VAR_PATTERN.lastIndex = 0;
    while ((m = VAR_PATTERN.exec(value)) !== null) names.add(m[1]);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectVarNames(v, names);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectVarNames(v, names);
  }
}

function expandVars<T>(value: T, env: Record<string, string>): T {
  if (typeof value === 'string') {
    return value.replace(VAR_PATTERN, (match, name: string) => {
      if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
      console.warn(`[container-config] unresolved env var \${${name}}, leaving literal`);
      return match;
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => expandVars(v, env)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandVars(v, env);
    return out as T;
  }
  return value;
}

function emptyConfig(): ContainerConfig {
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
  };
}

function configPath(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'container.json');
}

/**
 * Read the container config for a group, returning sensible defaults for
 * any missing fields (or an entirely empty config if the file is absent).
 * Never throws for missing / malformed files — corruption logs a warning
 * via console.error and falls back to empty.
 */
export function readContainerConfig(folder: string): ContainerConfig {
  const p = configPath(folder);
  if (!fs.existsSync(p)) return emptyConfig();
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<ContainerConfig> & Record<string, unknown>;
    // Resolve ${VAR} placeholders against .env. Done post-parse on the object
    // walk so values containing JSON-special chars (quotes, backslashes) cannot
    // break the config structure.
    const names = new Set<string>();
    collectVarNames(parsed, names);
    const env = names.size > 0 ? readEnvFile([...names]) : {};
    const raw = expandVars(parsed, env);
    // Spread raw first so skill-owned fields (e.g. `devcontainer`) survive,
    // then layer normalized values on top.
    return {
      ...raw,
      mcpServers: raw.mcpServers ?? {},
      packages: {
        apt: raw.packages?.apt ?? [],
        npm: raw.packages?.npm ?? [],
      },
      imageTag: raw.imageTag,
      additionalMounts: raw.additionalMounts ?? [],
      skills: raw.skills ?? 'all',
      provider: raw.provider,
      groupName: raw.groupName,
      assistantName: raw.assistantName,
      agentGroupId: raw.agentGroupId,
      maxMessagesPerPrompt: raw.maxMessagesPerPrompt,
      containerBackend: raw.containerBackend,
      repos: raw.repos as Record<string, CodingRepoConfig> | undefined,
    };
  } catch (err) {
    console.error(`[container-config] failed to parse ${p}: ${String(err)}`);
    return emptyConfig();
  }
}

/**
 * Write the container config for a group, creating the groups/<folder>/
 * directory if necessary. Pretty-printed JSON so diffs in the activation
 * flow are reviewable.
 */
export function writeContainerConfig(folder: string, config: ContainerConfig): void {
  const p = configPath(folder);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Apply a mutator function to a group's container config and persist the
 * result. Convenient for append-style changes like `install_packages` and
 * `add_mcp_server` handlers.
 */
export function updateContainerConfig(folder: string, mutate: (config: ContainerConfig) => void): ContainerConfig {
  const config = readContainerConfig(folder);
  mutate(config);
  writeContainerConfig(folder, config);
  return config;
}

/**
 * Initialize an empty container.json for a group if one doesn't already
 * exist. Idempotent — used from `group-init.ts`.
 */
export function initContainerConfig(folder: string): boolean {
  const p = configPath(folder);
  if (fs.existsSync(p)) return false;
  writeContainerConfig(folder, emptyConfig());
  return true;
}
