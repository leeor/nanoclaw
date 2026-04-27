/**
 * Container backend types.
 *
 * A container backend is a strategy for spawning + stopping the per-session
 * agent container. The default backend is `'docker'` (`./docker.ts`); skills
 * can register additional backends (e.g. devcontainer, podman, kubernetes)
 * by adding files under `src/container-backends/` and appending an import
 * line to the `index.ts` barrel.
 *
 * Backend selection lives in `groups/<folder>/container.json` under the
 * optional `containerBackend` field (defaults to `'docker'`).
 */
import type { ChildProcess } from 'child_process';

import type { ContainerConfig } from '../container-config.js';
import type { ProviderContainerContribution, VolumeMount } from '../providers/provider-container-registry.js';
import type { AgentGroup, Session } from '../types.js';

export interface SpawnSpec {
  session: Session;
  agentGroup: AgentGroup;
  containerConfig: ContainerConfig;
  /** Host-unique name; chosen by core. */
  containerName: string;
  /** OneCLI agent id (= agentGroup.id). */
  agentIdentifier: string;
  /** Resolved provider name (claude, mock, opencode, ...). */
  provider: string;
  providerContribution: ProviderContainerContribution;
  /** Computed by core via buildMounts. */
  mounts: VolumeMount[];
}

export interface ContainerHandle {
  /**
   * Long-lived process reference; .stderr/.stdout streamed by core.
   * Must emit 'close' when the container exits.
   */
  process: ChildProcess;
  /** For kill / log tagging. */
  containerName: string;
  /** Backend-specific opaque state. Carried through to stop(). */
  meta?: Record<string, unknown>;
}

export interface ContainerBackend {
  /** Stable identifier — referenced from container.json `containerBackend`. */
  readonly name: string;

  /**
   * Spawn a container. Must return a handle whose .process emits 'close'
   * when the container exits. Core attaches stdio listeners and writes the
   * container_state row.
   */
  spawn(spec: SpawnSpec): Promise<ContainerHandle>;

  /**
   * Stop a running container gracefully. Must idempotently no-op if the
   * container is already gone. Should respect a short timeout (~1s) before
   * SIGKILL fallback — the caller will SIGKILL handle.process if stop()
   * throws.
   */
  stop(handle: ContainerHandle): Promise<void>;
}
