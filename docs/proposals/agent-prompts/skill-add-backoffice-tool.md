# Prompt: `skill/add-backoffice-tool`

You are an autonomous agent working in `~/repos/nanoclaw-v2`. Your task: build the `add-backoffice-tool` skill that wires a backoffice OpenAPI MCP server into agent containers per-group.

## Goal

Skill ships as the `skill/add-backoffice-tool` branch. When applied:

1. Documents how the operator builds / mounts the `backoffice-mcp` package into the container.
2. Wires the MCP server in agent-runner config when env vars `BO_API_URL` + `BO_AUTH_TOKEN` are set in the group's container env.
3. Adds `mcp__backoffice__*` to the allowed tool prefixes (gated on env presence).
4. Per-group opt-in via `groups/<folder>/container.json` mcpServers + a runtime env-var gate.

The backoffice MCP package itself lives **outside the repo** (operator-private). Skill does not bundle the package; it documents the wiring and conditionally activates when the package is present.

## Branch

```bash
git checkout main
git pull origin main
git checkout -b skill/add-backoffice-tool
```

## v1 reference

The v1 fork has the wiring inline in `container/agent-runner/src/index.ts`. Reference commit:

- `1195182` (containers OpenAPI 3.1 parser update + agent permissions for blocklist/backfill writes — large commit, look only at the agent-runner index.ts hunk).
- `776d6e7c` (cleaned-up backoffice MCP block; better reference for the gate logic).

Inspect both:

```bash
git -C ~/repos/nanoclaw show 776d6e7c -- container/agent-runner/src/index.ts
```

Key v1 pattern:

```typescript
...(process.env.BO_API_URL && process.env.BO_AUTH_TOKEN &&
    fs.existsSync('/opt/backoffice-mcp/dist/index.js') ? {
  'backoffice': {
    command: 'node',
    args: ['/opt/backoffice-mcp/dist/index.js'],
    env: {
      BO_API_URL: process.env.BO_API_URL,
      BO_AUTH_TOKEN: process.env.BO_AUTH_TOKEN,
    },
  },
} : {}),
```

In v2, env vars are part of the per-group container.json or injected via OneCLI vault. The package mount point convention stays `/opt/backoffice-mcp/dist/index.js` for compatibility.

## Implementation

### File: `container/Dockerfile`

Add a placeholder mount point — the package itself is operator-supplied. No COPY step in the image; operator bind-mounts at runtime via container.json `additionalMounts`. Add a comment:

```dockerfile
# Backoffice MCP server is operator-supplied — not bundled in this image.
# Operator bind-mounts /opt/backoffice-mcp via container.json additionalMounts:
#   { hostPath: "/path/to/backoffice-mcp", containerPath: "/opt/backoffice-mcp", readonly: true }
# Wired by add-backoffice-tool skill when BO_API_URL + BO_AUTH_TOKEN env vars are set.
```

(Document-only; no actual change needed if no other Dockerfile edits.)

### File: `container/agent-runner/src/index.ts` (patch)

Find the `mcpServers` build block (where `config.mcpServers` is iterated). After the existing iteration, conditionally add a backoffice entry if env vars + file exist:

```typescript
import fs from 'fs';   // already imported probably

// inside main, near where mcpServers is built:
if (
  process.env.BO_API_URL &&
  process.env.BO_AUTH_TOKEN &&
  fs.existsSync('/opt/backoffice-mcp/dist/index.js')
) {
  mcpServers.backoffice = {
    command: 'node',
    args: ['/opt/backoffice-mcp/dist/index.js'],
    env: {
      BO_API_URL: process.env.BO_API_URL,
      BO_AUTH_TOKEN: process.env.BO_AUTH_TOKEN,
    },
  };
}
```

Patch the allowed tool prefix list — find where `mcp__*` allowlist patterns live:

```typescript
...(process.env.BO_API_URL && process.env.BO_AUTH_TOKEN ? ['mcp__backoffice__*'] : []),
```

Important: scrub the env vars from `process.env` after they're consumed (so the agent can't read them via Bash). Reference v1's commit `776d6e7c` for the scrub pattern:

```typescript
delete process.env.BO_API_URL;
delete process.env.BO_AUTH_TOKEN;
```

Place the delete after the MCP server is started. Comment that this hardening is intentional.

### File: `groups/<folder>/container.json` (operator-side)

Document this — skill doesn't write to user groups. SKILL.md instructs:

```json
{
  "additionalMounts": [
    {
      "hostPath": "/path/to/your/backoffice-mcp",
      "containerPath": "/opt/backoffice-mcp",
      "readonly": true
    }
  ],
  "mcpServers": {}
}
```

