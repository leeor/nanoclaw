# PR: Container Backend Registry

**Branch:** `feat/container-backend-registry`
**Base:** `main`
**Commit:** `ae7533e79024`
**Status:** Local commit only — push skipped (origin is `qwibitai/nanoclaw`, current user has read-only access; operator handles publishing).

---

## Summary

Refactors `src/container-runner.ts` so the docker spawn logic is now one of several pluggable container backends, dispatched via a new `containerBackend` field on `container.json` (defaulting to `'docker'`). The default docker spawn path moved wholesale into `src/container-backends/docker.ts` (registered against the new registry), with `buildContainerArgs` extracted to `src/container-backends/docker-args.ts` as `buildDockerArgs(spec)`. This removes the only structural blocker for the coding-agent skill to install a `'devcontainer'` backend without monkey-patching trunk. Backwards compatible: every existing install with no `containerBackend` field continues to spawn via docker. An unregistered backend name is a hard failure (logs the available set, aborts the spawn) — never a silent fallback.

## File-by-file

### Created

- **`src/container-backends/types.ts`** — `SpawnSpec`, `ContainerHandle`, `ContainerBackend` interfaces. Mirrors the proposal verbatim.
- **`src/container-backends/registry.ts`** — `registerContainerBackend`, `getContainerBackend`, `listContainerBackendNames`. Plus a test-only `_unregisterContainerBackendForTest(name)` so `registry.test.ts` can produce duplicate-name failures deterministically.
- **`src/container-backends/registry.test.ts`** — covers register + get round-trip, list, duplicate-name throw, and undefined-on-miss.
- **`src/container-backends/docker-args.ts`** — `buildDockerArgs(spec: SpawnSpec)` extracted from the old inline `buildContainerArgs` body. Owns the OneCLI gateway apply and reads CONTAINER_IMAGE / CONTAINER_INSTALL_LABEL / TIMEZONE / hostGatewayArgs / readonlyMountArgs.
- **`src/container-backends/docker.ts`** — registers the `'docker'` backend. `spawn` calls `buildDockerArgs` then `child_process.spawn(CONTAINER_RUNTIME_BIN, args, ...)`. `stop` calls `stopContainer(containerName)` from `container-runtime.ts`. (The proposal's pseudocode swallowed stop errors with an inline SIGKILL — I kept the rejection behavior so the caller in `killContainer` does the SIGKILL fallback, which matches the spec sentence "the caller will SIGKILL the .process if stop() throws.")
- **`src/container-backends/docker.test.ts`** — mocks `child_process.spawn`, `child_process.execSync`, `@onecli-sh/sdk`. Asserts spawn was invoked with `CONTAINER_RUNTIME_BIN` + an arg list that contains the RW mount, the `:ro` RO mount, and ends with `exec bun run /app/src/index.ts`. Asserts stop calls `docker stop -t 1 <name>`. Asserts stop rejects when `stopContainer` throws (so the caller can SIGKILL fall back).
- **`src/container-backends/index.ts`** — barrel: `import './docker.js';`. Skills append additional backend imports here.

### Modified

- **`src/container-runner.ts`**:
  - Removed `import {OneCLI}` and the module-scope `onecli` instance — they moved into `docker-args.ts` where the gateway apply now lives.
  - Removed `spawn` from `child_process` import (the backend owns spawning); kept `execSync` for image builds.
  - Removed unused `hostGatewayArgs`, `readonlyMountArgs`, `stopContainer`, `TIMEZONE`, `CONTAINER_INSTALL_LABEL`, `ONECLI_*` imports.
  - Added `import './container-backends/index.js'` (side-effect — registers docker) and pulled `getContainerBackend`, `listContainerBackendNames`, `ContainerBackend`.
  - `activeContainers` value type now carries `backend: ContainerBackend` and `meta?: Record<string, unknown>`.
  - In `spawnContainer`, after `buildMounts` + `containerName` resolution: resolve backend via `(containerConfig.containerBackend ?? 'docker').toLowerCase()`, log + return on miss, otherwise `await backend.spawn({...})` with the full SpawnSpec. The new heartbeat-clear `fs.rmSync(...)` runs *before* the backend spawn (same as before — it's part of pre-spawn setup).
  - `spawnContainer` now wraps `backend.spawn()` in a try/catch — backend errors are logged and the function returns instead of bubbling, matching the existing on-error semantics.
  - `killContainer` is now `async`, awaits `backend.stop(handle)`, falls back to `entry.process.kill('SIGKILL')` when stop throws (this preserves the exact pre-existing fallback semantics).
  - The whole `buildContainerArgs` body was deleted from this file.

- **`src/container-config.ts`**: Added `containerBackend?: string` to `ContainerConfig` with a docstring noting the `'docker'` default and the no-silent-fallback behavior. Added it to the `readContainerConfig` projection so it round-trips through the file.

- **`src/host-sweep.ts`**: `enforceRunningContainerSla` is now `async` and awaits both `killContainer` calls. Its caller in `sweepSession` updated to `await`. No other behavior change.

- **`src/modules/self-mod/apply.ts`**: Both `killContainer(...)` calls (post-rebuild and post-mcp-add) now `await`. Both already lived inside `async` handlers — no signature changes needed.

### Not modified (deviation, see below)

- `setup/migrate/seed-v2.ts` — see Deviations.

## Deviations

### `setup/migrate/seed-v2.ts` mapping omitted

**Reason:** the file does not exist on `main`. It's only present on the unmerged `migrate/v1-to-v2` branch (per `git log --all -- setup/migrate/seed-v2.ts` → single commit `96dd77c911d2`, only on that branch). Since the prompt instructed to branch from `main` *and* push status is local-only, modifying a file that isn't on main would create a phantom-file diff that conflicts at merge time.

**What needs to happen later:** when `migrate/v1-to-v2` lands, the v1→v2 mapping should be added to `translateContainerConfig()` so a v1 `container_config.containerType` field becomes a v2 `containerBackend` field. The relevant location on `migrate/v1-to-v2` is `setup/migrate/seed-v2.ts:407` (`translateContainerConfig`), and the V1 type interface at `:130`. A two-line change:

```ts
// V1ContainerConfig:
interface V1ContainerConfig {
  additionalMounts?: V1AdditionalMount[];
  timeout?: number;
  containerType?: string;   // <- add
}

// translateContainerConfig:
return {
  mcpServers: {},
  packages: { apt: [], npm: [] },
  additionalMounts: mounts,
  skills: 'all',
  ...(c.containerType ? { containerBackend: c.containerType } : {}),
};
```

This deviation is purely an ordering/branch-topology issue, not a semantic change to the design.

### `dockerBackend.stop` propagates instead of swallowing

The proposal's pseudocode for `dockerBackend.stop` had a `try { stopContainer(...) } catch { handle.process.kill('SIGKILL') }` block. The prose immediately following said "the caller will SIGKILL the .process if stop() throws" — these contradict. I went with the prose: `stop()` rejects, and `killContainer` (the caller) does the SIGKILL fallback. This keeps responsibility for the .process reference solely in core, which is cleaner — backends shouldn't be touching the underlying ChildProcess.

### Test-only `_unregisterContainerBackendForTest`

The proposal's test plan for `registry.test.ts` lists "duplicate-name throw." Since registry state is module-global and the test framework runs tests in the same process where `docker.ts` has already self-registered `'docker'`, I added an internal `_unregister` helper exported from `registry.ts` (prefixed with underscore to mark it test-only). It is not exported from any barrel.

## Test results

- `pnpm run build` — clean, no errors.
- `pnpm test` — **204 passed (204) across 25 test files.** Includes 4 new tests in `registry.test.ts` and 3 new tests in `docker.test.ts`. The pre-existing `container-runner.test.ts` (which tests `resolveProviderName`) and `host-sweep.test.ts` (decideStuckAction unit tests) both still pass unchanged.
- Container smoke test (`pnpm run dev` + `pnpm run chat hi`): not run — see Reviewer notes.

## Reviewer notes

1. **Module-load side effect chain.** `container-runner.ts` imports `./container-backends/index.js`, which imports `./docker.js`, which calls `registerContainerBackend`. That side-effect chain is the only thing that gets the default backend into the registry — if a future refactor moves the import or makes it lazy, the default-docker fallback in `spawnContainer` will fail with "No container backend registered." The pattern is borrowed from `src/providers/index.ts` and matches that file 1:1.

2. **`container-runtime.ts` is unchanged.** `CONTAINER_RUNTIME_BIN`, `hostGatewayArgs`, `readonlyMountArgs`, `stopContainer`, `cleanupOrphans`, `ensureContainerRuntimeRunning` all still live there. The docker backend uses them; future backends may not. If a `'devcontainer'` backend lands, it'll likely keep using `cleanupOrphans` (still scoped by install label) but bypass `stopContainer` (which assumes `docker stop` semantics). No change needed today.

3. **OneCLI gateway moved into docker-args.ts.** This means installs that opt into a non-docker backend will not get the OneCLI gateway by default — the new backend has to call OneCLI itself. That's correct (devcontainer doesn't take docker run args, so we can't reuse `applyContainerConfig`), but worth flagging in the coding-agent skill when it lands.

4. **No smoke test was run.** The repo currently has no running NanoClaw service on this machine to chat against, and `pnpm run dev` would require OneCLI + at least one channel adapter. The host build + 204 tests pass; the docker spawn args composition is unit-tested. If a manual verification is desired before merging, the operator can:
   - `pnpm run dev` (or kickstart launchd).
   - Send a DM to an existing agent.
   - Confirm a container spawns (`docker ps` shows `nanoclaw-v2-*`) and replies.

5. **Follow-ups.** Add the `seed-v2.ts` mapping when `migrate/v1-to-v2` merges. Update `docs/architecture.md` with a "Container backends" section (the proposal's step 7) — left for a docs-only commit.
