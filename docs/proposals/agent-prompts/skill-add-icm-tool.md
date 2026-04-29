# Prompt: `skill/add-icm-tool`

You are an autonomous agent working in `~/repos/nanoclaw-v2`. Your task: build the `add-icm-tool` skill that makes ICM (Infinite Context Memory) available to agents via MCP. The skill is small — first one in the migration; treat it as the validation case for the v2 skill-apply lifecycle.

## Goal

Skill ships as the `skill/add-icm-tool` branch. When applied via `/customize` (or `scripts/apply-skill.ts`), it:

1. Adds the `icm` binary to the container image (Dockerfile patch).
2. Initializes per-group `.icm/config.toml` if missing on first MCP startup.
3. Wires `icm serve --compact` as an MCP server in the container agent-runner.
4. Adds `mcp__icm__*` to the allowed tool prefixes for groups that opt in.
5. Per-group enable via `groups/<folder>/container.json` (empty `mcpServers` object today; skill adds `icm` entry only for opted-in groups).

## Branch

```bash
git checkout main
git pull origin main
git checkout -b skill/add-icm-tool
```

## v1 reference

The v1 fork already does this — copy the *intent*, adapt to v2's structure. Reference commits:

- `9767fbcb` — Dockerfile patch (adds ICM binary, switches base to `node:22-trixie-slim`, fixes `libasound2` → `libasound2t64`). View: `git -C ~/repos/nanoclaw show 9767fbcb`.
- `b542c8fc` — agent-runner integration (config init, MCP server registration, tool-prefix allowlist). View: `git -C ~/repos/nanoclaw show b542c8fc`.

In v1, ICM was wired only for `containerInput.isMain`. In v2, the skill enables per-group via `container.json` config — cleaner.

## Implementation

### File: `container/Dockerfile`

Patch base + ICM install. Reference the v1 patch in `9767fbcb`. Concretely, after the existing `RUN pnpm install -g "@anthropic-ai/claude-code@..."` line, add:

```dockerfile
# Install ICM (Infinite Context Memory) — opt-in via groups/<f>/container.json mcpServers.
# .deb for amd64; tarball for arm64.
RUN arch=$(dpkg --print-architecture) && \
    if [ "$arch" = "amd64" ]; then \
        curl -fsSL -o /tmp/icm.deb https://github.com/rtk-ai/icm/releases/latest/download/icm_amd64.deb && \
        dpkg -i /tmp/icm.deb && rm /tmp/icm.deb; \
    elif [ "$arch" = "arm64" ]; then \
        curl -fsSL -o /tmp/icm.tgz https://github.com/rtk-ai/icm/releases/latest/download/icm-aarch64-unknown-linux-gnu.tar.gz && \
        tar -xzf /tmp/icm.tgz -C /usr/local/bin --strip-components=1 && \
        chmod +x /usr/local/bin/icm && rm /tmp/icm.tgz; \
    else echo "unsupported arch for ICM: $arch" && exit 1; fi && \
    icm --version
```

If the v2 `Dockerfile` already uses `node:22-trixie-slim` and `libasound2t64`, skip those changes — they're only needed if an older base is in use. Inspect first.

### File: `container/agent-runner/src/icm-init.ts` (new)

Container-side helper that initializes per-group ICM state on first startup. Modelled on the v1 inline block.

```typescript
import fs from 'fs';
import path from 'path';

/**
 * Initialize per-group ICM config under /workspace/group/.icm if missing.
 * Returns the absolute path to config.toml — pass to the icm MCP server's
 * ICM_CONFIG env var. Returns null if .icm/ wasn't requested by the
 * container.json mcpServers config (caller decides whether to wire icm).
 *
 * Idempotent — only writes paths that don't exist.
 */
export function ensureIcmConfig(groupDir: string): string {
  const icmDir = path.join(groupDir, '.icm');
  const configPath = path.join(icmDir, 'config.toml');
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(icmDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      `[store]\npath = "${path.join(icmDir, 'memories.db')}"\n\n[embeddings]\nenabled = true\nmodel = "intfloat/multilingual-e5-base"\n`,
    );
  }
  return configPath;
}
```

### File: `container/agent-runner/src/index.ts` (patch)

