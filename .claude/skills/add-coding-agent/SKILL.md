---
name: add-coding-agent
description: Add a per-task devcontainer-backed coding agent. Each coding task gets its own devcontainer wrapping a git worktree, with PR monitoring, Linear integration, cost tracking, and orphan recovery. Per-group enable via container.json containerBackend field.
---

# Add Coding Agent

Adds a devcontainer-backed agent group that runs each coding task in its own per-worktree devcontainer. Use when you want NanoClaw to open PRs, push commits, monitor CI, and post cost summaries back to chat — separate from your regular DM agent.

## What you can do with this

- **Trigger from chat** — message your coding agent group "work on issue ANCR-668"; the agent spins up a devcontainer in a fresh git worktree and gets to work.
- **PR monitoring** — once a PR is open, a recurring scheduled task (inside the session) polls `gh pr view`, watches review state, and notifies you on changes.
- **Cost summary** — when the task completes the agent posts a tokens / dollar summary to the originating channel and optionally as a PR comment.
- **Orphan recovery** — if the host crashes mid-task, the orphan scanner reconciles the worktree-lock table with running devcontainers on next startup.
- **Concurrency-safe** — the worktree mutex blocks two coding tasks from racing in the same worktree; tasks targeting different worktrees run in parallel.

## Prerequisites

- `devcontainer` CLI on PATH (`npm i -g @devcontainers/cli`). The skill respects `DEVCONTAINER_BIN` if you keep the binary elsewhere.
- A git repo (or worktree-able workspace) with a `.devcontainer/devcontainer.json` configured. The skill does not generate this — point at an existing one. **No changes required to the repo's devcontainer.json**: the backend bind-mounts `/app/src`, `/app/skills`, the session dir, and the group dir on `devcontainer up`, and installs Bun on demand inside the container if it isn't already on PATH.
- `gh` CLI authenticated against the repo's host (PR open / view / comment).
- OneCLI Agent Vault running. The devcontainer backend wires `HTTPS_PROXY` + cert injection through `--remote-env` so the agent's Anthropic + Linear + GitHub calls flow through the vault. If you haven't set OneCLI up, run `/init-onecli` first.

## Install

This skill copies the devcontainer backend, the coding-task module, the worktree-lock table migration, and a starter `groups/coding_global/` from the `skill/add-coding-agent` branch into trunk.

### Pre-flight (idempotent)

Skip to **Configure** if all of these exist:

- `src/container-backends/devcontainer.ts`
- `src/modules/coding/index.ts`
- `src/db/migrations/module-coding-worktree-locks.ts`
- `groups/coding_global/code-review-instructions.md`

Otherwise continue.

### 1. Fetch the skill branch

```bash
git fetch origin skill/add-coding-agent
```

### 2. Merge the branch

```bash
git merge origin/skill/add-coding-agent --no-ff -m "feat: install /add-coding-agent"
```

If the merge reports conflicts in `src/container-backends/index.ts`, `src/modules/index.ts`, or `src/db/migrations/index.ts`, resolve by keeping **both** the existing imports and the coding-agent imports. These files are append-only registries.

### 3. Install dependencies

The skill adds no new npm packages — it relies on the `devcontainer` CLI being available system-wide.

```bash
pnpm install --frozen-lockfile
```

### 4. Build

```bash
pnpm run build
```

### 5. Run migrations

The migration creates `coding_worktree_locks`. It runs on next NanoClaw startup; you can also force it now:

```bash
pnpm tsx -e 'import("./src/db/connection.js").then(async (c) => { c.initDb("./data/v2.db"); const { runMigrations } = await import("./src/db/migrations/index.js"); runMigrations(c.getDb()); c.closeDb(); })'
```

## How agents spawn coding tasks

Once installed, **any agent that has the `create_coding_task` MCP tool** can spawn a per-task coding agent on demand. Two ways to point at a repo:

### A. By name from the `repos` registry (preferred — multi-repo)

Declare your repos once in the parent agent's `container.json`:

```json
{
  "additionalMounts": [
    { "hostPath": "/Users/me/code/mono",    "containerPath": "repos/mono" },
    { "hostPath": "/Users/me/code/billing", "containerPath": "repos/billing" }
  ],
  "repos": {
    "mono":    { "containerPath": "repos/mono/master",  "defaultBaseBranch": "origin/last-green" },
    "billing": { "containerPath": "repos/billing",      "defaultBaseBranch": "origin/main" },
    "infra":   { "containerPath": "repos/infra",        "defaultBaseBranch": "origin/main",
                 "worktreeRoot": "repos/infra-worktrees" }
  }
}
```

Then the parent agent calls:

