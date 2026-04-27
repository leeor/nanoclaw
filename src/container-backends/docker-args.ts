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
