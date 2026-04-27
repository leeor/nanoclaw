## Coding tasks (`create_coding_task`)

`mcp__nanoclaw__create_coding_task({ ticket_id, repo_master_path, context?, plan_path? })` spawns a per-task coding agent in a fresh git worktree. Use when the user asks you to work on a ticket, fix a bug, or implement a feature in a repository.

### How it works

- Creates a git worktree at `<repo_dir>/<ticket-id-lower>` on a new branch named `<ticket-id-lower>` off `repo_master_path`'s current HEAD.
- Spawns a sibling agent group `coding_<ticket-id-lower>` backed by a **devcontainer** (uses the repo's `.devcontainer/devcontainer.json`).
- Wires bidirectional destinations: you address the new agent by its ticket ID (e.g. `<message to="ANCR-919">`), it replies via `<message to="parent">`.
- Sends `context` (and the contents at `plan_path`, if provided) as the kickoff message to the new agent's session, then wakes its container.

### Arguments

- `ticket_id` — the ticket/issue ID, alphanumeric with `-`/`_` (e.g. `"ANCR-919"`). Becomes the branch name and folder suffix (lowercased).
- `repo_master_path` — path to the repo's master worktree, **as you see it from your container** (e.g. `/workspace/extra/repos/mono/master`). The host translates this to the underlying host path via your container.json's `additionalMounts`.
- `context` *(optional)* — ticket title, requirements, background, constraints. This is **context**, not a plan. If you find yourself writing implementation-level detail (specific file paths, method signatures, ordered steps) without a `plan_path`, stop — that's a plan.
- `plan_path` *(optional)* — absolute path (in your container) to a **committed** plan file. If set, the coding agent skips the design step and goes straight to implementation. Only provide this when an actual plan file has been committed.

### Context vs plan — do not confuse them

`context` is for ticket description, background, requirements, constraints, and pointers. Putting implementation detail in `context` without `plan_path` causes the coding agent to skip the design/review/approval gate and jump to implementation. This is a known failure mode and not cleanly recoverable.

Either:
1. Commit a plan file and pass `plan_path`, OR
2. Drop the implementation detail from `context` and let the coding agent design it.

### When to use

- The user asks you to work on a ticket / fix a bug / implement a feature in a specific repo.
- The work needs an isolated branch, a devcontainer with full dev tooling (gh, node, go, etc.), and PR-grade verification.

### When NOT to use

- Quick code lookups or one-shot questions — use `bash`, `grep`, or read the file yourself.
- Work that doesn't need a worktree or PR — use `create_agent` for a generic specialist sub-agent instead.

### Failure modes you'll see

- *"could not translate `<path>` to a host path"* — your container.json's `additionalMounts` don't cover the repo. Ask the user to add the mount, or pass a path that lives under one of your existing mounts.
- *"a coding agent for `<ticket>` already exists"* — the previous task wasn't cleaned up. The user can delete the old agent group manually before retrying.
- *"git worktree add failed"* — usually means the branch already exists locally, or the master path isn't a git worktree. Surface the stderr to the user.
