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
- `src/modules/coding/delete-coding-task.ts`
- `src/modules/coding/slack-channel-create.ts`
- `src/db/migrations/module-coding-worktree-locks.ts`
- `src/db/migrations/module-coding-pr-monitors.ts`
- `src/db/migrations/module-coding-pr-monitors-ci.ts`
- `src/db/migrations/module-coding-pr-monitors-terminal-wake.ts`
- `groups/coding_global/code-review-instructions.md`
- `groups/coding_global/CLAUDE.md`

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

System-level: the skill relies on the `devcontainer` CLI being available
system-wide.

Workspace-level: the skill adds `@slack/web-api` to `package.json` —
`src/modules/coding/slack-channel-create.ts` and `delete-coding-task.ts`
import the `WebClient` directly to create / archive the per-task Slack
channel. The dep is gated at runtime on `SLACK_BOT_TOKEN`; with no
Slack channel installed the dep sits unused but the import still
resolves at build time, so it must be present in the lockfile.

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

Once installed, **any agent that has the `create_coding_task` MCP tool** can spawn a per-task coding agent on demand:

```
mcp__nanoclaw__create_coding_task({
  ticket_id: "ANCR-919",
  repo_master_path: "/workspace/extra/repos/mono/master",
  context: "Fix N+1 query in proposals CSV export.",
  plan_path: "/workspace/extra/repos/mono/master/docs/plans/2026-04-27-fix-n1.md"  // optional
})
```

The host handler (`src/modules/coding/create-coding-task.ts`):

1. Translates `repo_master_path` (caller's container path) to a host path via the caller's `additionalMounts`.
2. Runs `git worktree add <repo-dir>/<ticket-lower>` on a new branch.
3. Creates a sibling agent group `coding_<ticket-lower>` with `containerBackend: devcontainer`.
4. Wires bidirectional parent ↔ child agent destinations (the parent addresses the new agent by ticket ID; the new agent replies with `<message to="parent">`).
5. Sends `context` (and `plan_path`) as the kickoff message to the new agent's session.

This is the typical flow for one-off coding tasks — the per-task group is not wired to a Slack channel, communication flows through the parent. For long-lived generalist coding agents wired to their own channel, follow **Configure** below.

> **Pre-req:** the parent agent's `container.json` must contain an `additionalMounts` entry that covers the repo. e.g. `{ hostPath: "/Users/me/code", containerPath: "code" }` so paths like `/workspace/extra/code/...` resolve.

### Per-task Slack channel

If the parent agent is wired to a **Slack** channel, `create_coding_task` also creates a dedicated `coding-<ticket-lower>` channel: the bot creates it, joins it, and invites the agent group's admins (scoped + global) and the install owner. The new agent group is wired to that channel via `messaging_group_agents` (engage_mode=`pattern`, engage_pattern=`.`), so messages there route directly to the coding agent. Existing archived channels of the same name are unarchived and reused.

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

- **`devcontainer up timed out after 15 minutes`**: first-time builds for some `.devcontainer/devcontainer.json` images take 10+ minutes (apt + gcloud SDK). Re-run the trigger; the second attempt picks up the cached layers.
- **Agent gets `401 Unauthorized` from Anthropic**: the OneCLI agent is in `selective` secret mode by default. Run `onecli agents set-secret-mode --id <id> --mode all`. See the root `CLAUDE.md` "Gotcha: auto-created agents start in `selective` secret mode".
- **Two messages for the same coding task race-create two devcontainers**: the worktree mutex blocks the second one — it returns null from `acquireWorktreeLock`, and the agent will reply "another coding task is already using this worktree".
- **Container exits but the lock survives**: orphan scanner reconciles on next startup. To force now, restart NanoClaw.

## Background

For the architecture (devcontainer backend vs. docker backend, worktree mutex semantics, PR-monitor scheduling, cost-summary delivery action), see the registry proposal at `docs/proposals/2026-04-27-container-backend-registry.md` and the v2 architecture overview in `docs/architecture.md`.
