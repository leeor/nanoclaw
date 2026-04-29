# Container Backend Registry

**Date:** 2026-04-27
**Status:** Proposal — pre-PR
**Owner:** Leeor

---

## Problem

`spawnContainer` in `src/container-runner.ts:79` is hardcoded to `docker run` via the abstraction in `src/container-runtime.ts:11` (`CONTAINER_RUNTIME_BIN = 'docker'`). The runtime abstraction lets you swap docker for podman or apple-container, but does **not** let two different *backend strategies* coexist within one install.

That blocks the **coding-agent** skill, which needs:

- A devcontainer per coding task (not a generic container image): `devcontainer up --workspace-folder <repo>`, then `devcontainer exec` to run the agent runner inside the user's actual repo workspace.
- Per-task isolation by repo + branch + lockfile state.
- Different mount + lifecycle semantics than `docker run --rm`.

Today, only one host-side spawn path exists. Without per-session backend selection, the coding-agent skill must monkeypatch `wakeContainer` / `spawnContainer`, and that monkeypatch breaks on every `/update-nanoclaw` cycle.

## Current code

- `src/container-runner.ts:62` — `wakeContainer(session)` entry point. Dedup via `wakePromises` map. Calls `spawnContainer`.
- `src/container-runner.ts:79` — `spawnContainer(session)`. Reads agent group, container.json, provider, builds mounts, builds CLI args, spawns docker.
- `src/container-runner.ts:113` — `buildContainerArgs(...)` produces docker CLI args (image, env, volumes, etc).
- `src/container-runner.ts:125` — `spawn(CONTAINER_RUNTIME_BIN, args, ...)` literal docker spawn.
- `src/container-runner.ts:127` — `activeContainers.set(session.id, { process: container, containerName })` — bookkeeping for kill/stop.
- `src/container-runner.ts:145–157` — close/error handlers.
- `src/container-runner.ts:161` — `killContainer(sessionId, reason)` → calls `stopContainer(containerName)` from `container-runtime.ts`.
- `src/container-runtime.ts:11–32` — `CONTAINER_RUNTIME_BIN`, `hostGatewayArgs`, `readonlyMountArgs`, `stopContainer`. All assume docker semantics.

## Proposed change

### 1. Define `ContainerBackend` interface

New file: `src/container-backends/types.ts`

```typescript
import type { ChildProcess } from 'child_process';

import type { AgentGroup, Session } from '../types.js';
import type { ContainerConfig } from '../container-config.js';
import type { ProviderContainerContribution, VolumeMount } from '../providers/provider-container-registry.js';

export interface SpawnSpec {
  session: Session;
  agentGroup: AgentGroup;
  containerConfig: ContainerConfig;
  containerName: string;          // host-unique name; chosen by core
  agentIdentifier: string;        // OneCLI agent id (= agentGroup.id)
  provider: string;               // resolved provider name (claude, mock, opencode, ...)
  providerContribution: ProviderContainerContribution;
  mounts: VolumeMount[];          // computed by core via buildMounts
}

export interface ContainerHandle {
  process: ChildProcess;          // long-lived process reference; .stderr/.stdout streamed by core
  containerName: string;          // for kill / log tagging
  /** Backend-specific opaque state. Carried through to stop(). */
  meta?: Record<string, unknown>;
}

export interface ContainerBackend {
  /** Stable identifier — referenced from container.json `containerBackend`. */
  readonly name: string;

  /**
   * Spawn a container. Must return a handle whose .process emits 'close'
   * when the container exits. core attaches stdio listeners and writes the
   * container_state row.
   */
  spawn(spec: SpawnSpec): Promise<ContainerHandle>;

  /**
   * Stop a running container gracefully. Must idempotently no-op if the
   * container is already gone. Should respect a short timeout (~1s) before
   * SIGKILL fallback — the caller will SIGKILL the .process if stop() throws.
   */
  stop(handle: ContainerHandle): Promise<void>;
}
```

### 2. Registry

New file: `src/container-backends/registry.ts`

```typescript
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
```

### 3. Extract docker logic to a backend

New file: `src/container-backends/docker.ts`

Moves the existing `buildContainerArgs` + `spawn(...)` logic out of `container-runner.ts`. Registers itself as `'docker'`.

```typescript
import { spawn } from 'child_process';

import { CONTAINER_RUNTIME_BIN, stopContainer } from '../container-runtime.ts';
import { buildDockerArgs } from './docker-args.js';   // moved out of container-runner
import { registerContainerBackend } from './registry.js';
import type { ContainerBackend, SpawnSpec, ContainerHandle } from './types.js';

const dockerBackend: ContainerBackend = {
  name: 'docker',

  async spawn(spec: SpawnSpec): Promise<ContainerHandle> {
    const args = await buildDockerArgs(spec);
    const process = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    return { process, containerName: spec.containerName };
  },

  async stop(handle: ContainerHandle): Promise<void> {
    try {
      stopContainer(handle.containerName);
    } catch {
      handle.process.kill('SIGKILL');
    }
  },
};

registerContainerBackend(dockerBackend);
```

### 4. Backend barrel

New file: `src/container-backends/index.ts`

```typescript
// Backend self-registration barrel. Default backends only.
// Skills add backends by appending an import line below.
import './docker.js';
```

### 5. Container runner dispatch

