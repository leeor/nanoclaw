# Prompt: Container Backend Registry PR

You are an autonomous agent working in `~/repos/nanoclaw-v2`. Your task: implement the proposal in `docs/proposals/2026-04-27-container-backend-registry.md` exactly as specified there. Read that doc first — it has the full design.

## Goal

Refactor `src/container-runner.ts` so the docker spawn logic moves to `src/container-backends/docker.ts` registered against a new `ContainerBackend` registry, with dispatch via `container.json`'s new `containerBackend` field. Default to `'docker'`. Backwards-compatible.

## Branch

Create `feat/container-backend-registry` from `main`. Do not commit to `main` directly.

```bash
git checkout main
git pull origin main
git checkout -b feat/container-backend-registry
```

## Implementation

The proposal doc has the full design. Follow it. Do not deviate without recording the deviation in the PR description.

Concrete files to create / modify:

### Create

- `src/container-backends/types.ts` — `SpawnSpec`, `ContainerHandle`, `ContainerBackend` interfaces.
- `src/container-backends/registry.ts` — `registerContainerBackend`, `getContainerBackend`, `listContainerBackendNames`.
- `src/container-backends/registry.test.ts` — register / get / list / duplicate-name throw.
- `src/container-backends/docker-args.ts` — `buildDockerArgs(spec)`, extracted from current `buildContainerArgs` body.
- `src/container-backends/docker.ts` — registers the `'docker'` backend; uses `docker-args.ts`; calls `spawn(CONTAINER_RUNTIME_BIN, args, ...)` and `stopContainer(name)`.
- `src/container-backends/docker.test.ts` — spawn invocation builds correct args; stop calls stopContainer; SIGKILL fallback when stop throws.
- `src/container-backends/index.ts` — barrel: `import './docker.js';`.

### Modify

- `src/container-runner.ts`:
  - Add `import './container-backends/index.js';` (side-effect — registers docker).
  - Remove inline `spawn(CONTAINER_RUNTIME_BIN, args, ...)` from `spawnContainer`.
  - Add backend resolution: `const backendName = (containerConfig.containerBackend ?? 'docker').toLowerCase()` then `getContainerBackend(backendName)`.
  - Call `await backend.spawn({ session, agentGroup, containerConfig, containerName, agentIdentifier, provider, providerContribution: contribution, mounts })`.
  - Add `backend` and `meta` to `activeContainers` map value type.
  - `killContainer` becomes `async`; awaits `backend.stop(handle)`.
  - Move `buildContainerArgs` body to `docker-args.ts` (rename `buildDockerArgs`).

- `src/container-config.ts`:
  - Add `containerBackend?: string` to `ContainerConfig` interface.
  - Document: defaults to `'docker'`.

- `setup/migrate/seed-v2.ts`:
  - When writing per-group `container.json`, map v1's `containerType` field (legacy field used by the v1 fork's coding-agent) → v2's `containerBackend`. So `"containerType": "devcontainer"` → `"containerBackend": "devcontainer"`.

- `src/host-sweep.ts`:
  - Update calls to `killContainer(...)` to `await killContainer(...)`. Audit other callers.

### Tests

Add the listed test files. Existing tests should still pass.

## Verify

```bash
pnpm run build
pnpm test
```

Both must pass. If a pre-existing test is failing for unrelated reasons, note it in the PR description; don't claim done until at minimum no test that you touched is failing.

Smoke-check via `pnpm run dev` is optional but recommended. Container spawn should still work for the existing CLI agent.

## Output

When done, write a PR description to `docs/proposals/agent-prompts/pr-container-backend-OUT.md` containing:

- One-paragraph summary of the change.
- File-by-file diff summary.
- Any deviations from the proposal doc, with reasoning.
- Test results (passing count, any new tests added).
- Notes for the reviewer (edge cases, follow-ups, anything surprising encountered).

Then push the branch:

```bash
git push -u origin feat/container-backend-registry
```

The operator opens the PR manually after reviewing the OUT doc.

## Constraints

- **Backwards compatible**: any existing install with no `containerBackend` field in `container.json` continues to work.
- **No DB migration**: backend selection lives in `container.json`, not central DB.
- **Failsafe on missing backend**: if `containerBackend` references an unregistered name, log error and abort the spawn; do not silently fall back to docker.
- **Async `killContainer`**: change is mechanical; small fan-out. Audit all callers (grep `killContainer(` in `src/`).
- **Don't touch v1**: `~/repos/nanoclaw` is read-only.
- **Do not modify** `docs/proposals/2026-04-27-container-backend-registry.md`. If you find an issue with the design, record it in the OUT doc.

## Reference

- Existing related pattern: `src/providers/provider-container-registry.ts` — single-file registry, near-identical shape.
- v1 fork's coding-agent devcontainer integration (for context only — don't port from it): see `~/repos/nanoclaw/src/container-runner.ts:1-200` for the v1-flavored devcontainer dispatch logic.

## Done criteria

- [ ] Branch `feat/container-backend-registry` exists with all changes.
- [ ] All 7 new files created.
- [ ] All 4 modified files patched.
- [ ] `pnpm run build` clean.
- [ ] `pnpm test` clean.
- [ ] Smoke test via `pnpm run dev` + `pnpm run chat hi` works (existing default-docker path).
- [ ] OUT doc written.
- [ ] Branch pushed.