```
mcp__nanoclaw__create_coding_task({
  ticket_id: "BILL-42",
  repo: "billing",
  context: "Add monthly invoice email template."
})
```

The host resolves `repo: "billing"` → `containerPath: "repos/billing"` (translated to host via `additionalMounts`), uses the registry's `defaultBaseBranch`, and (if `worktreeRoot` is set) places the worktree under that root instead of as a sibling of master.

`base_branch` argument always overrides the registry default for one-off bases like `origin/release-2026-04`.

### B. By explicit path (one-off)

```
mcp__nanoclaw__create_coding_task({
  ticket_id: "ANCR-919",
  repo_master_path: "/workspace/extra/repos/mono/master",
  context: "Fix N+1 query in proposals CSV export.",
  plan_path: "/workspace/extra/repos/mono/master/docs/plans/2026-04-27-fix-n1.md"
})
```

Use this only when the repo isn't in the registry. Fields are mutually exclusive — pass `repo` *or* `repo_master_path`, not both.

### Pipeline (host handler `src/modules/coding/create-coding-task.ts`)

1. Resolve `repo` against the registry → container path + defaults; or use the caller's explicit `repo_master_path`.
2. Translate the container path to a host path via the caller's `additionalMounts`.
3. Run `git worktree add <worktreeRoot|dirname(master)>/<ticket-lower>` on a new branch off `base_branch || registry default || origin/last-green`.
4. Create a sibling agent group `coding_<ticket-lower>` with `containerBackend: devcontainer`.
5. **Inherit `coding_global/CLAUDE.local.md` content** — the new group's `CLAUDE.local.md` is composed as `<per-task header>\n\n---\n\n<coding_global content>`. This is how every coding task inherits the operator's Implementation Workflow, PR Monitor Workflow, and Local Review playbook. If `coding_global` doesn't exist (or has no CLAUDE.local.md), the new group still gets the per-task header and falls back to the bare `module-coding-task` fragment for guidance.
6. Wire bidirectional parent ↔ child agent destinations.
7. Send `context` (and `plan_path`) as the kickoff message to the new agent's session.

> **Operator template**: edit `groups/coding_global/CLAUDE.local.md` to customize the per-task workflow inherited by all future coding agents. Existing coding tasks are NOT updated retroactively — re-create them or copy the new content over manually.

