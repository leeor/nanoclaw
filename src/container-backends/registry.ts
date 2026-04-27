/**
 * Container backend registry.
 *
 * Backends register themselves at module load time (see `./docker.ts` for
 * the canonical example). The `container-runner` resolves the desired
 * backend by name from `container.json` `containerBackend` (defaults to
 * `'docker'`) and dispatches via the registered backend's `spawn`/`stop`.
 *
 * Mirrors the shape of `src/providers/provider-container-registry.ts`.
 */
import type { ContainerBackend } from './types.js';

const registry = new Map<string, ContainerBackend>();

export function registerContainerBackend(backend: ContainerBackend): void {
  if (registry.has(backend.name)) {
    throw new Error(`Container backend already registered: ${backend.name}`);
  }
  registry.set(backend.name, backend);
}

export function getContainerBackend(name: string): ContainerBackend | undefined {
  return registry.get(name);
}

export function listContainerBackendNames(): string[] {
  return [...registry.keys()];
}

/**
 * Test-only helper. Removes a backend from the registry so a test can
 * register a fresh fake without colliding with a previous test's
 * registration. Not exported from the barrel — internal to the test suite.
 */
export function _unregisterContainerBackendForTest(name: string): void {
  registry.delete(name);
}
