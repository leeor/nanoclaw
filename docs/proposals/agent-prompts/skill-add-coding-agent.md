# Prompt: `skill/add-coding-agent`

You are an autonomous agent working in `~/repos/nanoclaw-v2`. The branch `skill/add-coding-agent` already exists on origin (your fork). It contains the `containerBackend` registry refactor (commit `ae7533e79024`) — the **scaffolding** that lets a per-task devcontainer backend slot in. Your task: build out the rest of the feature skill on top of that branch.

This is the largest skill in the migration. Plan a 2.5–3 week effort. Decompose into sub-PRs to skill branch if needed; the operator can review incrementally.

## Goal

Ship `add-coding-agent` per upstream `CONTRIBUTING.md` skill model:

- Branch `skill/add-coding-agent` carries the trunk patches (registry + devcontainer backend + lifecycle + cost tracking + Linear integration + orphan scanner + retry proxy).
- `main`-side commit adds `.claude/skills/add-coding-agent/SKILL.md` (instructions only).
- User runs `/add-coding-agent` → Claude follows SKILL.md → fetches branch → cherry-picks/merges → builds.

The "feature" here is a **per-task devcontainer-backed coding agent** with PR monitoring, cost tracking, Linear ticket integration, orphan recovery, and graceful shutdown.

## What's already done

On branch `skill/add-coding-agent` (currently at `ae7533e79024`):

- `src/container-backends/types.ts` — `SpawnSpec`, `ContainerHandle`, `ContainerBackend` interfaces.
- `src/container-backends/registry.ts` — registry with register / get / list.
- `src/container-backends/docker-args.ts` — `buildDockerArgs(spec)` extracted from old `buildContainerArgs`.
- `src/container-backends/docker.ts` — registers `'docker'` as the default backend.
- `src/container-backends/index.ts` — barrel.
- Tests for registry + docker backend.
- `src/container-runner.ts` — refactored to dispatch via the registry.
- `src/container-config.ts` — adds `containerBackend?: string` field.
- `src/host-sweep.ts` + `src/modules/self-mod/apply.ts` — await async `killContainer`.

What's NOT done yet:

1. **Devcontainer backend** (`src/container-backends/devcontainer.ts`) — the actual `'devcontainer'` registration. Calls `devcontainer up` + `devcontainer exec`. Manages the per-workspace lifecycle, returns a `ContainerHandle` whose `.process` is the long-lived exec stream.
2. **OneCLI gateway integration for devcontainer** — the docker backend's OneCLI apply is in `docker-args.ts`. Devcontainer can't reuse `applyContainerConfig` (it produces docker run args). Devcontainer backend must call OneCLI itself — adapt the gateway's HTTPS_PROXY + cert injection into devcontainer's env passthrough.
3. **Coding-task module** (`src/modules/coding/`) — the host-side wiring. Subdirectories:
   - `index.ts` — entry point. Registers delivery actions, scheduling, etc.
   - `cost-summary.ts` + `cost-summary.test.ts` — port from v1 fork.
   - `orphan-scanner.ts` + tests — port from v1.
   - `worktree-locks.ts` — coding-agent-skill-local worktree mutex (see migration plan §"Concurrency-cap design note").
4. **Worktree-mutex DB table:**

   ```sql
   CREATE TABLE coding_worktree_locks (
     worktree_path  TEXT PRIMARY KEY,
     session_id     TEXT NOT NULL,
     acquired_at    TEXT NOT NULL,
     FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
   );
   ```

   Migration registered via the v2 migrations system. The skill owns this table.
