---
name: slack-mcp-tools
description: Add container-side Slack MCP read tools (read channels, threads, search, user profile, canvases, send files). Distinct from /add-slack — this skill gives the agent inside the container the ability to read Slack, not just receive messages from it. Requires /add-slack already installed for the channel adapter and a bot token in the container env.
---

# Slack MCP Tools

Adds container-side MCP tools for Slack: read channel/thread, search messages, read user profile, read/update canvases, send files. Wires the upstream `slack-mcp-server` package into the agent-runner so any agent group whose container env has `SLACK_BOT_TOKEN` gets `mcp__slack__*` tools at runtime.

This is **distinct** from `/add-slack`:

- `/add-slack` ships the **channel adapter** (host-side, Chat SDK bridge) — receives messages from Slack and delivers replies back.
- `slack-mcp-tools` ships the **agent's tool kit** (container-side, MCP server) — lets the agent proactively read channels, search history, fetch user profiles, etc., even outside the current conversation.

## Prerequisites

1. `/add-slack` already applied (channel adapter wired, `SLACK_BOT_TOKEN` in `.env`).
2. The Slack app's bot token has the read scopes listed below.

## Required Bot Token scopes

`/add-slack` requests the scopes needed for inbound messages and replies. For this skill, the bot token additionally needs:

| Scope | Used for |
|---|---|
| `channels:history` | (already from `/add-slack`) read public channel messages |
| `groups:history` | (already from `/add-slack`) read private channel messages |
| `im:history` | (already from `/add-slack`) read DM history |
| `users:read` | (already from `/add-slack`) resolve user IDs to profiles |
| `search:read` | required for `slack_search_*` tools |
| `files:write` | required for `slack_send_file` |
| `canvases:read`, `canvases:write` | required for canvas tools |

After adding scopes in **OAuth & Permissions**, click **Reinstall to Workspace** and copy the new bot token into `.env` (overwriting the old one).

## Phase 1: Pre-flight (idempotent)

Skip to Phase 3 if all of these are already in place:

- `container/agent-runner/src/index.ts` contains `SLACK_BOT_TOKEN` and `mcp__slack__*`.
- `.env` has `SLACK_BOT_TOKEN=xoxb-…` (already done by `/add-slack`).

Otherwise continue. Every step below is safe to re-run.

## Phase 2: Apply the skill branch

The agent-runner patch lives on the `skill/slack-mcp-tools` branch.

### 1. Fetch the branch

```bash
git fetch origin skill/slack-mcp-tools
```

### 2. Cherry-pick the commit onto your current branch

```bash
git cherry-pick origin/skill/slack-mcp-tools
```

The single commit touches three files:

- `container/agent-runner/src/index.ts` — adds the conditional `slack` MCP server entry, adds `mcp__slack__*` to the allowed tools, and scrubs `SLACK_BOT_TOKEN` from `process.env` after wiring.
- `container/agent-runner/src/providers/types.ts` — adds an `extraAllowedTools` field to `ProviderOptions`.
- `container/agent-runner/src/providers/claude.ts` — concatenates `extraAllowedTools` onto the static `TOOL_ALLOWLIST`.

If the cherry-pick reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides — the changes are small and localized.

## Phase 3: Make sure the token reaches the container

`SLACK_BOT_TOKEN` must be in the **agent container's** env at startup. There are two paths:

### Option A — `.env` passthrough (default after `/add-slack`)

`/add-slack` already places `SLACK_BOT_TOKEN` in `.env` for the host adapter, and the v2 container-runner forwards `.env` into the agent container. No extra step needed.

Verify:

```bash
grep '^SLACK_BOT_TOKEN=' .env
```

Should print the line.

### Option B — OneCLI vault (preferred long-term)

If you've moved Slack credentials into the OneCLI vault via `/init-onecli`, the container will receive the token via the credential proxy at request time. No `.env` entry needed. Confirm with:

```bash
onecli secrets list | grep -i slack
```

## Phase 4: Build and restart

```bash
pnpm run build
./container/build.sh
```

Then restart NanoClaw so the new image and source are picked up:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

Existing groups have a cached copy of the agent-runner source under `groups/<folder>/agent-runner-src/`. Refresh them (or let the next group-init refresh them) so the new `index.ts` and provider files take effect.

## Verify

### Container env

After the next agent wake, find the running container and confirm the MCP server received the token:

```bash
docker ps --filter 'name=nanoclaw-agent-' --format '{{.Names}}'
docker exec <container-name> sh -c 'env | grep SLACK_MCP_XOXB_TOKEN'
```

You should see the line. The runner deletes `SLACK_BOT_TOKEN` from `process.env` after wiring the MCP server, so the agent cannot read the raw token via Bash; the MCP server keeps its own copy via the env passed at spawn.

### Agent-runner log

```bash
docker logs <container-name> 2>&1 | grep 'Slack MCP server enabled'
```

Should print `[agent-runner] Slack MCP server enabled (SLACK_BOT_TOKEN present)`.

### End-to-end smoke

From a Slack DM (or a wired Slack channel), send the agent:

> Read the latest 5 messages from #general.

The agent should call `mcp__slack__slack_read_channel` (or similar — see the `slack-mcp-server` README for the exact tool names in the version that gets pulled by `npx`).

## Tools provided

Subject to the `slack-mcp-server` release that `npx` resolves at runtime. As of writing:

- `slack_read_channel`, `slack_read_thread`
- `slack_search_public`, `slack_search_users`
- `slack_read_user_profile`
- `slack_read_canvas`, `slack_create_canvas`, `slack_update_canvas`
- `slack_send_file`

See [`korotovsky/slack-mcp-server`](https://github.com/korotovsky/slack-mcp-server) for the latest list.

## Removal

```bash
git revert <skill-commit-sha>
pnpm run build
./container/build.sh
```

Restart NanoClaw. The Slack channel adapter (`/add-slack`) is unaffected — only the in-container read tools are removed.

## Notes

- **No new repo dependency.** `slack-mcp-server` is fetched at runtime via `npx -y slack-mcp-server@latest`, so there's nothing to add to `package.json` or to the supply-chain allowlist. The first agent wake after install will spend a few seconds pulling the package; subsequent wakes use the npm cache.
- **Token-gated.** Both the MCP server entry and the `mcp__slack__*` allow-prefix only appear when `SLACK_BOT_TOKEN` is set in the container env. Groups without the token are unaffected.
- **Defense-in-depth scrub.** `SLACK_BOT_TOKEN` is removed from `process.env` immediately after the MCP server is wired, so the agent's Bash tool cannot read the raw token. The MCP server retains its own copy through the env explicitly passed when the runner spawned it.