Find the section that builds `mcpServers` from `config.mcpServers` (look for `for (const [name, serverConfig] of Object.entries(config.mcpServers))` or similar — it's where external MCP servers get loaded). For the `icm` entry specifically, intercept and call `ensureIcmConfig(...)` on the group dir to populate `ICM_CONFIG` env.

Approach: if `config.mcpServers.icm` is requested with no env, fill in `ICM_CONFIG` automatically. Or: agree the operator must set `ICM_CONFIG` themselves in container.json. Cleaner: skill auto-fills, since the path is invariant per group.

Pseudocode:

```typescript
import { ensureIcmConfig } from './icm-init.js';

// inside the loop that copies config.mcpServers into mcpServers:
for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
  if (name === 'icm' && (!serverConfig.env || !serverConfig.env.ICM_CONFIG)) {
    const configPath = ensureIcmConfig('/workspace/group');
    mcpServers[name] = {
      ...serverConfig,
      env: { ...serverConfig.env, ICM_CONFIG: configPath },
    };
  } else {
    mcpServers[name] = serverConfig;
  }
}
```

Also patch the allowed tool prefixes in the same file. Find the array and append:

```typescript
'mcp__icm__*',
```

— but only when the agent group has icm in its mcpServers, so this needs a runtime check. Look at how `process.env.SLACK_BOT_TOKEN` was used as a gate in `776d6e7c` — same shape (conditional spread). Use `config.mcpServers.icm` presence as the gate.

### File: `groups/slack_main/container.json` (patch via skill apply)

Skill apply (or doc) instructs the operator: add to the wired group's container.json:

```json
{
  "mcpServers": {
    "icm": {
      "command": "icm",
      "args": ["serve", "--compact"],
      "env": {}
    }
  }
}
```

The runner fills in `ICM_CONFIG` automatically (via `icm-init.ts`). The operator's container.json is minimal.

### File: `.claude/skills/add-icm-tool/SKILL.md` (new)

Skill manifest. Reference the existing `init-onecli/SKILL.md` shape:

```markdown
---
name: add-icm-tool
description: Add ICM (Infinite Context Memory) MCP integration. Per-group opt-in via container.json.
---

# Add ICM Tool

Adds the ICM binary to the container image and wires `icm serve --compact` as an MCP server. Per-group opt-in via `mcpServers.icm` in `groups/<folder>/container.json`.

## Install

### 1. Apply the patches

```bash
git fetch origin skill/add-icm-tool
git cherry-pick origin/skill/add-icm-tool~..origin/skill/add-icm-tool
```

(or use the apply-skill helper if available)

### 2. Rebuild the container image

```bash
./container/build.sh
```

### 3. Enable per-group

Edit `groups/<folder>/container.json` for any group you want to use ICM:

```json
{
  "mcpServers": {
    "icm": {
      "command": "icm",
      "args": ["serve", "--compact"],
      "env": {}
    }
  }
}
```

The runner auto-populates `ICM_CONFIG` to point at `groups/<folder>/.icm/config.toml`, creating it on first run with multilingual-e5-base embeddings enabled.

## Migrate existing ICM state (optional)

If migrating from v1 fork:

```bash
cp -a ~/repos/nanoclaw.v1-backup/groups/slack_main/.icm groups/slack_main/
```

## Verify

After rebuild + restart:

- `groups/<folder>/.icm/config.toml` exists.
- Agent can call `mcp__icm__*` tools.
- `groups/<folder>/.icm/memories.db` opens with sqlite3 (after first write).
```

### File: `.claude/skills/add-icm-tool/VERIFY.md` (new, optional)

Concrete verification steps for `/customize` to run.

```bash
# binary present in image
docker run --rm --entrypoint /bin/sh nanoclaw-agent:v2 -c 'icm --version'
# config init helper exists
test -f container/agent-runner/src/icm-init.ts
# allowlist patched
grep 'mcp__icm__\*' container/agent-runner/src/index.ts
```

## Tests

Add `container/agent-runner/src/icm-init.test.ts`:

- Idempotent — second call doesn't overwrite existing config.toml.
- Returns absolute path to config.toml.
- Creates `.icm/` dir if missing.

If the v2 agent-runner doesn't have a vitest setup of its own, skip — note in OUT doc.

## Verify

```bash
pnpm run build
./container/build.sh           # tag stays nanoclaw-agent:v2
pnpm test                       # unit tests
```

Container build must include `icm` binary.

End-to-end smoke (optional but valued):

1. Add icm entry to `groups/cli-with-leeor/container.json` (the test agent group from `pnpm exec tsx scripts/init-cli-agent.ts`).
2. `pnpm run dev` then `pnpm run chat 'remember that my favorite color is purple'`.
3. Verify the agent calls `mcp__icm__store` (check container stderr or `groups/cli-with-leeor/.icm/memories.db`).

## Output

Write a PR description to `docs/proposals/agent-prompts/skill-add-icm-tool-OUT.md`:

- Summary.
- File-by-file diff summary.
- Test/build results.
- Notes for reviewer.

Push:

```bash
git push -u origin skill/add-icm-tool
```

## Constraints

- **Per-group opt-in** (no fork-style hardcoded `isMain` gate).
- **Container.json schema unchanged** — skill uses the existing `mcpServers` field.
- **Auto-populate `ICM_CONFIG`** in the runner so operator config stays minimal.
- **Idempotent config init** — safe to re-run.
- **Don't touch v1** (`~/repos/nanoclaw` read-only).

## Reference

- v1 commits: `b542c8fc`, `9767fbcb` (in `~/repos/nanoclaw`).
- v2 mcp-tools pattern: `container/agent-runner/src/mcp-tools/index.ts`.
- v2 container.json schema: `src/container-config.ts`.

## Done criteria

- [ ] Branch `skill/add-icm-tool` exists.
- [ ] Dockerfile patched (or no-op if already trixie + libasound2t64; just add icm install block).
- [ ] `container/agent-runner/src/icm-init.ts` exists.
- [ ] `container/agent-runner/src/index.ts` patched (mcpServers config injection + tool prefix).
- [ ] `.claude/skills/add-icm-tool/SKILL.md` written.
- [ ] `pnpm run build` clean.
- [ ] `./container/build.sh` succeeds; image has `icm` binary.
- [ ] OUT doc written.
- [ ] Branch pushed.
