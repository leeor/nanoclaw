/**
 * Build the docker CLI args for a container spawn.
 *
 * Extracted from the previous inline `buildContainerArgs` in
 * `src/container-runner.ts` so the docker backend in `./docker.ts` can
 * call it without core having to know about docker semantics.
 *
 * Side effects: calls `onecli.applyContainerConfig` which mutates `args`
 * in-place (and may call `onecli.ensureAgent`). Logs success / failure but
 * never throws — credential injection failure is non-fatal here.
 */
import { OneCLI } from '@onecli-sh/sdk';

import { CONTAINER_IMAGE, CONTAINER_INSTALL_LABEL, ONECLI_API_KEY, ONECLI_URL, TIMEZONE } from '../config.js';
import { hostGatewayArgs, readonlyMountArgs } from '../container-runtime.js';
import { log } from '../log.js';

import type { SpawnSpec } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

export async function buildDockerArgs(spec: SpawnSpec): Promise<string[]> {
  const { agentGroup, containerName, containerConfig, providerContribution, agentIdentifier, mounts } = spec;

  const args: string[] = ['run', '--rm', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Backoffice MCP env passthrough (operator-supplied, see add-backoffice-tool
  // skill). The agent-runner gates the MCP server on these + a bind mount
  // and scrubs them from process.env after consumption.
  if (process.env.BO_API_URL) args.push('-e', `BO_API_URL=${process.env.BO_API_URL}`);
  if (process.env.BO_AUTH_TOKEN) args.push('-e', `BO_AUTH_TOKEN=${process.env.BO_AUTH_TOKEN}`);
  // Backoffice MCP package mount: when BACKOFFICE_MCP_PATH is set on the host,
  // bind-mount it at /opt/backoffice-mcp (the path the runner probes for
  // dist/index.js). Bypasses the additionalMounts allowlist because /opt/
  // can't be expressed there (mount-security forces /workspace/extra/...).
  if (process.env.BACKOFFICE_MCP_PATH) {
    args.push('-v', `${process.env.BACKOFFICE_MCP_PATH}:/opt/backoffice-mcp:ro`);
  }

  // Agent SSH key — operator-supplied dedicated key for git-over-SSH from
  // inside the container. Bypasses the additionalMounts allowlist (which
  // blocks `.ssh` paths by default). The host dir must contain id_ed25519,
  // id_ed25519.pub, known_hosts, and an SSH config; perms must already be
  // tight (700 dir, 600 keyfile) — SSH inside the container will refuse a
  // world-readable key. Mounted RO so the agent cannot replace the key.
  if (process.env.NANOCLAW_AGENT_SSH_DIR) {
    args.push('-v', `${process.env.NANOCLAW_AGENT_SSH_DIR}:/home/node/.ssh:ro`);
  }
  // GitHub PAT for `gh` CLI inside the container. The `gh` MCP server
  // (container/agent-runner/src/mcp-tools/gh.ts) inherits process.env, so
  // GH_TOKEN is picked up automatically with no extra wiring.
  if (process.env.GH_TOKEN) args.push('-e', `GH_TOKEN=${process.env.GH_TOKEN}`);

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection.
  try {
    if (agentIdentifier) {
      await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
    }
    const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
    if (onecliApplied) {
      log.info('OneCLI gateway applied', { containerName });
    } else {
      log.warn('OneCLI gateway not applied — container will have no credentials', { containerName });
    }
  } catch (err) {
    log.warn('OneCLI gateway error — container will have no credentials', { containerName, err });
  }

  // Host gateway
  args.push(...hostGatewayArgs());

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
  args.push('--entrypoint', 'bash');

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  args.push('-c', 'exec bun run /app/src/index.ts');

  return args;
}
