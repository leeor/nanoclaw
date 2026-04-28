# Linear hosted MCP via OneCLI — design

**Date:** 2026-04-28
**Status:** Approved (verbal)

## Problem

NanoClaw's container ships a custom Linear GraphQL wrapper at
`container/agent-runner/src/mcp-tools/linear.ts` exposing five tools:
`linear_create_issue`, `linear_update_issue`, `linear_get_issue`,
`linear_list_issues`, `linear_comment_on_issue`. Linear's official MCP server
exposes ~50 (teams, users, projects, milestones, cycles, labels, statuses,
attachments, comments, documents, initiatives, customers, status updates,
search-docs, extract-images, …). Agents cannot reach the absent tools.

## Solution

Replace the custom wrapper with Linear's hosted MCP server at
`https://mcp.linear.app/mcp` (Streamable HTTP transport). Authenticate via
`Authorization: Bearer <token>`, with token injection handled by the OneCLI
gateway proxy that already intercepts container-side outbound HTTPS.

Linear's MCP supports two auth modes:
1. Interactive OAuth 2.1 with dynamic client registration.
2. Bearer token (API key or OAuth access token).

We use #2. OneCLI vault holds the token; the agent-side MCP client sends an
`onecli-managed` stub bearer; the proxy rewrites it with the real token in
flight. This matches the existing pattern used by `/add-gmail-tool` and
`/add-gcal-tool`.

## Components

### 1. Type extensions (trunk)

Both host (`src/container-config.ts`) and container
(`container/agent-runner/src/providers/types.ts`) define `McpServerConfig` as
stdio-only. Replace each with a discriminated union:

```typescript
export type McpServerConfig =
  | McpStdioConfig
  | McpHttpConfig
  | McpSseConfig;

export interface McpStdioConfig {
  type?: 'stdio'; // default when omitted
  command: string;
  args?: string[];
  env?: Record<string, string>;
  instructions?: string;
}

export interface McpHttpConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  instructions?: string;
}

export interface McpSseConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
  instructions?: string;
}
```

`instructions` is shared because `claude-md-compose.ts` reads it across all
shapes. The discriminator defaults to `'stdio'` when absent so existing
container.json files keep working unchanged.

`claude-agent-sdk` accepts the same shape — verified against
`https://code.claude.com/docs/en/agent-sdk/mcp`. Pass through unchanged.

### 2. Drop the custom wrapper

Delete:
- `container/agent-runner/src/mcp-tools/linear.ts`
- `container/agent-runner/src/mcp-tools/linear.test.ts`

Edit `container/agent-runner/src/mcp-tools/index.ts` — remove the
`import './linear.js';` line.

Tool name change: `linear_*` → `mcp__linear__*`. Any group `CLAUDE.md`
referencing the old names continues to work because the live tool surface is
read at session start; the docs simply list outdated names. Skill docs that
reference the wrapper will be updated.

### 3. Tool allowlist

Add `'mcp__linear__*'` to `TOOL_ALLOWLIST` in
`container/agent-runner/src/providers/claude.ts`, alongside the existing
`mcp__nanoclaw__*` / `mcp__gmail__*` / etc. entries.

### 4. Host passthrough

Verified: `src/container-config.ts` reads the raw `mcpServers` map and stores
it on `ContainerConfig` with the type above. `container-runner.ts` does not
narrow further — it spreads the map into the JSON config that becomes the
agent-runner's input. Adding a new variant to the type touches no host
runtime code beyond the type itself.

`src/modules/self-mod/apply.ts` (the `add_mcp_server` self-mod handler)
constructs only stdio entries today. Leave it stdio-only; HTTP MCP entries
are added by humans editing `container.json` (or by the new skill).

### 5. New skill: `/add-linear-tool`

`.claude/skills/add-linear-tool/SKILL.md`. Modeled on `add-gmail-tool` and
`add-gcal-tool`. Phases:

- **Pre-flight:** verify OneCLI is installed; `onecli apps get --provider linear`
  shows `connected`; the agent's secret-mode admits the Linear secret.
