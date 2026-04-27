/**
 * `devcontainer-cli` MCP tools — wraps the `devcontainer` CLI for
 * in-session reconfiguration.
 *
 * Two tools today:
 *   - devcontainer_exec   — run an arbitrary command inside the
 *     workspace container, returning {stdout, stderr, code}.
 *   - devcontainer_rebuild — devcontainer up --remove-existing-container
 *     against the WORKSPACE_FOLDER env var.
 *
 * Read-only inspectors (`features list`, `templates list`, etc.) are
 * intentionally not exposed — the agent doesn't need them.
 *
 * Long-running rebuild commands get a 30-minute timeout (devcontainer
 * up can pull base images + run features + onCreateCommand). Exec
 * defaults to 5 minutes.
 */

import { spawnSync } from 'node:child_process';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const DEFAULT_EXEC_TIMEOUT_MS = 5 * 60 * 1000;
const REBUILD_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024; // 1 MiB cap on stdout/stderr returned to the agent.

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(payload: { code: string; message: string; stderr?: string }) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `Error: ${payload.message}\n${JSON.stringify({ error: payload })}`,
      },
    ],
    isError: true,
  };
}

function runDevcontainer(
  args: string[],
  timeoutMs: number,
): {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  spawnError?: NodeJS.ErrnoException;
} {
  const result = spawnSync('devcontainer', args, {
    timeout: timeoutMs,
    encoding: 'buffer',
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_OUTPUT_BYTES * 4,
  });
  const truncate = (b: Buffer | null): string => {
    if (!b) return '';
    if (b.length <= MAX_OUTPUT_BYTES) return b.toString();
    return b.subarray(0, MAX_OUTPUT_BYTES).toString() + '\n... (truncated)';
  };
  return {
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
    code: result.status,
    signal: result.signal,
    spawnError: result.error as NodeJS.ErrnoException | undefined,
  };
}

export const devcontainerExec: McpToolDefinition = {
  tool: {
    name: 'devcontainer_exec',
    description:
      'Run a shell command inside the active devcontainer workspace via `devcontainer exec`. Returns {stdout, stderr, code}. The command runs through `sh -c` inside the container; quote-escape if you embed user-controlled strings. Default timeout 5 minutes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description:
            'Shell command to run inside the container (interpreted by `sh -c`).',
        },
        cwd: {
          type: 'string',
          description:
            'Optional working directory inside the container. Defaults to the workspace folder.',
        },
      },
      required: ['command'],
    },
  },
  async handler(args) {
    const command = args.command;
    if (typeof command !== 'string' || !command.trim()) {
      return err({ code: 'BAD_INPUT', message: 'command is required (non-empty string)' });
    }
    const cwd = typeof args.cwd === 'string' ? args.cwd : undefined;
    const workspaceFolder = process.env.WORKSPACE_FOLDER;
    if (!workspaceFolder) {
      return err({
        code: 'NO_WORKSPACE_FOLDER',
        message: 'WORKSPACE_FOLDER env var is not set in the agent environment',
      });
    }

    // `devcontainer exec --workspace-folder <wf> <command...>` — if a cwd
    // override is supplied, run the command via `sh -c "cd <cwd> && <cmd>"`
    // to scope it. Otherwise run via `sh -c <cmd>` for shell interpretation
    // of pipes / redirects.
    const shellCmd = cwd ? `cd ${shellEscape(cwd)} && ${command}` : command;
    const argv = ['exec', '--workspace-folder', workspaceFolder, 'sh', '-c', shellCmd];

    const r = runDevcontainer(argv, DEFAULT_EXEC_TIMEOUT_MS);
    if (r.spawnError) {
      log(`devcontainer_exec spawn error: ${r.spawnError.code} ${r.spawnError.message}`);
      return err({
        code: r.spawnError.code || 'SPAWN_ERROR',
        message: r.spawnError.message,
      });
    }
    if (r.signal === 'SIGTERM') {
      return err({
        code: 'TIMEOUT',
        message: `devcontainer exec timed out after ${DEFAULT_EXEC_TIMEOUT_MS}ms`,
        stderr: r.stderr,
      });
    }
    return ok(JSON.stringify({ stdout: r.stdout, stderr: r.stderr, code: r.code }));
  },
};

export const devcontainerRebuild: McpToolDefinition = {
  tool: {
    name: 'devcontainer_rebuild',
    description:
      'Rebuild the active devcontainer with `devcontainer up --remove-existing-container`. Use after editing devcontainer.json or its referenced Dockerfile. Long-running (up to 30 min for image rebuild + feature install).',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  async handler() {
    const workspaceFolder = process.env.WORKSPACE_FOLDER;
    if (!workspaceFolder) {
      return err({
        code: 'NO_WORKSPACE_FOLDER',
        message: 'WORKSPACE_FOLDER env var is not set in the agent environment',
      });
    }

    const argv = [
      'up',
      '--workspace-folder',
      workspaceFolder,
      '--remove-existing-container',
    ];
    const r = runDevcontainer(argv, REBUILD_TIMEOUT_MS);
    if (r.spawnError) {
      log(`devcontainer_rebuild spawn error: ${r.spawnError.code} ${r.spawnError.message}`);
      return err({
        code: r.spawnError.code || 'SPAWN_ERROR',
        message: r.spawnError.message,
      });
    }
    if (r.signal === 'SIGTERM') {
      return err({
        code: 'TIMEOUT',
        message: `devcontainer up timed out after ${REBUILD_TIMEOUT_MS}ms`,
        stderr: r.stderr,
      });
    }
    if (r.code !== 0) {
      return err({
        code: `EXIT_${r.code}`,
        message: 'devcontainer up exited non-zero',
        stderr: r.stderr,
      });
    }
    return ok(JSON.stringify({ ok: true, stdout: r.stdout, stderr: r.stderr }));
  },
};

/** Minimal POSIX-shell-safe quoting for cwd injection. */
function shellEscape(s: string): string {
  // Single-quote everything; escape embedded single quotes by closing/
  // opening the quote pair. Standard sh-compatible idiom.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

registerTools([devcontainerExec, devcontainerRebuild]);