Patch `src/container-runner.ts:79` (`spawnContainer`). Replace the inline docker spawn with backend dispatch:

```typescript
import './container-backends/index.js';
import { getContainerBackend, listContainerBackendNames } from './container-backends/registry.js';

// inside spawnContainer, after buildMounts + containerName resolution:
const backendName = (containerConfig.containerBackend ?? 'docker').toLowerCase();
const backend = getContainerBackend(backendName);
if (!backend) {
  log.error('No container backend registered', {
    requested: backendName,
    available: listContainerBackendNames(),
    sessionId: session.id,
  });
  return;
}

log.info('Spawning container', {
  sessionId: session.id,
  agentGroup: agentGroup.name,
  containerName,
  backend: backend.name,
});

const handle = await backend.spawn({
  session,
  agentGroup,
  containerConfig,
  containerName,
  agentIdentifier,
  provider,
  providerContribution: contribution,
  mounts,
});

activeContainers.set(session.id, { process: handle.process, containerName, backend, meta: handle.meta });
markContainerRunning(session.id);

// stderr/stdout/close/error wiring stays in container-runner — backend-agnostic.
```

`killContainer` becomes:

```typescript
export async function killContainer(sessionId: string, reason: string): Promise<void> {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName, backend: entry.backend.name });
  try {
    await entry.backend.stop({ process: entry.process, containerName: entry.containerName, meta: entry.meta });
  } catch {
    entry.process.kill('SIGKILL');
  }
}
```

(callers of `killContainer` need to await — small fan-out: `host-sweep.ts`, `delivery.ts` graceful shutdown.)

### 6. Container config schema

Patch `src/container-config.ts` to add the optional field:

```typescript
export interface ContainerConfig {
  // ... existing fields ...
  /**
   * Selects a container backend. Backends are registered via
   * `src/container-backends/`. Defaults to 'docker'.
   */
  containerBackend?: string;
}
```

`groups/<folder>/container.json`:

```json
{
  "containerBackend": "devcontainer",
  "mcpServers": { ... },
  "additionalMounts": [ ... ]
}
```

The driver's seed step (`setup/migrate/seed-v2.ts`) already writes per-group `container.json` from the v1 `container_config` JSON column. Migration row's `containerType: "devcontainer"` field (already present in v1 fork) becomes `containerBackend: "devcontainer"` in v2 — small mapping addition in seed.

### 7. No DB migration

Backend selection lives in `container.json`, not the central DB. Keeps the change to the file system, schema-stable.

## Backwards compatibility

- `containerBackend` field is **optional**. Missing → defaults to `'docker'`.
- Existing installs see no behavior change; no migration runs, no seed touches container.json that doesn't already use the new field.
- `killContainer` becoming async is the only API surface change. Callers must `await`. There are 2–3 call sites; the change is mechanical.

## Test plan

New tests under `src/container-backends/`:

- `registry.test.ts` — register / get / list / duplicate-name throw.
- `docker.test.ts` — spawn invocation builds the right args; stop calls `stopContainer`; SIGKILL fallback when stop throws.

Existing tests:

- `container-runner.test.ts` — confirm dispatch lookup still works for default 'docker' (no regression).
- `host-sweep.test.ts` — confirm async killContainer integrates without race regression.

A skill-side test (lives in `skill/add-coding-agent`) registers a fake `'devcontainer'` backend, sets `containerBackend: 'devcontainer'` in a test container.json, and asserts dispatch reaches the fake.

## Implementation steps

1. Create `src/container-backends/{types.ts, registry.ts, registry.test.ts, docker.ts, docker-args.ts, docker.test.ts, index.ts}`.
2. Move the existing `buildContainerArgs` body from `container-runner.ts` into `container-backends/docker-args.ts` (function rename to `buildDockerArgs`).
3. Patch `container-runner.ts`:
   - Remove inline `spawn(CONTAINER_RUNTIME_BIN, ...)` block.
   - Add import of `./container-backends/index.js` (side-effect — registers docker).
   - Replace inline spawn with `backend.spawn({...})`.
   - Add `backend` field to `activeContainers` value type.
   - Make `killContainer` async; await `backend.stop`.
4. Patch `src/container-config.ts` — add `containerBackend?: string` to `ContainerConfig`.
5. Patch `setup/migrate/seed-v2.ts` — when writing per-group container.json, map v1 `containerType` → `containerBackend`.
6. Update `host-sweep.ts` and any other `killContainer` caller to await.
7. Update `docs/architecture.md` — new section on container backends.
8. Run full test suite.

## Effort estimate

Refactor + extraction: ~300 lines moved, ~100 lines new (types + registry + tests). 1–2 days of focused work.

PR turnaround on upstream: 1–2 weeks (typical for architectural changes).

## Open questions

1. Should backend selection live on `agent_groups` (DB column) instead of `container.json`? DB is stricter (one source of truth, can't drift between tree and DB). container.json is more flexible (operator can edit, version-controlled per group). **Lean: container.json for v2; promote to DB only if cross-group-policy needs emerge.**
2. Should `stop()` and `spawn()` accept a deadline? Currently `stopContainer` uses `-t 1` (1s grace). For slow backends (devcontainer cleanup is heavier), backends may want their own grace logic — interface allows this since they own the implementation.
3. Should the registry support unregister? Probably not — skills install once at boot. Skip until proven needed.
