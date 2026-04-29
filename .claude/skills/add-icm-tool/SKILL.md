---
name: add-icm-tool
description: Add ICM (Infinite Context Memory) MCP integration. Per-group opt-in via container.json — gives an agent a persistent semantic memory store (memories.db) under groups/<folder>/.icm/.
---

# Add ICM Tool

Adds the ICM (Infinite Context Memory) binary to the container image and wires `icm serve --compact` as an MCP server for any agent group that opts in. Each opted-in group gets its own persistent memory store under `groups/<folder>/.icm/` with multilingual-e5-base embeddings enabled — survives container restarts via the `/workspace/agent` bind mount.

The binary is always present in the rebuilt image; per-group opt-in via `mcpServers.icm` in `groups/<folder>/container.json` decides which agents actually get the `mcp__icm__*` tools.

## Phase 1: Pre-flight

### Check if already applied

Check whether the merge has already happened:

```bash
test -f container/agent-runner/src/icm-init.ts && echo "already applied"
```

If it exists, skip to Phase 3 (per-group enable).

### Confirm we're on main (or close to it)

```bash
git status
git log --oneline -1
```

The user should be on `main` with a clean working tree. If there are uncommitted changes, ask them to commit or stash before continuing — a merge conflict on dirty state is a bad time.

## Phase 2: Apply Code Changes

### Ensure upstream remote

```bash
git remote -v
```

If `upstream` is missing, add it:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch upstream skill/add-icm-tool
git merge upstream/skill/add-icm-tool
```

This merges in:

- `container/Dockerfile` — switches base to `node:22-trixie-slim`, bumps `libasound2` → `libasound2t64`, adds the ICM install block (downloads the `icm` binary from the rtk-ai/icm GitHub release, amd64 `.deb` or arm64 tarball).
- `container/agent-runner/src/icm-init.ts` — idempotent helper that initializes `<groupDir>/.icm/config.toml` on first call and returns its absolute path.
- `container/agent-runner/src/index.ts` — when a group's `container.json` declares `mcpServers.icm` without `ICM_CONFIG`, the runner calls `ensureIcmConfig()` and auto-fills the env var. Operator config stays minimal.
- `container/agent-runner/src/providers/claude.ts` — adds `mcp__icm__*` to `allowedTools` only when the group actually wired the icm server.
- `container/agent-runner/src/icm-init.test.ts` — bun:test coverage for the helper.

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides. The most likely conflict zones are the `apt-get` block in `Dockerfile` (if other skills also patch system deps) and the `mcpServers` loop / `allowedTools` array in the agent-runner.

### Validate the merge

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm test
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

All four must succeed. If `pnpm test` fails on the new `icm-init.test.ts`, it's because that test runs under bun, not vitest — `vitest.config.ts` already excludes the `container/agent-runner/` tree, so it should be skipped automatically. Container-side tests run with:

```bash
cd container/agent-runner && bun test
```

(only if the user has bun installed locally; otherwise rely on CI).

### Rebuild the container image

```bash
./container/build.sh
```

The build will re-pull the base image and download the ICM binary — first build takes longer than usual.

Verify the binary landed in the image:

```bash
docker run --rm --entrypoint /bin/sh nanoclaw-agent:v2 -c 'icm --version'
```

Expect a version string like `icm 0.x.y`. If you get "command not found", the install block didn't run cleanly — check the build output for arch mismatch or download failure.

## Phase 3: Enable per group

ICM is opt-in per agent group. For every group that should get persistent memory, edit `groups/<folder>/container.json` and add an `icm` entry under `mcpServers`:

```json
{
  "mcpServers": {
    "icm": {
      "command": "icm",
      "args": ["serve", "--compact"],
      "env": {}
    }
  }
}
```

Leave `env` empty — the runner auto-populates `ICM_CONFIG` to point at `groups/<folder>/.icm/config.toml`, creating the file on first run with multilingual-e5-base embeddings enabled.

If the group already has other `mcpServers` entries, add `icm` alongside them — don't replace.

### Restart the service so new sessions pick up the change

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# Linux: systemctl --user restart nanoclaw
```

Existing sessions need to be killed and respawned for the new MCP wiring to apply (the agent-runner reads `container.json` once at startup).

## Phase 4: Migrate existing ICM state (optional)

If the user is migrating from the v1 fork and already has memories they want to keep:

```bash
cp -a ~/repos/nanoclaw.v1-backup/groups/<folder>/.icm groups/<folder>/
```

Skip if this is a fresh install — the runner will create `.icm/` on first start.

## Phase 5: Verify

After the rebuild + restart, send the agent (in any group you opted in) a test message:

> "remember that my favorite color is purple"

Then in a follow-up session:

> "what's my favorite color?"

The agent should call `mcp__icm__store` on the first message and `mcp__icm__search` (or similar) on the second.

Spot checks if it's not working:

```bash
# config initialized on first run?
ls groups/<folder>/.icm/

# memories accumulating?
sqlite3 groups/<folder>/.icm/memories.db '.tables'
```

If `mcp__icm__*` tools are missing entirely, check the agent-runner logs for the `Additional MCP server: icm` line — if it's absent, `mcpServers.icm` isn't being read from `container.json`. If it's present but the agent claims the tools aren't available, restart the session (allowedTools is set at session start).

## Troubleshooting

**`icm --version` fails inside the container.** The install block likely didn't run — check the build output. Most common cause: the GitHub release URL is unreachable from the build host. Re-run `./container/build.sh` once network is back.

**Agent says `mcp__icm__store` is not available.** Either the group's `container.json` doesn't have the `icm` entry, or the running session predates the change. Restart the service and let the next message spawn a fresh session.

**Memories don't persist across container restarts.** Check that `groups/<folder>/.icm/memories.db` exists on the host (not just inside the container). If it's missing, the `/workspace/agent` mount is broken — see `docs/db.md` for the mount layout.

**Conflict during merge on `Dockerfile`.** Trixie's `libasound2t64` is the t64 transition package; if another skill changed the apt block too, take the union (keep both packages — `libasound2t64` only). The base image must be `node:22-trixie-slim` for ICM's apt deps to resolve.
