/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
 *
 * Config is read from /workspace/agent/container.json (mounted RO).
 * Only TZ and OneCLI networking vars come from env.
 *
 * Mount structure:
 *   /workspace/
 *     inbound.db        ← host-owned session DB (container reads only)
 *     outbound.db       ← container-owned session DB
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, container.json, working files)
 *       container.json  ← per-group config (RO nested mount)
 *     global/           ← shared global memory (RO)
 *   /app/src/           ← shared agent-runner source (RO)
 *   /app/skills/        ← shared skills (RO)
 *   /home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';
import { buildSystemPromptAddendum } from './destinations.js';
import { ensureIcmConfig } from './icm-init.js';
import { startLocalProxy } from './local-proxy.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import type { McpServerConfig } from './providers/types.js';
import { runPollLoop } from './poll-loop.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

// Default cwd for the SDK / sub-tools. The docker backend mounts the per-group
// dir at /workspace/agent, so that's the historical default. The devcontainer
// backend mounts /workspace as the user's repo (no /workspace/agent), so the
// host sets NANOCLAW_CWD to a directory that exists in that layout (typically
// the workspaceFolder, e.g. /workspace/<ticket>).
const CWD = process.env.NANOCLAW_CWD || '/workspace/agent';

async function main(): Promise<void> {
  const config = loadConfig();
  const providerName = config.provider.toLowerCase() as ProviderName;

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // Optional: in-container retry proxy for the host credential proxy /
  // OneCLI gateway. When the host restarts, the upstream port briefly
  // disappears; this proxy retries ECONNREFUSED with backoff so the
  // Agent SDK never sees the transient outage. Started in the
  // background; never blocks the agent loop. Triggered by the devcontainer
  // backend, which forwards both env vars via `--remote-env`.
  const localProxyPort = process.env.NANOCLAW_LOCAL_PROXY_PORT;
  const localProxyUpstream = process.env.NANOCLAW_UPSTREAM_PROXY;
  if (localProxyPort && localProxyUpstream) {
    const port = Number(localProxyPort);
    if (!Number.isInteger(port) || port <= 0) {
      log(`local-proxy: invalid NANOCLAW_LOCAL_PROXY_PORT=${localProxyPort} — skipping`);
    } else {
      // Fire-and-forget: log the bound address on success, log the error on
      // failure, but do not let either path block agent startup.
      void startLocalProxy({
        port,
        upstreamUrl: localProxyUpstream,
        log: (msg) => log(msg),
      }).then(
        (h) => log(`local-proxy started on 127.0.0.1:${h.port} -> ${localProxyUpstream}`),
        (err) =>
          log(
            `local-proxy failed to start: ${err instanceof Error ? err.message : String(err)}`,
          ),
      );
    }
  }

  // Runtime-generated system-prompt addendum: agent identity (name) plus
  // the live destinations map. Everything else (capabilities, per-module
  // instructions, per-channel formatting) is loaded by Claude Code from
  // /workspace/agent/CLAUDE.md — the composed entry imports the shared
  // base (/app/CLAUDE.md) and each enabled module's fragment. Per-group
  // memory lives in /workspace/agent/CLAUDE.local.md (auto-loaded).
  let instructions = buildSystemPromptAddendum(config.assistantName || undefined);
  // The Claude SDK only auto-loads CLAUDE.md from cwd's tree, and the
  // `--add-dir`-CLAUDE.md auto-load is gated on a setting we can't reliably
  // deliver in the devcontainer backend (the user's image overrides
  // ~/.claude/settings.json with their own config). Inline the operator's
  // group CLAUDE.local.md (and its composed CLAUDE.md, which `@`-imports
  // module fragments) directly into the system prompt addendum so the agent
  // gets the Implementation Workflow / PR Monitor playbook regardless of
  // which backend or which user image runs the session.
  const groupDirForPrompt = process.env.NANOCLAW_GROUP_DIR;
  if (groupDirForPrompt) {
    const groupClaudeMd = path.join(groupDirForPrompt, 'CLAUDE.md');
    const groupClaudeLocal = path.join(groupDirForPrompt, 'CLAUDE.local.md');
    const sections: string[] = [];
    for (const file of [groupClaudeMd, groupClaudeLocal]) {
      try {
        if (fs.existsSync(file)) {
          const body = fs.readFileSync(file, 'utf-8').trim();
          if (body) sections.push(`# ${path.basename(file)} (loaded from ${groupDirForPrompt})\n\n${body}`);
        }
      } catch {
        // Best-effort.
      }
    }
    if (sections.length > 0) {
      instructions = `${instructions}\n\n---\n\n${sections.join('\n\n---\n\n')}`;
    }
  }

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
  }
  // Devcontainer backend: cwd is the user's repo worktree (e.g.
  // /workspace/<ticket>), which has its OWN CLAUDE.md the SDK loads. The
  // group dir at /nanoclaw-group holds the operator-customized CLAUDE.md +
  // CLAUDE.local.md (Implementation Workflow etc.) that must ALSO be loaded.
  // Add it as an additional directory so Claude Code picks it up. Docker
  // backend doesn't need this — its cwd /workspace/agent already IS the group dir.
  const groupDir = process.env.NANOCLAW_GROUP_DIR;
  if (groupDir && groupDir !== CWD && fs.existsSync(groupDir) && !additionalDirectories.includes(groupDir)) {
    additionalDirectories.push(groupDir);
  }
  if (additionalDirectories.length > 0) {
    log(`Additional directories: ${additionalDirectories.join(', ')}`);
  }

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

  // Build MCP servers config: nanoclaw built-in + any from container.json
  const mcpServers: Record<string, McpServerConfig> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
  };

  // Optional MCP server tool prefixes — populated as servers get wired below.
  // Passed to the provider so its base allowlist can be extended without the
  // provider needing to know about each individual skill.
  const extraAllowedTools: string[] = [];

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    if (name === 'icm' && (!('type' in serverConfig) || serverConfig.type === 'stdio' || serverConfig.type === undefined)) {
      // Auto-fill ICM_CONFIG so operator container.json can stay minimal —
      // path is invariant per group (lives under /workspace/agent/.icm).
      if (!serverConfig.env?.ICM_CONFIG) {
        const icmConfigPath = ensureIcmConfig(CWD);
        mcpServers[name] = {
          ...serverConfig,
          env: { ...serverConfig.env, ICM_CONFIG: icmConfigPath },
        };
        log(`Additional MCP server: ${name} (${serverConfig.command}) — ICM_CONFIG=${icmConfigPath}`);
      } else {
        mcpServers[name] = serverConfig;
        log(`Additional MCP server: ${name} (${serverConfig.command})`);
      }
      extraAllowedTools.push('mcp__icm__*');
    } else {
      mcpServers[name] = serverConfig;
      const desc =
        'type' in serverConfig && (serverConfig.type === 'http' || serverConfig.type === 'sse')
          ? serverConfig.url
          : serverConfig.command;
      log(`Additional MCP server: ${name} (${desc})`);
    }
  }

  // Backoffice MCP server (operator-supplied, see add-backoffice-tool skill).
  // Wired only when both env vars are set AND the package is bind-mounted at
  // the conventional path. Env vars are scrubbed below so the agent can't
  // read them via Bash; the MCP server gets them via its explicit env block,
  // which is captured here before scrubbing.
  if (
    process.env.BO_API_URL &&
    process.env.BO_AUTH_TOKEN &&
    fs.existsSync('/opt/backoffice-mcp/dist/index.js')
  ) {
    mcpServers.backoffice = {
      command: 'node',
      args: ['/opt/backoffice-mcp/dist/index.js'],
      env: {
        BO_API_URL: process.env.BO_API_URL,
        BO_AUTH_TOKEN: process.env.BO_AUTH_TOKEN,
      },
    };
    extraAllowedTools.push('mcp__backoffice__*');
    log('Backoffice MCP server wired (BO_API_URL + BO_AUTH_TOKEN present)');
  }

  // Scrub backoffice secrets from process.env so the agent cannot read them
  // via Bash. The MCP server still receives them via the explicit env block
  // captured above. Intentional defense-in-depth — see add-backoffice-tool
  // skill SKILL.md.
  delete process.env.BO_API_URL;
  delete process.env.BO_AUTH_TOKEN;

  const provider = createProvider(providerName, {
    assistantName: config.assistantName || undefined,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
    extraAllowedTools: extraAllowedTools.length > 0 ? extraAllowedTools : undefined,
  });

  await runPollLoop({
    provider,
    providerName,
    cwd: CWD,
    systemContext: { instructions },
  });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
