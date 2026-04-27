# Prompt: `skill/slack-mcp-tools`

You are an autonomous agent working in `~/repos/nanoclaw-v2`. Your task: build the `slack-mcp-tools` skill that adds container-side Slack MCP read tools (channel/thread reads, search, user profile, canvas, file send) to agent groups wired to a Slack channel.

## Goal

Skill ships as the `skill/slack-mcp-tools` branch. When applied:

1. Wires `slack-mcp-server@latest` (npm package) as an MCP server in agent-runner config when `SLACK_BOT_TOKEN` is set.
2. Adds `mcp__slack__*` to allowed tool prefixes (gated on token presence).
3. Per-group enable: token must reach the container's env (via OneCLI vault).
4. Documents the required Slack OAuth bot scopes for the read tools.

This is a **container-side** skill — it doesn't add or replace the Slack channel adapter (that's `/add-slack` from upstream). It augments containers with read access for agent groups already wired to Slack.

Distinct from `/add-slack`:
- `/add-slack` ships the Slack channel adapter (host-side, Chat SDK bridge).
- `slack-mcp-tools` ships the agent's Slack tool kit (container-side, MCP server).

## Branch

```bash
git checkout main
git pull origin main
git checkout -b skill/slack-mcp-tools
```

## v1 reference

The v1 fork wires `slack-mcp-server` from npm. Reference commits:

- `776d6e7c` — main wiring commit (agent-runner mcpServers entry + tool prefix). View: `git -C ~/repos/nanoclaw show 776d6e7c -- container/agent-runner/src/index.ts`.
- `fd890e2` — Slack file upload tool (send_file) — confirm whether it's in `slack-mcp-server@latest` or needs separate.
- `5e7d1483`, `8caa60d8`, `c533cb4d` — supporting commits for Slack image vision and threading-related improvements (informational only).

Key v1 pattern from `776d6e7c`:

```typescript
...(process.env.SLACK_BOT_TOKEN ? ['mcp__slack__*'] : []),

...(process.env.SLACK_BOT_TOKEN ? {
  slack: {
    command: 'npx',
    args: ['-y', 'slack-mcp-server@latest'],
    env: {
      SLACK_MCP_XOXB_TOKEN: process.env.SLACK_BOT_TOKEN,
    },
  },
} : {}),
```

## Implementation

### File: `container/agent-runner/src/index.ts` (patch)

In the `mcpServers` build block, add a Slack entry conditional on `SLACK_BOT_TOKEN`:

```typescript
if (process.env.SLACK_BOT_TOKEN) {
  mcpServers.slack = {
    command: 'npx',
    args: ['-y', 'slack-mcp-server@latest'],
    env: {
      SLACK_MCP_XOXB_TOKEN: process.env.SLACK_BOT_TOKEN,
    },
  };
}
```

In the allowed tool prefixes:

```typescript
...(process.env.SLACK_BOT_TOKEN ? ['mcp__slack__*'] : []),
```

Scrub the token from `process.env` after MCP server start (defense-in-depth):

```typescript
delete process.env.SLACK_BOT_TOKEN;
```

### File: `.claude/skills/slack-mcp-tools/SKILL.md` (new)

```markdown
---
name: slack-mcp-tools
description: Add container-side Slack MCP read tools (read channels, threads, search, user profile, canvases, send files). Requires /add-slack already installed for the channel adapter.
---

# Slack MCP Tools

Adds container-side MCP tools for Slack: read channel/thread, search messages, read user profile, read/update canvases, send files. Distinct from the Slack channel adapter (`/add-slack`) which handles inbound/outbound messages on the host side.

## Prerequisites

1. `/add-slack` already applied (channel adapter wired).
2. The Slack app's bot token has read scopes — see "Required scopes" below.

## Required Bot Token scopes

The default `/add-slack` install requests write-side scopes only. For this skill, add these read-side scopes to the Slack app and reinstall:

- `channels:history` (already in `/add-slack`)
- `groups:history` (already in `/add-slack`)
- `im:history` (already in `/add-slack`)
- `users:read` (already in `/add-slack`)
- `search:read` — required for `slack_search_*` tools
- `files:write` — required for file uploads
- `canvases:read`, `canvases:write` — required for canvas tools

After updating scopes, click **Reinstall** in the Slack app's OAuth & Permissions page.

## Install

### 1. Apply the patches

```bash
git fetch origin skill/slack-mcp-tools
git cherry-pick origin/skill/slack-mcp-tools~..origin/skill/slack-mcp-tools
```

### 2. Token reaches the container

The bot token (env var `SLACK_BOT_TOKEN`) must be in the container's environment. Two options:

- **OneCLI vault** (preferred): register the bot token in OneCLI; container's HTTPS_PROXY routes Slack API calls through the vault, which injects auth.
- **Direct env passthrough**: set `SLACK_BOT_TOKEN` in `.env` (already done by `/add-slack` for the host adapter; v2's container-runner forwards it).

If `/add-slack` already places the token in env, skill reads it. Verify via container-runner setup.

### 3. Rebuild

```bash
pnpm run build
./container/build.sh
```

### 4. Restart NanoClaw service

The next agent wake will have `mcp__slack__*` tools available.

## Verify

Send a message to a Slack-wired agent group: `read the latest 5 messages from #general`. The agent should call `mcp__slack__slack_read_channel` (or similar — see `slack-mcp-server` docs for exact tool names).