5. **In-container retry proxy** (`container/agent-runner/src/local-proxy.ts`) — port from v1 fork. HTTP forwarder that retries with exponential backoff on `ECONNREFUSED` (host restart resilience).
6. **Container-side coding MCP** — gh CLI MCP, devcontainer-cli MCP, Linear MCP. Patterns already exist in `container/agent-runner/src/mcp-tools/`. Add new tool modules.
7. **PR monitor scheduled task** — uses v2's scheduling module (`src/modules/scheduling/`) to register a recurring task that polls PR state via `gh pr view`. Lives inside the session, not host-side cron.
8. **Cost summary delivery action** — agent writes a `messages_out` row with `kind='system'` and `action='coding_cost_summary'`. Skill registers a handler via `registerDeliveryAction(...)` that posts to Slack + adds a PR comment.
9. **Graceful shutdown handshake** — registers `onShutdown(...)` handler that enumerates active devcontainers, sends `_close` sentinel into their IPC dirs, waits for clean exit (with timeout fallback to `devcontainer stop`).
10. **`code-review-instructions.md`** — copy from v1 fork's `groups/coding_global/code-review-instructions.md`. Lives in skill branch under `groups/coding_global/code-review-instructions.md` so applying the skill restores it.

## Branch + decomposition

The full scope is too large for a single agent session. Decompose into N sequential sub-tasks on `skill/add-coding-agent`, committing each:

1. Devcontainer backend (#1–2 above) — single file + tests.
2. Coding-task module skeleton (#3, partial: `index.ts` only with empty hooks).
3. Worktree-mutex DB + helpers (#4).
4. Cost summary (#3 cost-summary, #8).
5. Orphan scanner (#3 orphan-scanner).
6. In-container retry proxy (#5).
7. Container-side coding MCP (gh, Linear, devcontainer-cli) (#6).
8. PR monitor scheduled task (#7).
9. Graceful shutdown (#9).
10. SKILL.md + code-review-instructions.md (on main + branch respectively).

Each sub-task commits separately. After each: `pnpm run build` + `pnpm test` clean before moving on.

## v1 reference

Most of this exists in v1 fork. Reference paths (read-only — DO NOT modify):

- `~/repos/nanoclaw/src/coding-task.ts` (~426 lines) — coding task lifecycle.
- `~/repos/nanoclaw/src/coding-cost-summary.ts` + test (~879 lines combined).
- `~/repos/nanoclaw/src/coding-orphan-scanner.ts` + test (~315 lines).
- `~/repos/nanoclaw/src/container-runner.ts` — devcontainer dispatch logic (the v1-flavored containerBackend).
- `~/repos/nanoclaw/container/agent-runner/src/local-proxy.ts` — in-container retry proxy.
- `~/repos/nanoclaw/container/agent-runner/src/ipc-mcp-stdio.ts` — coding agent's MCP IPC adapter.
- `~/repos/nanoclaw/groups/coding_global/CLAUDE.md` (will become `CLAUDE.local.md` on user's install via migration driver).
- `~/repos/nanoclaw/groups/coding_global/code-review-instructions.md`.

Port the *intent*, adapt to v2 patterns. Specifically:

- Replace v1's IPC-via-filesystem with v2's per-session `inbound.db` / `outbound.db`. The agent-runner already polls these — your container-side code drops the v1 IPC mechanics.
- Replace v1's `task-scheduler.ts` invocation with v2's scheduling module API.
- Replace v1's host-side cron with v2's per-session scheduling (see `src/modules/scheduling/recurrence.ts`).
- Replace v1's outbound delivery shim with `registerDeliveryAction(action, handler)`.

## Key architectural notes

- **One v2 session per coding task.** Session container = the devcontainer.
- **PR monitoring** runs as a scheduled task **inside the session**, recurring. Not host-side.
- **Cost summary** is a **delivery action** — agent writes `messages_out` with `kind='system', action='coding_cost_summary'`; host's registered handler posts to Slack + PR.
- **Linear MCP** is a container skill alongside the coding-agent module.
- **Worktree mutex** prevents two devcontainers from running concurrently in the same git worktree (would corrupt build state, branch state, package-lock). Per-worktree-path lock; sessions targeting different worktrees still run in parallel. No host-wide concurrency cap.
- **OneCLI gateway** must be applied by the devcontainer backend itself — the docker backend's apply is now bound to docker run args (in `docker-args.ts`). The devcontainer backend has its own env passthrough surface.

## Branch strategy

```bash
# Code on the skill branch:
git fetch fork skill/add-coding-agent
git checkout skill/add-coding-agent
# ... make changes, commit ...
git push fork skill/add-coding-agent

# SKILL.md goes on main:
git checkout main && git pull origin main
# ... add .claude/skills/add-coding-agent/SKILL.md ...
git commit -m "feat(skill): add /add-coding-agent"
git push fork main
```

PR target: cross-fork PR from `leeor:main` (with the SKILL.md commit) → `qwibitai:main`. The skill branch `skill/add-coding-agent` is referenced from SKILL.md and fetched at install time.

## SKILL.md (final step)

Add `.claude/skills/add-coding-agent/SKILL.md` on `main`:

```markdown
---
name: add-coding-agent
description: Add a per-task devcontainer-backed coding agent. Each coding task gets its own devcontainer wrapping a git worktree, with PR monitoring, Linear integration, cost tracking, and orphan recovery. Per-group enable via container.json containerBackend field.
---

# Add Coding Agent

(SKILL.md content — install steps, prerequisites, configuration, verification, removal — modeled on `init-onecli/SKILL.md` for shape and length.)
```

Keep SKILL.md under 500 lines. Move detailed background into the proposal docs and a separate `docs/coding-agent.md` if needed.

## Constraints

- **Keep existing commit intact**: `ae7533e79024` is the registry refactor; don't rebase or alter.
- **Sub-task per commit**: each of the 10 sub-tasks above is its own commit. Don't bundle.
- **Build + test clean** between sub-tasks. Don't accumulate broken state.
- **Worktree mutex is skill-local** — table lives in central DB but only this skill writes/reads it. No host-side hook needed.
- **Don't touch v1** (`~/repos/nanoclaw` read-only). Reference only.
- **Reference the registry proposal** in commits (`docs/proposals/2026-04-27-container-backend-registry.md`).

## Reference

- Migration plan: `~/repos/nanoclaw/docs/superpowers/plans/2026-04-26-v2-migration.md` §3.5 (Skill 3.5: skill/add-coding-agent — full scope + tests + effort).
- Proposal: `docs/proposals/2026-04-27-container-backend-registry.md`.
- v1 commits driving this skill: see migration plan Appendix A "Coding agent + cost tracking + devcontainer (~50 commits)".

## Verify

After each sub-task and at the end:

```bash
pnpm run build
pnpm test
./container/build.sh
```

End-to-end smoke (final):

1. Wire a Slack-based coding group (per migration plan, slack:C0ASK1YF06T → coding_ancr-668 already seeded).
2. From Slack, trigger a coding task: `@Ofleeor work on ANCR-668 issue`.
3. Confirm devcontainer spawns, agent runs, PR opens, cost summary posts back.
4. Restart NanoClaw mid-task; confirm orphan scanner gracefully stops the orphan + retry proxy keeps SDK requests alive.
5. Long-build resilience: `npm install` taking 10min — confirm v2 sweep doesn't kill (`tool_declared_timeout_ms` extends ceiling).

## Output

Write `docs/proposals/agent-prompts/skill-add-coding-agent-OUT.md` after EACH sub-task is committed (running diary, append per sub-task). Final entry: complete summary + reviewer notes + push status.

Push branches:

```bash
git push fork skill/add-coding-agent
git checkout main && git push fork main
```

## Done criteria

(Long checklist — abbreviated; see sub-task list above for detail.)

- [ ] Devcontainer backend registered in `src/container-backends/devcontainer.ts`.
- [ ] Coding module under `src/modules/coding/`.
- [ ] Worktree-mutex table + migration.
- [ ] In-container retry proxy.
- [ ] Container-side gh / devcontainer-cli / Linear MCP servers.
- [ ] PR monitor scheduled task.
- [ ] Cost summary delivery action.
- [ ] Orphan scanner.
- [ ] Graceful shutdown handler.
- [ ] All tests green.
- [ ] Container builds.
- [ ] End-to-end smoke clean.
- [ ] SKILL.md on `main`.
- [ ] OUT doc complete.
- [ ] Both branches pushed.
