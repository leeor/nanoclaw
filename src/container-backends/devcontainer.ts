/**
 * Devcontainer backend — per-task long-lived container wrapping a git worktree.
 *
 * Used by the coding-agent feature skill. Unlike the docker backend (one-shot
 * `docker run --rm` per session), the devcontainer backend:
 *
 *   1. Calls `devcontainer up --workspace-folder <path>` to ensure the
 *      container exists. Idempotent — reuses an existing container if one is
 *      already running with matching id-labels.
 *   2. Calls `devcontainer exec` to spawn the long-lived agent-runner inside
 *      that container. The exec process is the ContainerHandle.process — its
 *      'close' event signals session end.
 *   3. Stops the container on shutdown via `devcontainer stop` (graceful)
 *      with `docker stop` fallback through the shared id-label scheme.
 *
 * The workspace folder comes from `containerConfig.devcontainer.workspaceFolder`
 * — required when this backend is selected. The skill's coding-task module is
 * responsible for setting it (typically a per-task git worktree path) before
 * spawning the session.
 *
 * OneCLI integration: the docker backend mutates `docker run` args via
 * `applyContainerConfig`. Devcontainer can't reuse that — `exec` doesn't take
 * volume / network args. Instead this backend asks OneCLI for the proxy URL +
 * cert bundle and forwards them via `--remote-env HTTPS_PROXY=...` plus a
 * read-only mount declared in the user's devcontainer.json. The skill's
 * install instructions tell the user to add that mount.
 */
import { spawn, execSync } from 'child_process';

import { OneCLI } from '@onecli-sh/sdk';

import { CONTAINER_INSTALL_LABEL, ONECLI_API_KEY, ONECLI_URL, TIMEZONE } from '../config.js';
import { log } from '../log.js';

import { registerContainerBackend } from './registry.js';
import type { ContainerBackend, ContainerHandle, SpawnSpec } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

/** Override for tests + ops via DEVCONTAINER_BIN env var. */
const DEVCONTAINER_BIN = process.env.DEVCONTAINER_BIN || 'devcontainer';

/** Hard timeout for `devcontainer up`. First-time builds take ~7-10min. */
const UP_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Per-spec config consumed by this backend. Lives on
 * `containerConfig.devcontainer` (untyped on `ContainerConfig` so the core
 * doesn't need to know about backend-specific shapes — the skill's container
 * config writer fills it in).
 */
interface DevcontainerSpecConfig {
  /** Absolute path to the devcontainer's workspace folder (a git worktree). */
  workspaceFolder?: string;
  /** Optional id-labels to scope the container; merged with defaults. */
  idLabels?: Record<string, string>;
}

interface DevcontainerMeta extends Record<string, unknown> {
  workspaceFolder: string;
  idLabels: Record<string, string>;
}

function readDevcontainerConfig(spec: SpawnSpec): DevcontainerSpecConfig {
  // Stored under containerConfig.devcontainer by the coding-task module.
  // Cast through unknown — the field is skill-owned, not part of the core
  // ContainerConfig type.
  const cfg = spec.containerConfig as unknown as { devcontainer?: DevcontainerSpecConfig };
  return cfg.devcontainer ?? {};
}

function buildIdLabels(spec: SpawnSpec, override: Record<string, string>): Record<string, string> {
  return {
    'nanoclaw.install': CONTAINER_INSTALL_LABEL,
    'nanoclaw.session': spec.session.id,
    'nanoclaw.agent-group': spec.agentGroup.id,
    ...override,
  };
}

function flattenIdLabels(labels: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(labels)) {
    out.push('--id-label', `${k}=${v}`);
  }
  return out;
}

/**
 * Ask OneCLI for the proxy URL + cert path. Returns env vars to forward via
 * --remote-env. Failure is non-fatal (logged) — the container will simply
 * lack credentials, mirroring the docker backend's behavior.
 */
async function buildOneCliRemoteEnv(spec: SpawnSpec): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  try {
    if (spec.agentIdentifier) {
      await onecli.ensureAgent({ name: spec.agentGroup.name, identifier: spec.agentIdentifier });
    }
    // applyContainerConfig mutates docker args; we don't have those. Inspect
    // what it would have produced by passing a probe array, then copy the
    // -e values over to remote-env. This keeps a single source of truth for
    // proxy URL / cert path inside the SDK.
    const probe: string[] = [];
    const applied = await onecli.applyContainerConfig(probe, {
      addHostMapping: false,
      agent: spec.agentIdentifier,
    });
    if (!applied) {
      log.warn('OneCLI gateway not applied — devcontainer will have no credentials', {
        containerName: spec.containerName,
      });
      return env;
    }
    // probe is now an interleaved list of docker run flags. Pull -e KEY=VALUE
    // pairs out — those are the env vars we need to forward.
    for (let i = 0; i < probe.length - 1; i++) {
      if (probe[i] === '-e') {
        const [key, ...rest] = probe[i + 1].split('=');
        env[key] = rest.join('=');
      }
    }
    log.info('OneCLI gateway env captured for devcontainer', {
      containerName: spec.containerName,
      keys: Object.keys(env),
    });
  } catch (err) {
    log.warn('OneCLI gateway error — devcontainer will have no credentials', {
      containerName: spec.containerName,
      err,
    });
  }
  return env;
}