Check container env:

```bash
docker exec <container> sh -c 'echo $SLACK_MCP_XOXB_TOKEN | head -c 20'
```

Should show the token's first chars — confirming the runner forwarded it.

After MCP server start, the runner scrubs `SLACK_BOT_TOKEN` from `process.env` so the agent can't read it via Bash. The MCP server keeps its own copy via `SLACK_MCP_XOXB_TOKEN`.

## Tools provided (subject to slack-mcp-server release)

- `slack_read_channel`, `slack_read_thread`
- `slack_search_public`, `slack_search_users`
- `slack_read_user_profile`
- `slack_read_canvas`, `slack_create_canvas`, `slack_update_canvas`
- `slack_send_file`

See `https://github.com/korotovsky/slack-mcp-server` for the latest list.

## Removal

```bash
git revert <skill-commit>
./container/build.sh
```

(Or revert the cherry-picked commit and rebuild.)
```

### File: `.claude/skills/slack-mcp-tools/VERIFY.md` (new, optional)

```bash
grep 'mcp__slack__\*' container/agent-runner/src/index.ts
grep 'SLACK_MCP_XOXB_TOKEN' container/agent-runner/src/index.ts
grep 'delete process.env.SLACK_BOT_TOKEN' container/agent-runner/src/index.ts
```

## Tests

No new unit tests required — the skill is gated config in agent-runner. Verification is integration: `pnpm run build` + container build + smoke message.

If a vitest harness for agent-runner exists in v2, add a test that asserts `mcpServers.slack` is populated when `SLACK_BOT_TOKEN` is set, absent when it isn't. Otherwise note skipped in OUT doc.

## Verify

```bash
pnpm run build
./container/build.sh
```

End-to-end smoke (with a real Slack token + a wired group):

1. Add `slack:test_channel_id` user as known-sender.
2. Wire to a test agent group.
3. Send `read the latest message in #<some-channel>` from a Slack DM.
4. Confirm agent calls a `slack_*` MCP tool.

## Output

Write `docs/proposals/agent-prompts/skill-slack-mcp-tools-OUT.md`.

Push:

```bash
git push -u origin skill/slack-mcp-tools
```

## Constraints

- **Depends on `/add-slack`** for the channel adapter — document explicitly in SKILL.md.
- **Token gated**: tool prefix and MCP entry only when `SLACK_BOT_TOKEN` is present.
- **Token scrubbed** from `process.env` after MCP server boot.
- **No new npm dep** in repo — `slack-mcp-server` is fetched at runtime via `npx -y`.
- **Don't touch v1** (`~/repos/nanoclaw` read-only).

## Outcome path (per migration plan)

Preferred: PR upstream as a core Slack feature on top of `/add-slack`. Likely accepted (extends existing skill).

Fallback: keep as fork-skill.

For this prompt: build as fork-skill on `skill/slack-mcp-tools`. The operator decides upstream-PR vs. keep-fork after reviewing.

## Reference

- v1 commit `776d6e7c` (in `~/repos/nanoclaw`).
- `slack-mcp-server` upstream: `https://github.com/korotovsky/slack-mcp-server` (verify URL).
- v2 mcpServers pattern: `container/agent-runner/src/index.ts`.

## Done criteria

- [ ] Branch `skill/slack-mcp-tools` exists.
- [ ] `container/agent-runner/src/index.ts` patched: mcpServers entry + tool prefix + env scrub.
- [ ] `.claude/skills/slack-mcp-tools/SKILL.md` written with scopes section + dependency note.
- [ ] `pnpm run build` clean.
- [ ] `./container/build.sh` succeeds.
- [ ] OUT doc written.
- [ ] Branch pushed.