- **Apply (idempotent code patches):** in case the skill runs on an install
  that is behind on trunk, re-apply the McpServerConfig union and the
  `mcp__linear__*` allowlist entry. No-op when trunk already has them.
- **Wire per-group:** edit the target groups' `container.json` to add:
  ```jsonc
  {
    "env": { "LINEAR_API_KEY": "onecli-managed" },
    "mcpServers": {
      "linear": {
        "type": "http",
        "url": "https://mcp.linear.app/mcp",
        "headers": { "Authorization": "Bearer ${LINEAR_API_KEY}" }
      }
    }
  }
  ```
- **Build + restart:** `pnpm run build && ./container/build.sh && systemctl --user restart nanoclaw`.
- **Verify:** ask the user to test `mcp__linear__list_teams` from the wired
  agent, with logging hints for `401`, MCP init failures, etc.
- **Removal:** unwire `container.json` entries; optional skill removal of
  the McpServerConfig union (only meaningful if no other HTTP MCP is in use).

The skill is named `add-linear-tool` to match `add-gmail-tool` /
`add-gcal-tool`. It is *distinct* from the existing `/add-linear` channel
skill (which copies the Linear webhook adapter from the `channels` branch).
Both skills can coexist on one install.

### 6. Apply locally

After trunk lands and the skill is committed, run the skill against the
local install. Wire `slack_main` and the global agent group's `container.json`
(per the existing memory feedback that tools should be added to both).

## Data flow

```
Agent SDK
  → opens HTTPS streamable to mcp.linear.app/mcp
  → Authorization: Bearer onecli-managed   ← from container.json headers
Container HTTPS proxy (OneCLI: HTTPS_PROXY + CA cert installed in image)
  → matches host pattern *.linear.app
  → swaps Authorization with real OAuth token from vault
mcp.linear.app
  → returns ~50 tools as mcp__linear__<name>
```

If `LINEAR_API_KEY` is set to a real Linear API key (not the stub), the
proxy passes it through unchanged. This permits a non-OneCLI fallback for
users who prefer raw API keys, although CLAUDE.md strongly prefers OneCLI.

## Tradeoffs and rejected alternatives

| Option | Why rejected |
|---|---|
| Keep custom wrapper, add more tools | Maintenance burden; no automatic API tracking; still won't match Linear's surface. |
| Install Linear MCP locally as stdio (npm package) | No first-party package as of writing; would require third-party wrapper. Hosted is canonical. |
| Add stdio bridge (e.g. `mcp-remote`) wrapping HTTP MCP | Extra moving part. Native HTTP support exists in claude-agent-sdk. |
| Trunk-wide replace AND opt-in skill | One source of truth is cleaner. The skill exists primarily to wire per-group config and document the OneCLI prerequisite. |
| Deprecation period (keep wrapper alongside HTTP MCP) | Tool names differ (`linear_*` vs `mcp__linear__*`) — wouldn't shadow each other anyway, but two parallel surfaces is confusing. Clean cut. |

## Risks

- **OneCLI Linear connection required.** A user without OneCLI cannot use
  this without manually setting `LINEAR_API_KEY` to a real token in
  `container.json` env. The skill explicitly checks for OneCLI in pre-flight.
- **Tool-surface drift.** `mcp__linear__*` toolset is whatever Linear's
  hosted MCP currently exposes. Linear can change it. This is also the
  upside: API additions show up automatically.
- **Connection timeout.** The MCP SDK's default 60s connect timeout could
  bite during cold starts. Documented in the skill's troubleshooting notes.
- **No tests for the wrapper anymore.** The custom wrapper's `linear.test.ts`
  is deleted. There is no easy local test for HTTP MCP because it requires
  network + a real token — covered by manual verify step in the skill.

## Out of scope

- Inbound Linear (the `/add-linear` channel skill stays as-is).
- Approval-gating Linear write actions (handled at the OneCLI rule layer if
  needed; not part of this design).
- Backfilling McpServerConfig union into self-mod's `add_mcp_server` handler
  for HTTP servers (future work; skill installs HTTP MCP, self-mod doesn't
  need to today).