function buildRemoteEnv(spec: SpawnSpec, oneCliEnv: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { TZ: TIMEZONE, ...oneCliEnv };
  if (spec.providerContribution.env) {
    for (const [k, v] of Object.entries(spec.providerContribution.env)) {
      env[k] = v;
    }
  }
  return env;
}

const devcontainerBackend: ContainerBackend = {
  name: 'devcontainer',

  async spawn(spec: SpawnSpec): Promise<ContainerHandle> {
    const cfg = readDevcontainerConfig(spec);
    if (!cfg.workspaceFolder) {
      throw new Error(
        `[devcontainer] containerConfig.devcontainer.workspaceFolder is required ` +
          `(agent group ${spec.agentGroup.id})`,
      );
    }
    const workspaceFolder = cfg.workspaceFolder;
    const idLabels = buildIdLabels(spec, cfg.idLabels ?? {});

    log.info('devcontainer up', {
      containerName: spec.containerName,
      workspaceFolder,
      idLabels,
    });

    // Step 1: devcontainer up (idempotent).
    await new Promise<void>((resolve, reject) => {
      const upArgs = ['up', '--workspace-folder', workspaceFolder, ...flattenIdLabels(idLabels)];
      const upProc = spawn(DEVCONTAINER_BIN, upArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stderr = '';
      upProc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const timer = setTimeout(() => {
        upProc.kill();
        reject(new Error(`devcontainer up timed out after ${UP_TIMEOUT_MS}ms`));
      }, UP_TIMEOUT_MS);

      upProc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      upProc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`devcontainer up exited ${code}: ${stderr.slice(-400)}`));
        }
      });
    });

    log.info('devcontainer up complete', { containerName: spec.containerName });

    // Step 2: devcontainer exec — long-lived agent-runner.
    const oneCliEnv = await buildOneCliRemoteEnv(spec);
    const remoteEnv = buildRemoteEnv(spec, oneCliEnv);
    const execArgs = ['exec', '--workspace-folder', workspaceFolder, ...flattenIdLabels(idLabels)];
    for (const [k, v] of Object.entries(remoteEnv)) {
      execArgs.push('--remote-env', `${k}=${v}`);
    }
    // The container image already has /app/src/index.ts wired by the
    // skill's devcontainer.json (mount + features). Match the docker
    // backend's entry command for consistency.
    execArgs.push('--', 'bash', '-c', 'exec bun run /app/src/index.ts');

    const proc = spawn(DEVCONTAINER_BIN, execArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    const meta: DevcontainerMeta = { workspaceFolder, idLabels };
    return {
      process: proc,
      containerName: spec.containerName,
      meta,
    };
  },

  async stop(handle: ContainerHandle): Promise<void> {
    // Devcontainers are long-lived. Graceful stop is `devcontainer stop`
    // when targeting a workspace folder; fall back to `docker stop` via
    // id-label resolution if that fails.
    const meta = handle.meta as DevcontainerMeta | undefined;
    if (!meta?.workspaceFolder) {
      // Nothing to do — never spawned.
      return;
    }
    try {
      execSync(`${DEVCONTAINER_BIN} stop --workspace-folder ${shellEscape(meta.workspaceFolder)}`, {
        stdio: 'pipe',
        timeout: 30_000,
      });
      return;
    } catch (err) {
      log.warn('devcontainer stop failed; falling back to docker stop by label', {
        containerName: handle.containerName,
        err,
      });
    }
    // Fallback: locate by id-label and docker-stop.
    try {
      const filter = Object.entries(meta.idLabels)
        .map(([k, v]) => `--filter label=${k}=${v}`)
        .join(' ');
      const ids = execSync(`docker ps -q ${filter}`, { stdio: 'pipe' }).toString().trim().split(/\s+/).filter(Boolean);
      for (const id of ids) {
        execSync(`docker stop -t 1 ${id}`, { stdio: 'pipe' });
      }
    } catch (err) {
      log.warn('docker stop fallback failed', { containerName: handle.containerName, err });
      throw err instanceof Error ? err : new Error(String(err));
    }
  },
};

function shellEscape(arg: string): string {
  // Single-quote wrap; close-then-escape any embedded single quotes.
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

registerContainerBackend(devcontainerBackend);

export { devcontainerBackend };