> **How the agent actually loads it**: in the devcontainer backend, the SDK's cwd is the user's repo worktree (e.g. `/workspace/<ticket>`), which has its own `CLAUDE.md` (the project's). Our 475-line workflow lives at `/nanoclaw-group/CLAUDE.md` (which imports `CLAUDE.local.md`). The agent-runner adds `/nanoclaw-group` to `additionalDirectories` so Claude Code loads BOTH files at session start. If you tweak the SDK invocation or skip that path, the workflow goes silent.

> **Pre-req:** every repo named in `repos` (or pointed at by `repo_master_path`) must be reachable through one of the parent agent's `additionalMounts`.

### Per-task Slack channel

If the parent agent is wired to a **Slack** channel, `create_coding_task` also creates a dedicated `coding-<ticket-lower>` channel: the bot creates it, joins it, and invites the agent group's admins (scoped + global) and the install owner. The new agent group is wired to that channel via `messaging_group_agents` (engage_mode=`pattern`, engage_pattern=`.`), so messages there route directly to the coding agent. Existing archived channels of the same name are unarchived and reused.

The wiring uses `session_mode: 'agent-shared'` (not `'shared'`) so the router's threaded-adapter override can't split a single coding task into per-thread sessions. **Every Slack message in the dedicated channel — regardless of which thread the user starts — hits the same long-lived container.** This is load-bearing for the single-container-per-task contract: one container = one git worktree = no concurrent edits stomping on each other.

**Communication contract**: the coding agent's primary surface is its own `#coding-<ticket>` Slack channel. Status updates, design summaries, blocking questions all post there directly via `mcp__nanoclaw__send_message(to="coding-<ticket-lower>", ...)`. The `parent` destination is reserved for creation / completion hand-offs (initial spawn ack, terminal task summary) — **not** ongoing dialog. The per-task header in `CLAUDE.local.md` reflects this: it points the agent at the dedicated channel and treats parent as a side-channel for housekeeping.

**Required Slack bot scopes** (in addition to /add-slack's defaults):

```
channels:manage   — create / archive / unarchive public channels
groups:write      — create / archive private channels (only if you ever set is_private=true)
channels:join     — bot joins the channel it just created
```

If scopes are missing or `SLACK_BOT_TOKEN` is unset, the host falls back to agent-to-agent only (parent talks to the coding agent via destinations) and surfaces the failure reason to the parent agent.

### Coding-task cleanup

The parent agent also gets `mcp__nanoclaw__delete_coding_task({ ticket_id })`. Use it after the PR is merged or to recover from a half-spawned task. The handler (`src/modules/coding/delete-coding-task.ts`) stops the devcontainer, archives the Slack channel, drops the OneCLI agent, removes the worktree + branch, and deletes the DB rows. Steps are best-effort — partial cleanup is preferable to a stall.

## Configure

### 1. Pick a coding agent group folder

By convention, coding agents live under a folder name that hints at scope: `coding_global` for a generalist, `coding_anchor`, `coding_qwibit`, etc. for repo-scoped agents. Pick one and seed it:

```bash
mkdir -p groups/<folder>
cp groups/coding_global/code-review-instructions.md groups/<folder>/
```

Compose a `groups/<folder>/CLAUDE.md` (or `CLAUDE.local.md` if you want it untracked). The starter `groups/coding_global/code-review-instructions.md` is loaded by the agent on PR-review prompts.

### 2. Write `groups/<folder>/container.json`

The two coding-specific fields are `containerBackend` and `devcontainer.workspaceFolder`. Example:

```json
{
  "containerBackend": "devcontainer",
  "devcontainer": {
    "workspaceFolder": "/Users/me/code/myrepo"
  },
  "skills": "all",
  "mcpServers": {}
}
```

`workspaceFolder` is an absolute host path to a git worktree (or the repo root). The skill's worktree-mutex blocks two sessions from running in the same `workspaceFolder` at once.

### 3. Wire the messaging group

Use `/manage-channels` (or the host CLI) to wire the coding agent group to a Slack channel / Linear team / DM. The session that the channel creates is the long-lived devcontainer.

### 4. Set Linear / GitHub tokens (optional)

If your `groups/<folder>/CLAUDE.md` references Linear ticket IDs, drop the token in OneCLI:

```bash
onecli secrets create LINEAR_API_TOKEN
onecli agents set-secret-mode --id <coding-agent-id> --mode all
```

`gh` runs from the host's authenticated session, forwarded into the devcontainer via `GH_TOKEN`.

## Verify

### Smoke test

From the wired channel, message: `work on a tiny no-op PR — add a blank comment to README.md and open a PR`. You should see:

1. A status message: "Setting up development environment..." (devcontainer up).
2. The agent thinks, edits, runs `git push`, runs `gh pr create`.
3. A cost summary message lands a few minutes later (tokens used, dollar estimate).

### Inspect the worktree lock

```bash
sqlite3 data/v2.db "SELECT * FROM coding_worktree_locks"
```

Should show one row per active task. Empty when no task is running.

### Inspect the running devcontainer

```bash
docker ps --filter label=nanoclaw.install
```

You should see one `devcontainer-...` container per active coding task. Compare against the lock table — they should match. If they drift, the next host restart's orphan scanner will reconcile.

## Removal

```bash
# 1. Drop the migration entry (lock table can stay; harmless)
# 2. Revert the merge
git revert -m 1 <merge-sha>

# 3. Remove the skill folder
rm -rf .claude/skills/add-coding-agent
```

You can keep `groups/<folder>/` — it's just files.

## Troubleshooting

- **`devcontainer up` hangs at "Not setting dockerd DNS manually" with no post-create output**: devcontainer CLI's id-label matcher hangs when an id-label value contains an embedded `=` (e.g. `nanoclaw.install=nanoclaw-install=5076a28e`). The devcontainer backend strips the prefix and passes the bare slug. If you patched the backend or call the CLI directly, ensure every `--id-label key=value` has a value free of `=` characters.
- **`devcontainer up timed out after 15 minutes`**: first-time builds for some `.devcontainer/devcontainer.json` images take 10+ minutes (apt + gcloud SDK). Re-run the trigger; the second attempt picks up the cached layers.
- **Agent gets `401 Unauthorized` from Anthropic**: the OneCLI agent is in `selective` secret mode by default. Run `onecli agents set-secret-mode --id <id> --mode all`. See the root `CLAUDE.md` "Gotcha: auto-created agents start in `selective` secret mode".
- **Two messages for the same coding task race-create two devcontainers**: the worktree mutex blocks the second one — it returns null from `acquireWorktreeLock`, and the agent will reply "another coding task is already using this worktree".
- **Container exits but the lock survives**: orphan scanner reconciles on next startup. To force now, restart NanoClaw.

## Background

For the architecture (devcontainer backend vs. docker backend, worktree mutex semantics, PR-monitor scheduling, cost-summary delivery action), see the registry proposal at `docs/proposals/2026-04-27-container-backend-registry.md` and the v2 architecture overview in `docs/architecture.md`.
