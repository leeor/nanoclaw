---
name: add-backoffice-tool
description: Wire an operator-supplied OpenAPI backoffice MCP server into agent containers. Per-group opt-in via env vars + a bind mount. The MCP server package itself is operator-private and not bundled with the skill.
---

# Add Backoffice Tool

This skill wires an external **backoffice MCP server** into the agent container. The MCP server is operator-supplied — typically an internal service that exposes your company's backoffice API to the agent over the MCP stdio protocol (e.g. an OpenAPI 3.1 reflector).

The skill itself is just glue:

- Conditionally registers the server with the agent-runner when `BO_API_URL` and `BO_AUTH_TOKEN` are set in the container env **and** the package is bind-mounted at `/opt/backoffice-mcp/dist/index.js`.
- Adds `mcp__backoffice__*` to the SDK tool allowlist under the same gate.
- Scrubs `BO_API_URL` and `BO_AUTH_TOKEN` from `process.env` after the MCP server is configured, so the agent cannot read them via Bash.

If the env vars are unset or the package isn't mounted, the wiring is a no-op — safe to apply globally and opt in per group.

## Prerequisites

1. **Backoffice MCP server package** built locally on the host. The skill assumes:
   - Entrypoint at `<some-host-path>/dist/index.js`
   - Speaks the MCP stdio protocol
   - Reads `BO_API_URL` and `BO_AUTH_TOKEN` from its own env
2. **Credentials**: `BO_API_URL` (your backoffice base URL) and `BO_AUTH_TOKEN` (an auth token). OneCLI vault is preferred — see step 3 below.

## Phase 1: Apply the patches

### Ensure upstream remote

```bash
git remote -v
```

If `upstream` is missing:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch upstream skill/add-backoffice-tool
git merge upstream/skill/add-backoffice-tool
```

This merges in:

- `container/agent-runner/src/providers/types.ts` — adds `additionalAllowedTools` to `ProviderOptions`.
- `container/agent-runner/src/providers/claude.ts` — appends `additionalAllowedTools` to the SDK allowlist.
- `container/agent-runner/src/index.ts` — backoffice MCP server registration + env scrub.
- `container/Dockerfile` — operator-mount-point comment (no behavior change).

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate the build

```bash
pnpm install
pnpm run build
pnpm test
```

All must pass before proceeding.

## Phase 2: Per-group config

For each agent group that should expose backoffice tools, edit `groups/<folder>/container.json` to bind-mount the operator-supplied package read-only at the conventional path:

```json
{
  "additionalMounts": [
    {
      "hostPath": "/absolute/path/to/your/backoffice-mcp",
      "containerPath": "/opt/backoffice-mcp",
      "readonly": true
    }
  ]
}
```

The `containerPath` must be exactly `/opt/backoffice-mcp` — the runner looks for `/opt/backoffice-mcp/dist/index.js`. The `hostPath` is wherever you cloned/built the package on the host.

## Phase 3: Credentials

Pick **one** of the following.

### Option A — OneCLI vault (recommended)

OneCLI keeps the token out of `.env` and out of the agent's process env entirely; it injects an `Authorization` header on outbound requests to your backoffice host.

```bash
onecli secrets create \
  --name "Backoffice API" \
  --type generic \
  --value "<your-token>" \
  --host-pattern "<your-backoffice-host>" \
  --injection-header Authorization \
  --injection-format "Bearer {value}"
```

For this option, `BO_AUTH_TOKEN` does not need to be set in the container env at all — but you still need `BO_API_URL` set so the runner gates the MCP server on. Set `BO_AUTH_TOKEN` to a non-empty placeholder (e.g. `oncecli`) so the gate passes; OneCLI overrides the actual auth header on the wire.

If your backoffice MCP server makes its own outbound HTTP calls inside the container, ensure the container is configured to route through the OneCLI proxy (this is the default in NanoClaw v2 — see `docs/api-details.md`).

### Option B — Container env passthrough

Simpler, but the token sits in `.env` and is briefly present in `process.env` inside the container before the runner scrubs it.

Add to `.env`:

```bash
BO_API_URL=https://backoffice.example.com
BO_AUTH_TOKEN=<your-token>
```

Make sure your `src/container-runner.ts` env passthrough propagates `BO_API_URL` and `BO_AUTH_TOKEN` into the container. If your install already passes the full `.env` through, no further change is needed.

## Phase 4: Rebuild and restart

```bash
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                # Linux
```

New sessions will pick up the wiring on next spawn.

## Verify

### Host-side static checks

```bash
grep "fs.existsSync('/opt/backoffice-mcp/dist/index.js')" container/agent-runner/src/index.ts
grep "delete process.env.BO_API_URL"                       container/agent-runner/src/index.ts
grep "mcp__backoffice__\\*"                                 container/agent-runner/src/index.ts
```

All three should match.

### Container-side check

After the agent group has spawned a session, exec into the container:

```bash
docker ps --filter "name=nanoclaw" --format "{{.ID}} {{.Names}}"
docker exec <container> sh -c 'env | grep -E "^BO_"; ls -l /opt/backoffice-mcp/dist/index.js'
```

Expected:

- `env | grep BO_` → empty (vars were scrubbed after the runner consumed them).
- `ls /opt/backoffice-mcp/dist/index.js` → file exists.

### End-to-end check

Send a message to the wired group asking the agent to list backoffice endpoints. The agent should call `mcp__backoffice__*` tools and return real results.

## Troubleshooting

### Agent reports the backoffice tools don't exist

One of the three gate conditions failed. Check, in order:

1. The host bind-mount is wired correctly: `docker exec <container> ls /opt/backoffice-mcp/dist/index.js` succeeds.
2. The container had `BO_API_URL` and `BO_AUTH_TOKEN` set when the runner started. Look in the agent-runner logs for the line `Backoffice MCP server wired (BO_API_URL + BO_AUTH_TOKEN present)`.
3. The container was restarted after wiring (env vars are read once at startup).

### `mcp__backoffice__*` calls hang or 401

The MCP server itself is reaching the backoffice with the wrong (or missing) credentials. If using OneCLI, verify the secret host pattern matches the actual hostname the MCP server connects to and the agent has been switched to `mode all` (or the secret is explicitly assigned). If using env passthrough, verify the token is correct.

### Build fails after merge

Most likely a conflict in `container/agent-runner/src/index.ts` was resolved incorrectly. The backoffice block must run **after** `mcpServers` is built from `config.mcpServers` and **before** the `delete process.env.BO_*` lines. The `additionalAllowedTools` array must be passed to `createProvider`.

## Constraints

- The backoffice MCP server package itself is **never** bundled with the skill — it stays operator-private.
- The env scrub (`delete process.env.BO_API_URL` / `BO_AUTH_TOKEN`) is intentional defense-in-depth and must not be removed. The MCP server still receives the values via its explicit `env:` block, captured before the scrub.
- The `mcp__backoffice__*` allowlist entry is gated on the same env-var presence check — don't allow it unconditionally.
