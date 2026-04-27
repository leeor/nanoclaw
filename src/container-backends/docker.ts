/**
 * Docker container backend — the default `containerBackend` for v2 installs.
 *
 * Spawns a one-shot `docker run --rm` per session and tracks the resulting
 * ChildProcess. Stop is a graceful `docker stop -t 1` via
 * `container-runtime.stopContainer`; if that throws the caller (`killContainer`
 * in container-runner.ts) handles SIGKILL fallback through the .process ref.
 */
import { spawn } from 'child_process';

import { CONTAINER_RUNTIME_BIN, stopContainer } from '../container-runtime.js';

import { buildDockerArgs } from './docker-args.js';
import { registerContainerBackend } from './registry.js';
import type { ContainerBackend, ContainerHandle, SpawnSpec } from './types.js';

const dockerBackend: ContainerBackend = {
  name: 'docker',

  async spawn(spec: SpawnSpec): Promise<ContainerHandle> {
    const args = await buildDockerArgs(spec);
    const proc = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    return { process: proc, containerName: spec.containerName };
  },

  async stop(handle: ContainerHandle): Promise<void> {
    // stopContainer is sync (execSync). Wrap so backend authors can rely on
    // a Promise-returning stop without paying attention to the underlying
    // implementation.
    stopContainer(handle.containerName);
  },
};

registerContainerBackend(dockerBackend);

export { dockerBackend };