Plus the env vars (`BO_API_URL`, `BO_AUTH_TOKEN`) need to reach the container. Two options to document:

- **OneCLI vault**: register via `onecli secrets create` with a header injection config. Container's HTTPS_PROXY routes through the vault; backoffice API calls get the auth header injected.
- **Container env passthrough**: simpler but less secure — append to `.env` and propagate via container-runner.

Recommend OneCLI for production. Document both.

### File: `.claude/skills/add-backoffice-tool/SKILL.md` (new)

Manifest with install / configure / verify steps.

```markdown
---
name: add-backoffice-tool
description: Wire an operator-supplied OpenAPI backoffice MCP server into agent containers. Per-group opt-in via env vars.
---

# Add Backoffice Tool

Adds wiring for an external backoffice MCP server (operator-supplied — not bundled in this skill).

## Prerequisites

1. A backoffice MCP server package built locally — typically at `/path/to/backoffice-mcp/dist/index.js`. Skill assumes the package implements the MCP stdio protocol with OpenAPI 3.1 endpoint reflection.
2. `BO_API_URL` and `BO_AUTH_TOKEN` configured for the group, either via OneCLI vault (preferred) or container env passthrough.

## Install

### 1. Apply the patches

```bash
git fetch origin skill/add-backoffice-tool
git cherry-pick origin/skill/add-backoffice-tool~..origin/skill/add-backoffice-tool
```

### 2. Per-group config

For each group that should expose backoffice tools, edit `groups/<folder>/container.json`:

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

Plus configure `BO_API_URL` and `BO_AUTH_TOKEN` via OneCLI:

```bash
onecli secrets create \
  --name "Backoffice API" \
  --type generic \
  --value "<your-token>" \
  --host-pattern "<your-backoffice-host>" \
  --injection-header Authorization \
  --injection-format "Bearer {value}"
```

(Or set them in the group's env passthrough — see `docs/credentials.md`.)

### 3. Rebuild and restart

```bash
pnpm run build
./container/build.sh
# Restart NanoClaw service.
```

## Verify

After restart, send a message to the group. The agent should be able to call `mcp__backoffice__*` tools listing OpenAPI endpoints.

To check container-side:

```bash
docker exec <container> sh -c 'env | grep -E "^BO_"; ls /opt/backoffice-mcp/dist/index.js'
```

(BO env should be empty after MCP server start — they're scrubbed for security.)
```

### File: `.claude/skills/add-backoffice-tool/VERIFY.md` (new, optional)

Tool-prefix and gate logic checks:

```bash
grep 'mcp__backoffice__\*' container/agent-runner/src/index.ts
grep "fs.existsSync('/opt/backoffice-mcp/dist/index.js')" container/agent-runner/src/index.ts
grep 'delete process.env.BO_API_URL' container/agent-runner/src/index.ts
```

## Tests

If a backoffice MCP test fixture is available, run it. Otherwise, the skill is config-only and tested manually via the verify steps.

## Verify

```bash
pnpm run build
./container/build.sh   # ensures the patched runner compiles
```

## Output

Write a PR description to `docs/proposals/agent-prompts/skill-add-backoffice-tool-OUT.md`.

Push:

```bash
git push -u origin skill/add-backoffice-tool
```

## Constraints

- **Don't bundle** the backoffice-mcp package itself — it's operator-private.
- **Env scrubbing**: after MCP server start, delete `BO_API_URL` + `BO_AUTH_TOKEN` from `process.env` so the agent can't read them via Bash. Reference v1 commit `776d6e7c`.
- **Tool prefix gated on env presence**: don't allow `mcp__backoffice__*` if backoffice isn't actually wired.
- **Don't touch v1** (`~/repos/nanoclaw` read-only).

## Reference

- v1 commit `776d6e7c` — wiring + scrub pattern (in `~/repos/nanoclaw`).
- v1 commit `1195182` — OpenAPI 3.1 parser update (informational; not part of this skill).
- v2 mcpServers pattern: `container/agent-runner/src/index.ts` (search for `config.mcpServers`).
- OneCLI secret injection: `.claude/skills/init-onecli/SKILL.md`.

## Done criteria

- [ ] Branch `skill/add-backoffice-tool` exists.
- [ ] Dockerfile comment added (no real change needed).
- [ ] `container/agent-runner/src/index.ts` patched: gate, env scrub, tool prefix.
- [ ] `.claude/skills/add-backoffice-tool/SKILL.md` written.
- [ ] `pnpm run build` clean.
- [ ] `./container/build.sh` succeeds.
- [ ] OUT doc written.
- [ ] Branch pushed.
