---
name: add-linear-tool
description: Add Linear's hosted MCP server (~50 tools) to selected agent groups. Auth via OneCLI bearer-token injection — agent containers never see raw Linear credentials.
---

# Add Linear Tool (OneCLI-native)

This skill wires Linear's hosted MCP server at `https://mcp.linear.app/mcp` into selected
agent groups. The agent calls Linear via standard HTTP MCP; the OneCLI gateway proxy
injects the real OAuth token in flight by intercepting outbound HTTPS to `mcp.linear.app`.

Tools exposed (Linear's full set, surfaced to the agent as `mcp__linear__<name>`):
- Issue CRUD: `list_issues`, `get_issue`, `save_issue`, `list_issue_labels`,
  `create_issue_label`, `list_issue_statuses`, `get_issue_status`
- Comments: `list_comments`, `save_comment`, `delete_comment`
- Projects, milestones, cycles: `list_projects`, `get_project`, `save_project`,
  `list_milestones`, `get_milestone`, `save_milestone`, `list_cycles`
- Initiatives, documents, customers, status updates, attachments — see Linear's
  MCP docs for the live list.
- `search_documentation`, `extract_images`.

Linear may add or remove tools; the surface tracks Linear's hosted server.

**Why this pattern:** v2's invariant is that containers never receive raw API keys —
OneCLI is the sole credential path. The container.json header
`Authorization: Bearer ${LINEAR_API_KEY}` where `LINEAR_API_KEY=onecli-managed`
produces a stub bearer; the gateway swaps it with the real token in flight.

This skill is distinct from `/add-linear`, which installs the inbound channel adapter
(Linear webhook → agent). The two can coexist on one install.

## Phase 1: Pre-flight

### Verify the trunk supports HTTP MCP servers

```bash
grep -q "type: 'http'" container/agent-runner/src/providers/types.ts && \
  grep -q "'mcp__linear__\\*'" container/agent-runner/src/providers/claude.ts && \
  echo "TRUNK READY" || echo "TRUNK BEHIND — run /update-nanoclaw first"
```

If the output is `TRUNK BEHIND`, stop and tell the user to run `/update-nanoclaw` so
the McpServerConfig discriminated union and `mcp__linear__*` allowlist (which this
skill depends on) are in place.

### Verify OneCLI is installed and Linear is connected

```bash
onecli apps get --provider linear
```

Expected: `"connection": { "status": "connected" }` with appropriate Linear scopes.

If not connected, tell the user:

> Open the OneCLI web UI at http://127.0.0.1:10254, go to Apps → Linear, and click
> Connect. Sign in with the Linear workspace you want the agent to act in.

If `onecli apps get --provider linear` reports the provider is unknown, the user's
OneCLI version doesn't yet ship a Linear app integration. They can still proceed by
storing a real Linear API key directly: skip to **Alternative: raw API key** below.

### Check agent secret-mode

For each target agent group, confirm OneCLI will inject the Linear secret. Find the
OneCLI agent ID matching the group's `agentGroupId`:

```bash
onecli agents list
```

If the agent's `secretMode` is `all`, you're done. If `selective`, assign the Linear
secret explicitly:

```bash
onecli secrets list                            # find the Linear secret id
onecli agents set-secrets --id <agent-id> --secret-ids <linear-secret-id>
```

### Alternative: raw API key (no OneCLI Linear app)

If the user prefers to use a Personal Linear API key without OneCLI:

- Get a key from Linear → Settings → API → Personal API Keys.
- In the per-group container.json below, replace `"LINEAR_API_KEY": "onecli-managed"`
  with `"LINEAR_API_KEY": "lin_api_..."`.
- This bypasses OneCLI entirely for the Linear path — the bearer is sent as-is.
- CLAUDE.md prefers OneCLI; only do this when an OneCLI Linear connector isn't
  available.

## Phase 2: Per-Group Wiring

For each agent group that should have Linear (ask the user — typically their personal
agents and any group that owns a Linear team), edit `groups/<folder>/container.json`
to add an `env` entry and an `mcpServers.linear` entry. The change is idempotent —
running the skill twice yields the same result.

```jsonc
{
  // ... existing fields ...
  "env": {
    "LINEAR_API_KEY": "onecli-managed"
    // existing env entries preserved
  },
  "mcpServers": {
    // ... existing mcp servers preserved ...
    "linear": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp",
      "headers": {
        "Authorization": "Bearer ${LINEAR_API_KEY}"
      }
    }
  }
}
```

If the file's `env` block doesn't exist, create one. If `mcpServers` doesn't exist,
create one. Other fields (packages, additionalMounts, skills, agentGroupId, …) are
untouched.

After editing, optionally update the group's `CLAUDE.md` (or a fragment imported by
it) to mention the new tool surface. Example bullet:

> - Manage Linear issues, projects, cycles, comments, attachments, and more via
>   `mcp__linear__*` tools (Linear's hosted MCP server).

If the group's `CLAUDE.md` references `linear_create_issue`, `linear_list_issues`,
`linear_get_issue`, `linear_update_issue`, or `linear_comment_on_issue`, replace the
old names with the `mcp__linear__*` equivalents (or just remove the specific names
and rely on the agent's discoverability).

## Phase 3: Build and Restart

```bash
pnpm run build
systemctl --user restart nanoclaw  # Linux
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
```

The container image does not need rebuilding — the change is config-only. The
agent-runner sees the new `mcpServers.linear` entry on the next session start.

## Phase 4: Verify

Tell the user:

> In your `<agent-name>` chat, send: **"list my Linear teams"** or **"show my open
> Linear issues assigned to me"**.
>
> The agent should call `mcp__linear__list_teams` / `mcp__linear__list_issues`. The
> first call may take a second or two while the MCP server connects and OneCLI does
> the token exchange.

### Check logs if the tool isn't working

```bash
tail -100 logs/nanoclaw.log logs/nanoclaw.error.log | grep -iE 'linear|mcp'
ls data/v2-sessions/*/stderr.log | head
```

Common signals:

- `MCP server "linear" failed to connect` — the URL is wrong, network is blocked, or
  the OneCLI proxy isn't installed in the container. Check `https_proxy` and the CA
  cert in the container env.
- `401 Unauthorized` from `mcp.linear.app` — OneCLI isn't injecting. Check the
  agent's secret mode (`onecli agents secrets --id <agent-id>`) and that the Linear
  app is connected.
- Agent says "I don't have Linear tools" — `mcp__linear__*` is missing from
  `TOOL_ALLOWLIST` in `container/agent-runner/src/providers/claude.ts`, or the
  agent-runner wasn't rebuilt. Run `./container/build.sh` again.
- Connection times out — the SDK has a 60s default. Manual retry usually clears
  cold-start delays.

## Removal

1. In each wired group's `container.json`, delete the `linear` entry from
   `mcpServers` and the `LINEAR_API_KEY` entry from `env`.
2. (Optional, only if no other group uses Linear) Remove the Linear secret from
   OneCLI: `onecli secrets delete --id <linear-secret-id>`.
3. (Optional) Disconnect Linear in the OneCLI web UI.
4. `pnpm run build && systemctl --user restart nanoclaw`.

The trunk-side type union and the `mcp__linear__*` allowlist entry stay in place —
they support any future HTTP MCP server, not just Linear.

## Notes

- **Tool surface drift.** The `mcp__linear__*` set is whatever Linear's hosted MCP
  exposes today. Linear can change it. Upside: API additions appear automatically.
- **No Dockerfile changes.** Linear's MCP is hosted, so no `pnpm install -g` block
  is needed (unlike `/add-gmail-tool`).
- **Approval-gating writes.** If you want admin approval for issue creation,
  configure the rule in OneCLI's web UI; nanoclaw's existing approval bridge
  (`src/onecli-approvals.ts`) routes pending approvals to admins.
- **Distinct from `/add-linear`.** The channel skill installs the webhook adapter so
  Linear comments trigger the agent. This skill gives the agent the ability to
  *call* Linear. They are independent; both are useful.

## Credits & references

- **Linear MCP docs:** `https://linear.app/docs/mcp`.
- **Claude Agent SDK MCP docs:** `https://code.claude.com/docs/en/agent-sdk/mcp`.
- **Skill pattern:** modeled on `/add-gmail-tool` and `/add-gcal-tool`.
- **Spec:** `docs/superpowers/specs/2026-04-28-linear-hosted-mcp-design.md`.
- **Plan:** `docs/superpowers/plans/2026-04-28-linear-hosted-mcp.md`.
