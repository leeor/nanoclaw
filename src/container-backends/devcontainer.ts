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
import { spawn, execSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import { GROUPS_DIR, INSTALL_SLUG, ONECLI_API_KEY, ONECLI_URL, TIMEZONE } from '../config.js';
import { log } from '../log.js';
import { sessionDir } from '../session-manager.js';

import { registerContainerBackend } from './registry.js';
import type { ContainerBackend, ContainerHandle, SpawnSpec } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

/** Override for tests + ops via DEVCONTAINER_BIN env var. */
const DEVCONTAINER_BIN = process.env.DEVCONTAINER_BIN || 'devcontainer';

/** Hard timeout for `devcontainer up`. First-time builds for heavy
 * monorepos (apt-get, gcloud SDK, docker-in-docker post-create) can run
 * 20-25 min; allow 30 min before declaring it stuck. Override via
 * NANOCLAW_DEVCONTAINER_UP_TIMEOUT_MS on slower hosts. */
const UP_TIMEOUT_MS = Number(process.env.NANOCLAW_DEVCONTAINER_UP_TIMEOUT_MS ?? 30 * 60 * 1000);

/**
 * Image we extract `bun` from. Always present on a NanoClaw install (built by
 * `container/build.sh`), so we get a known-good linux bun binary that matches
 * the agent-runner architecture without a network call from inside the
 * devcontainer.
 */
const NANOCLAW_AGENT_IMAGE = 'nanoclaw-agent:v2';

/** Memoize host-side bun cache, /pnpm cache, and bridge gateway across spawns. */
let cachedBunPath: string | null = null;
let cachedPnpmDir: string | null = null;
let cachedBridgeGw: string | null = null;

/**
 * Bind-mount target inside the devcontainer for the host-cached bun. Chosen
 * to not collide with a `bun` the user's image might already ship.
 */
const BUN_TARGET_PATH = '/usr/local/bin/nanoclaw-bun';

/**
 * Return a host filesystem path to a `bun` binary. Lazily extracted from
 * `nanoclaw-agent:v2` on first call and cached under `data/cache/`. Override
 * via `NANOCLAW_BUN_HOST_PATH` for tests / air-gapped operators that pre-stage
 * the binary themselves.
 *
 * Why not curl bun.sh inside the container: the user's devcontainer typically
 * has no usable DNS for `host.docker.internal` (the OneCLI proxy host) and
 * the install script needs the proxy to reach bun.sh. Cutting the network
 * dependency makes start-up deterministic.
 */
function ensureBunOnHost(): string {
  const override = process.env.NANOCLAW_BUN_HOST_PATH;
  if (override) return override;
  if (cachedBunPath) return cachedBunPath;
  const target = path.join(process.cwd(), 'data', 'cache', 'nanoclaw-bun');
  if (fs.existsSync(target) && fs.statSync(target).size > 1024) {
    cachedBunPath = target;
    return target;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let cid = '';
  try {
    cid = execFileSync('docker', ['create', NANOCLAW_AGENT_IMAGE], {
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
    execFileSync('docker', ['cp', `${cid}:/usr/local/bin/bun`, target], {
      stdio: 'pipe',
      timeout: 30_000,
    });
  } finally {
    if (cid) {
      try {
        execFileSync('docker', ['rm', cid], { stdio: 'pipe', timeout: 10_000 });
      } catch {
        // Best-effort.
      }
    }
  }
  fs.chmodSync(target, 0o755);
  cachedBunPath = target;
  return target;
}

/**
 * Return a host filesystem path to the `/pnpm` tree from `nanoclaw-agent:v2`,
 * which carries the Claude Code CLI (`/pnpm/claude`) plus its node_modules
 * deps. Lazily extracted to `data/cache/nanoclaw-pnpm/` on first call. The
 * devcontainer backend bind-mounts this dir at `/pnpm` so the agent-runner's
 * SDK call to `pathToClaudeCodeExecutable: '/pnpm/claude'` works without
 * depending on the user's image shipping Claude Code.
 *
 * Override via `NANOCLAW_PNPM_HOST_DIR` for tests / pre-staged dirs.
 */
function ensurePnpmDirOnHost(): string {
  const override = process.env.NANOCLAW_PNPM_HOST_DIR;
  if (override) return override;
  if (cachedPnpmDir) return cachedPnpmDir;
  const target = path.join(process.cwd(), 'data', 'cache', 'nanoclaw-pnpm');
  const claudeShim = path.join(target, 'claude');
  if (fs.existsSync(claudeShim) && fs.statSync(claudeShim).size > 0) {
    cachedPnpmDir = target;
    return target;
  }
  fs.mkdirSync(target, { recursive: true });
  let cid = '';
  try {
    cid = execFileSync('docker', ['create', NANOCLAW_AGENT_IMAGE], {
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
    // `docker cp <cid>:/pnpm/.` copies contents of /pnpm into target so we
    // end up with target/claude, target/global, etc. (rather than target/pnpm/...).
    execFileSync('docker', ['cp', `${cid}:/pnpm/.`, target], {
      stdio: 'pipe',
      timeout: 300_000,
    });
  } finally {
    if (cid) {
      try {
        execFileSync('docker', ['rm', cid], { stdio: 'pipe', timeout: 10_000 });
      } catch {
        // Best-effort.
      }
    }
  }
  cachedPnpmDir = target;
  return target;
}

/**
 * Resolve an IP routable from inside the devcontainer to the host's loopback
 * services (OneCLI proxy on 127.0.0.1:10255). Returns null when no bridge
 * network exists or the lookup fails — callers fall back to leaving the
 * original `host.docker.internal` reference, which the user can fix by adding
 * `runArgs: ["--add-host=host.docker.internal:host-gateway"]` to their own
 * devcontainer.json.
 *
 * Override via `NANOCLAW_DOCKER_BRIDGE_GW` for tests + non-bridge networks.
 */
function getDockerBridgeGateway(): string | null {
  const override = process.env.NANOCLAW_DOCKER_BRIDGE_GW;
  if (override) return override;
  if (cachedBridgeGw !== null) return cachedBridgeGw;
  try {
    const out = execFileSync('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}'], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(out)) {
      cachedBridgeGw = out;
      return out;
    }
  } catch {
    // Best-effort.
  }
  return null;
}

function rewriteHostDockerInternal(env: Record<string, string>): Record<string, string> {
  const gw = getDockerBridgeGateway();
  if (!gw) return env;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = v.replace(/host\.docker\.internal/g, gw);
  }
  return out;
}

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
  // Values must NOT contain `=` — devcontainer CLI's id-label matcher hangs
  // forever (no error, no progress, no post-create) when an --id-label value
  // has an embedded `=`. The docker backend's `--label key=value` is not
  // affected (docker accepts the full string verbatim), so the install label
  // there stays as-is. For devcontainer-up id-labels we pass the bare slug.
  return {
    'nanoclaw.install': INSTALL_SLUG,
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

interface OneCliContribution {
  /** Env vars to forward via --remote-env. */
  env: Record<string, string>;
  /** Bind-mount specs (host → container) to forward via --mount. */
  mounts: Array<{ source: string; target: string }>;
}

/**
 * Ask OneCLI for the proxy URL + cert paths it would inject into a docker
 * run. Returns env + mounts. Failure is non-fatal (logged) — the container
 * will lack credentials, mirroring the docker backend's behavior.
 */
async function buildOneCliContribution(spec: SpawnSpec): Promise<OneCliContribution> {
  const env: Record<string, string> = {};
  const mounts: Array<{ source: string; target: string }> = [];
  try {
    if (spec.agentIdentifier) {
      await onecli.ensureAgent({ name: spec.agentGroup.name, identifier: spec.agentIdentifier });
    }
    // applyContainerConfig mutates docker args; we don't have those. Inspect
    // what it would have produced by passing a probe array, then copy the
    // -e and -v values over. This keeps a single source of truth for proxy
    // URL / cert paths inside the SDK.
    const probe: string[] = [];
    const applied = await onecli.applyContainerConfig(probe, {
      addHostMapping: false,
      agent: spec.agentIdentifier,
    });
    if (!applied) {
      log.warn('OneCLI gateway not applied — devcontainer will have no credentials', {
        containerName: spec.containerName,
      });
      return { env, mounts };
    }
    // probe is an interleaved list of docker run flags. Pull -e KEY=VALUE
    // pairs out as env vars and -v src:tgt[:ro] as bind-mounts.
    //
    // OneCLI's default cert targets land under /tmp, but the dind feature's
    // docker-init.sh masks /tmp with a tmpfs at container start — bind-mounts
    // there get hidden. Remap any /tmp/* targets to /etc/nanoclaw/ and rewrite
    // matching env values (NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, DENO_CERT) to
    // point at the new location. The remap is reversible — same target names,
    // just a different parent — so OneCLI's cert format remains untouched.
    const tmpRemap = new Map<string, string>();
    const remapTmpPath = (target: string): string => {
      if (!target.startsWith('/tmp/')) return target;
      const remapped = `/etc/nanoclaw/${target.slice('/tmp/'.length)}`;
      tmpRemap.set(target, remapped);
      return remapped;
    };
    for (let i = 0; i < probe.length - 1; i++) {
      if (probe[i] === '-v') {
        // host_src:container_tgt[:ro|rw]. Devcontainer CLI's --mount parser
        // doesn't accept the `:ro` flag, so we drop it and rely on the
        // file-level immutability of the cert tmpfile.
        const parts = probe[i + 1].split(':');
        if (parts.length >= 2) {
          mounts.push({ source: parts[0], target: remapTmpPath(parts[1]) });
        }
      }
    }
    for (let i = 0; i < probe.length - 1; i++) {
      if (probe[i] === '-e') {
        const [key, ...rest] = probe[i + 1].split('=');
        let value = rest.join('=');
        for (const [from, to] of tmpRemap) value = value.split(from).join(to);
        env[key] = value;
      }
    }
    log.info('OneCLI gateway captured for devcontainer', {
      containerName: spec.containerName,
      envKeys: Object.keys(env),
      mountTargets: mounts.map((m) => m.target),
    });
  } catch (err) {
    log.warn('OneCLI gateway error — devcontainer will have no credentials', {
      containerName: spec.containerName,
      err,
    });
  }
  return { env, mounts };
}

function buildRemoteEnv(spec: SpawnSpec, oneCliEnv: Record<string, string>): Record<string, string> {
  // Tell agent-runner where to find the session DBs and group dir under
  // the devcontainer's mount layout. /workspace inside the devcontainer
  // is the user's repo worktree, so we can't reuse the docker backend's
  // /workspace + /workspace/agent layout.
  //
  // NANOCLAW_CWD points the SDK / sub-tools at a directory that actually
  // exists inside the devcontainer (the workspaceFolder is the worktree
  // path on the host, but the path inside the container is exposed by
  // the devcontainer's `workspaceFolder` setting — usually
  // `/workspace/<basename>`). We approximate it as `/workspace/<basename>`,
  // which matches the convention used by `${localWorkspaceFolderBasename}`.
  const cfg = readDevcontainerConfig(spec);
  const cwdInContainer = cfg.workspaceFolder
    ? path.posix.join('/workspace', path.basename(cfg.workspaceFolder))
    : '/workspace';
  const env: Record<string, string> = {
    TZ: TIMEZONE,
    NANOCLAW_SESSION_DIR: '/nanoclaw-session',
    NANOCLAW_GROUP_DIR: '/nanoclaw-group',
    NANOCLAW_CWD: cwdInContainer,
    // Claude SDK behavior we need but can't deliver via settings.json (mono's
    // devcontainer mounts the operator's ~/.claude over our DEFAULT_SETTINGS_JSON):
    // - Auto-memory ON so CLAUDE.md files in the user's repo tree are loaded.
    // - additionalDirectories CLAUDE.md scan ON so /nanoclaw-group/CLAUDE.md
    //   (the composed entry) loads alongside the cwd tree.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    ...oneCliEnv,
  };
  if (spec.providerContribution.env) {
    for (const [k, v] of Object.entries(spec.providerContribution.env)) {
      env[k] = v;
    }
  }
  // Backoffice MCP env passthrough — see add-backoffice-tool skill.
  if (process.env.BO_API_URL) env.BO_API_URL = process.env.BO_API_URL;
  if (process.env.BO_AUTH_TOKEN) env.BO_AUTH_TOKEN = process.env.BO_AUTH_TOKEN;
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
    // Bind-mount the host's agent-runner src + skills into the
    // devcontainer at /app/src + /app/skills. The exec command below runs
    // `bun run /app/src/index.ts`, so the runner code lives outside the
    // repo's devcontainer image — no changes to the user's
    // .devcontainer/devcontainer.json required.
    //
    // Also mount the session dir + group dir at /nanoclaw-session +
    // /nanoclaw-group (vs. docker backend's /workspace + /workspace/agent
    // layout — those paths can't be reused here because /workspace is the
    // user's repo worktree). agent-runner reads NANOCLAW_SESSION_DIR /
    // NANOCLAW_GROUP_DIR (set in remote-env) to find them.
    const agentRunnerSrc = path.join(process.cwd(), 'container', 'agent-runner', 'src');
    const skillsSrc = path.join(process.cwd(), 'container', 'skills');
    const sessionHostDir = sessionDir(spec.agentGroup.id, spec.session.id);
    const groupHostDir = path.join(GROUPS_DIR, spec.agentGroup.folder);
    const bunHostPath = ensureBunOnHost();
    const pnpmHostDir = ensurePnpmDirOnHost();
    const oneCli = await buildOneCliContribution(spec);
    await new Promise<void>((resolve, reject) => {
      const upArgs = [
        'up',
        '--workspace-folder',
        workspaceFolder,
        // Lifecycle commands (postCreateCommand etc.) DO run. Coding agents
        // need yarn install / go mod download / docker build prep so they can
        // execute the full SDLC (write code, run tests, build images, push)
        // inside the container without an external CI step. Cold-create costs
        // ~1-2 min on a hot-cache mono; subsequent ups reuse the existing
        // container instantly.
        ...flattenIdLabels(idLabels),
        // Note: devcontainer CLI's --mount parser only accepts type/source/
        // target/external — no `readonly` suffix. The session-DB and group
        // bind mounts are still safe because the host-side filesystem layout
        // (single writer per file) is what enforces the contract, not RO bits.
        '--mount',
        `type=bind,source=${agentRunnerSrc},target=/app/src`,
        '--mount',
        `type=bind,source=${skillsSrc},target=/app/skills`,
        '--mount',
        `type=bind,source=${sessionHostDir},target=/nanoclaw-session`,
        '--mount',
        `type=bind,source=${groupHostDir},target=/nanoclaw-group`,
        // Bun binary from the host's nanoclaw-agent image — see ensureBunOnHost.
        '--mount',
        `type=bind,source=${bunHostPath},target=${BUN_TARGET_PATH}`,
        // /pnpm tree (Claude Code CLI + node_modules) — see ensurePnpmDirOnHost.
        '--mount',
        `type=bind,source=${pnpmHostDir},target=/pnpm`,
        // Backoffice MCP package — bound at /opt/backoffice-mcp when host
        // sets BACKOFFICE_MCP_PATH (operator-supplied, see add-backoffice-tool).
        ...(process.env.BACKOFFICE_MCP_PATH
          ? ['--mount', `type=bind,source=${process.env.BACKOFFICE_MCP_PATH},target=/opt/backoffice-mcp`]
          : []),
        // OneCLI cert files — extracted from the same probe that produced the
        // proxy env vars below, so the proxy URL and the CA cert agree.
        ...oneCli.mounts.flatMap((m) => ['--mount', `type=bind,source=${m.source},target=${m.target}`]),
      ];
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
    const remoteEnv = rewriteHostDockerInternal(buildRemoteEnv(spec, oneCli.env));
    const execArgs = ['exec', '--workspace-folder', workspaceFolder, ...flattenIdLabels(idLabels)];
    for (const [k, v] of Object.entries(remoteEnv)) {
      execArgs.push('--remote-env', `${k}=${v}`);
    }
    // /app/src + /app/skills + bun come from the bind mounts added to `up`.
    // Direct exec (no shell wrapper) so docker delivers signals straight to
    // the bun process.
    execArgs.push('--', BUN_TARGET_PATH, 'run', '/app/src/index.ts');

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
