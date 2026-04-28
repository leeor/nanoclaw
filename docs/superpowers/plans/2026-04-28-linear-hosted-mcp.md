# Linear Hosted MCP via OneCLI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace NanoClaw's 5-tool custom Linear GraphQL wrapper in the agent container with Linear's hosted HTTP MCP server (`https://mcp.linear.app/mcp`, ~50 tools), authenticated via OneCLI bearer-token injection.

**Architecture:** Extend `McpServerConfig` to a discriminated union (stdio | http | sse) on both host and container sides. Drop the custom wrapper. Add `mcp__linear__*` to the agent's tool allowlist. Add a new `/add-linear-tool` skill that wires per-group `container.json` to point at Linear's MCP with an `Authorization: Bearer ${LINEAR_API_KEY}` header — `LINEAR_API_KEY` is the OneCLI stub `onecli-managed`, swapped for the real OAuth token in flight by the OneCLI proxy already wired into agent containers.

**Tech Stack:** TypeScript (host: Node + pnpm + vitest; container: Bun + bun:test), `@anthropic-ai/claude-agent-sdk` (which natively accepts `type: 'http'` MCP configs), OneCLI gateway (proxy + vault).

**Spec:** `docs/superpowers/specs/2026-04-28-linear-hosted-mcp-design.md`.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `container/agent-runner/src/providers/types.ts` | Modify | Replace stdio-only `McpServerConfig` with a discriminated union covering stdio/http/sse. |
| `src/container-config.ts` | Modify | Same shape change on the host side; the host reads `groups/<folder>/container.json` and passes the map through unchanged. |
| `container/agent-runner/src/providers/claude.ts` | Modify | Add `'mcp__linear__*'` to `TOOL_ALLOWLIST`. |
| `container/agent-runner/src/mcp-tools/linear.ts` | Delete | Custom GraphQL wrapper removed. |
| `container/agent-runner/src/mcp-tools/linear.test.ts` | Delete | Tests for the wrapper removed. |
| `container/agent-runner/src/mcp-tools/index.ts` | Modify | Drop `import './linear.js';`. |
| `container/agent-runner/src/providers/types.test.ts` | Create | Bun test that constructs each MCP config variant — type-level assertion via `satisfies`, plus a runtime check that the discriminator routes correctly. |
| `src/container-config.test.ts` | Create (if absent) or extend | Vitest test that reads a `container.json` containing an http MCP entry and confirms the parsed shape. |
| `.claude/skills/add-linear-tool/SKILL.md` | Create | New install skill modeled on `add-gmail-tool` / `add-gcal-tool`. |

No host-runtime code beyond `container-config.ts` is touched. `container-runner.ts` already passes `containerConfig.mcpServers` through unchanged. `claude-md-compose.ts` reads only `mcp.instructions`, which the union preserves.

---

## Task 1: Container-side `McpServerConfig` discriminated union (TDD)

**Files:**
- Create: `container/agent-runner/src/providers/types.test.ts`
- Modify: `container/agent-runner/src/providers/types.ts`

- [ ] **Step 1: Write the failing test**

Create `container/agent-runner/src/providers/types.test.ts`:

```typescript
import { describe, expect, it } from 'bun:test';
import type { McpServerConfig } from './types.js';

describe('McpServerConfig discriminated union', () => {
  it('accepts a stdio entry without an explicit type', () => {
    const cfg: McpServerConfig = {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      env: { FOO: 'bar' },
    };
    expect(cfg.command).toBe('npx');
  });

  it('accepts a stdio entry with explicit type', () => {
    const cfg: McpServerConfig = {
      type: 'stdio',
      command: 'npx',
      args: [],
    };
    if (cfg.type === 'stdio' || cfg.type === undefined) {
      expect(cfg.command).toBe('npx');
    }
  });

  it('accepts an http entry with headers', () => {
    const cfg: McpServerConfig = {
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      headers: { Authorization: 'Bearer onecli-managed' },
    };
    if (cfg.type === 'http') {
      expect(cfg.url).toBe('https://mcp.linear.app/mcp');
      expect(cfg.headers?.Authorization).toContain('Bearer');
    }
  });

  it('accepts an sse entry', () => {
    const cfg: McpServerConfig = {
      type: 'sse',
      url: 'https://example.com/mcp/sse',
    };
    if (cfg.type === 'sse') {
      expect(cfg.url).toContain('sse');
    }
  });

  it('preserves an instructions field across variants', () => {
    const stdioWithInstructions: McpServerConfig = {
      command: 'foo',
      instructions: 'use this for X',
    };
    const httpWithInstructions: McpServerConfig = {
      type: 'http',
      url: 'https://x',
      instructions: 'use this for X',
    };
    expect(stdioWithInstructions.instructions).toBe('use this for X');
    expect(httpWithInstructions.instructions).toBe('use this for X');
  });
});
```

- [ ] **Step 2: Run typecheck and test to verify they fail**

Run: `cd container/agent-runner && bun run typecheck`
Expected: errors like `Type '"http"' is not assignable to type ... — http variant unknown`.

Run: `cd container/agent-runner && bun test src/providers/types.test.ts`
Expected: build/typecheck failure.

- [ ] **Step 3: Implement the union in `types.ts`**

Replace the existing `McpServerConfig` interface in `container/agent-runner/src/providers/types.ts` with:

```typescript
export type McpServerConfig = McpStdioConfig | McpHttpConfig | McpSseConfig;

export interface McpStdioConfig {
  /** Optional discriminator. Omitted = stdio (back-compat with existing configs). */
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Always-in-context guidance, copied into CLAUDE.md by the host. */
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

Leave the `args` field on `McpStdioConfig` optional (it was required before, but several call sites set `args: []` explicitly — keep them working).

- [ ] **Step 4: Verify typecheck and test pass**

Run: `cd container/agent-runner && bun run typecheck`
Expected: clean.

Run: `cd container/agent-runner && bun test src/providers/types.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Run the full container-side suite to confirm no regression**

Run: `cd container/agent-runner && bun test`
Expected: all suites pass.

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/providers/types.ts container/agent-runner/src/providers/types.test.ts
git commit -m "feat(container): McpServerConfig discriminated union for http/sse MCP servers

Adds 'http' and 'sse' variants alongside the existing stdio shape. The
discriminator is optional on stdio for back-compat with existing
container.json files.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Host-side `McpServerConfig` discriminated union (TDD)

**Files:**
- Create: `src/container-config.test.ts`
- Modify: `src/container-config.ts`

The host's `McpServerConfig` is an independent type definition (not imported from the container — they don't share a tsconfig). Mirror the same shape.

- [ ] **Step 1: Write the failing test**

Create `src/container-config.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readContainerConfig } from './container-config.js';

let tmpRoot: string;
let originalGroupsDir: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'nanoclaw-cfg-'));
  originalGroupsDir = process.env.NANOCLAW_GROUPS_DIR;
  process.env.NANOCLAW_GROUPS_DIR = tmpRoot;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (originalGroupsDir === undefined) delete process.env.NANOCLAW_GROUPS_DIR;
  else process.env.NANOCLAW_GROUPS_DIR = originalGroupsDir;
});

describe('readContainerConfig', () => {
  it('parses an http MCP server entry without dropping the type/url/headers', () => {
    const folder = 'g1';
    const dir = join(tmpRoot, folder);
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'container.json'),
      JSON.stringify({
        mcpServers: {
          linear: {
            type: 'http',
            url: 'https://mcp.linear.app/mcp',
            headers: { Authorization: 'Bearer onecli-managed' },
          },
        },
      }),
    );

    const cfg = readContainerConfig(folder);
    const linear = cfg.mcpServers.linear;
    expect(linear).toBeDefined();
    if (linear && 'type' in linear && linear.type === 'http') {
      expect(linear.url).toBe('https://mcp.linear.app/mcp');
      expect(linear.headers?.Authorization).toBe('Bearer onecli-managed');
    } else {
      throw new Error('expected http variant');
    }
  });

  it('still parses a stdio MCP server entry without an explicit type', () => {
    const folder = 'g2';
    const dir = join(tmpRoot, folder);
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'container.json'),
      JSON.stringify({
        mcpServers: {
          icm: { command: 'icm', args: ['serve', '--compact'], env: {} },
        },
      }),
    );
    const cfg = readContainerConfig(folder);
    const icm = cfg.mcpServers.icm;
    expect(icm).toBeDefined();
    if (icm && (!('type' in icm) || icm.type === 'stdio' || icm.type === undefined)) {
      expect(icm.command).toBe('icm');
    } else {
      throw new Error('expected stdio variant');
    }
  });
});
```

Note: this test depends on `GROUPS_DIR` being read from an env var. Verify it is — if `src/config.ts` exports `GROUPS_DIR` as a constant initialized once at import time, the test must instead point `readContainerConfig` at an explicit path. Inspect first:

Run: `grep -n GROUPS_DIR /home/leeor/repos/nanoclaw/src/config.ts`

If `GROUPS_DIR` is a static constant, simplify the test by stubbing `fs` or by constructing absolute paths and using a minimal helper. If the codebase already has a similar pattern in another `*.test.ts` for `container-config`, copy it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- container-config`
Expected: type errors on `linear.type === 'http'` (the `McpServerConfig` interface lacks the `http` variant).

- [ ] **Step 3: Implement the host-side union**

Edit `src/container-config.ts`. Replace the existing `McpServerConfig` interface (lines 17–25) with:

```typescript
export type McpServerConfig = McpStdioConfig | McpHttpConfig | McpSseConfig;

export interface McpStdioConfig {
  /** Optional discriminator. Omitted = stdio (back-compat). */
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Always-in-context guidance. When set, the host writes the content to
   * `.claude-fragments/mcp-<name>.md` at spawn and imports it into the
   * composed CLAUDE.md.
   */
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

The two consumers of the host-side type already work with this union:

- `src/claude-md-compose.ts:94` only reads `mcp.instructions`, which exists on every variant.
- `src/modules/self-mod/apply.ts:75` constructs a stdio entry literally — its assignment is still type-compatible because the new `McpStdioConfig` requires the same fields.

- [ ] **Step 4: Run the test and full host suite**

Run: `pnpm test -- container-config`
Expected: 2 passed.

Run: `pnpm test`
Expected: full suite passes, including `src/container-backends/devcontainer.test.ts` and `src/container-backends/docker.test.ts` which use `mcpServers: {}` (still valid — empty object trivially satisfies `Record<string, McpServerConfig>`).

- [ ] **Step 5: Run the host build**

Run: `pnpm run build`
Expected: clean tsc compile.

- [ ] **Step 6: Commit**

```bash
git add src/container-config.ts src/container-config.test.ts
git commit -m "feat(host): McpServerConfig discriminated union for http/sse

Mirrors the container-side change. claude-md-compose reads only the
instructions field which is shared across variants; self-mod's
add_mcp_server handler stays stdio-only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add `mcp__linear__*` to the container's `TOOL_ALLOWLIST`

**Files:**
- Modify: `container/agent-runner/src/providers/claude.ts`

This is a one-line change that surfaces all Linear MCP tools to the agent. There is no existing test against `TOOL_ALLOWLIST`. Add a tiny unit test alongside the change so the wildcard isn't silently lost in a future refactor.

- [ ] **Step 1: Write the failing test**

Create `container/agent-runner/src/providers/claude.test.ts` (or extend if it exists):

```typescript
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

describe('TOOL_ALLOWLIST surface', () => {
  it('includes mcp__linear__* so Linear hosted MCP tools are reachable', () => {
    const src = readFileSync(join(here, 'claude.ts'), 'utf8');
    expect(src).toContain("'mcp__linear__*'");
  });
});
```

(File-grep style — keeps the test trivial and avoids exporting `TOOL_ALLOWLIST` only for testing.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd container/agent-runner && bun test src/providers/claude.test.ts`
Expected: fail — string not found.

- [ ] **Step 3: Add the entry**

Edit `container/agent-runner/src/providers/claude.ts`. Find the `TOOL_ALLOWLIST` array. Insert `'mcp__linear__*',` directly after `'mcp__nanoclaw__*',`:

```typescript
const TOOL_ALLOWLIST = [
  // ...
  'mcp__nanoclaw__*',
  'mcp__linear__*',
];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd container/agent-runner && bun test src/providers/claude.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/providers/claude.ts container/agent-runner/src/providers/claude.test.ts
git commit -m "feat(container): allow mcp__linear__* tools

Surfaces tools from the Linear hosted MCP server (configured per-group
via container.json) to the agent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Drop the custom Linear GraphQL wrapper

**Files:**
- Delete: `container/agent-runner/src/mcp-tools/linear.ts`
- Delete: `container/agent-runner/src/mcp-tools/linear.test.ts`
- Modify: `container/agent-runner/src/mcp-tools/index.ts`

- [ ] **Step 1: Delete the wrapper and its tests**

```bash
rm container/agent-runner/src/mcp-tools/linear.ts container/agent-runner/src/mcp-tools/linear.test.ts
```

- [ ] **Step 2: Remove the import from the barrel**

Edit `container/agent-runner/src/mcp-tools/index.ts`. Delete the line:

```typescript
import './linear.js';
```

- [ ] **Step 3: Run the container suite to confirm no broken references**

Run: `cd container/agent-runner && bun run typecheck && bun test`
Expected: clean. Any test or source file that imported from `./linear.js` should already be gone (the only consumers are the deleted test file and the deleted import).

If typecheck flags an unexpected reference, investigate before forcing through.

- [ ] **Step 4: Commit**

```bash
git add -A container/agent-runner/src/mcp-tools/
git commit -m "refactor(container): drop custom Linear GraphQL wrapper

Replaced by Linear's hosted MCP server (https://mcp.linear.app/mcp)
wired per-group via container.json. The hosted server exposes ~50
tools versus this wrapper's 5; auth via OneCLI bearer-token injection.

Tool names change linear_* -> mcp__linear__*. Group CLAUDE.md files
that documented the old names will be updated by the new
/add-linear-tool skill when applied.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Build verification (full)

**Files:** none modified — verification only.

- [ ] **Step 1: Host build**

Run: `pnpm run build`
Expected: clean.

- [ ] **Step 2: Container typecheck**

Run: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 3: Host tests**

Run: `pnpm test`
Expected: all green.

- [ ] **Step 4: Container tests**

Run: `cd container/agent-runner && bun test`
Expected: all green.

- [ ] **Step 5: Container image rebuild**

Run: `./container/build.sh`
Expected: image builds clean. The dropped `linear.ts` source is included via Bun runtime — no Dockerfile change needed.

If the build's `COPY` cache returns a stale tree, run `docker buildx prune -f` then re-run `./container/build.sh`.

- [ ] **Step 6: No commit (verification step)**

If anything fails, do not proceed — fix and rerun.

---

## Task 6: Create the `/add-linear-tool` skill

**Files:**
- Create: `.claude/skills/add-linear-tool/SKILL.md`
- Create: `.claude/skills/add-linear-tool/REMOVE.md`
- Create: `.claude/skills/add-linear-tool/VERIFY.md`

The skill mirrors the structure of `/add-gmail-tool` and `/add-gcal-tool`. It is documentation only — the trunk changes (Tasks 1–5) make the runtime support intrinsic; the skill exists to (a) verify OneCLI prerequisites, (b) wire per-group `container.json`, (c) restart, (d) verify, (e) document removal.

- [ ] **Step 1: Write `SKILL.md`**

Create `.claude/skills/add-linear-tool/SKILL.md` with the exact content below.

```markdown
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
OneCLI is the sole credential path. The container.json header `Authorization: Bearer ${LINEAR_API_KEY}`
where `LINEAR_API_KEY=onecli-managed` produces a stub bearer; the gateway swaps it
with the real token in flight.

This skill is distinct from `/add-linear`, which installs the inbound channel adapter
(Linear webhook → agent). The two can coexist on one install.

## Phase 1: Pre-flight

### Verify the trunk supports HTTP MCP servers

```bash
grep -q "type: 'http'" container/agent-runner/src/providers/types.ts && echo "TRUNK READY" || echo "TRUNK BEHIND — run /update-nanoclaw first"
```

If the output is `TRUNK BEHIND`, stop and tell the user to run `/update-nanoclaw` so
the McpServerConfig discriminated union (which this skill depends on) is in place.

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

After editing, optionally update the group's `CLAUDE.md` (or its
`.claude-fragments/<topic>.md`) to mention the new tool surface. Example bullet:

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
```

- [ ] **Step 2: Write `REMOVE.md`**

Create `.claude/skills/add-linear-tool/REMOVE.md`:

```markdown
# Remove add-linear-tool

See the **Removal** section in `SKILL.md`. The trunk-side McpServerConfig union and
the `mcp__linear__*` allowlist entry are not removed — they support any future HTTP
MCP server.
```

- [ ] **Step 3: Write `VERIFY.md`**

Create `.claude/skills/add-linear-tool/VERIFY.md`:

```markdown
# Verify add-linear-tool

```bash
grep -q '"linear"' groups/*/container.json && \
  grep -q "'mcp__linear__\\*'" container/agent-runner/src/providers/claude.ts && \
  echo "WIRED" || echo "NOT WIRED"
```
```

- [ ] **Step 4: Lint the skill files (sanity check)**

Run: `head -1 .claude/skills/add-linear-tool/SKILL.md`
Expected: `---` (frontmatter starts correctly).

Run: `grep -c '^##' .claude/skills/add-linear-tool/SKILL.md`
Expected: a positive integer (the file has section headings).

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/add-linear-tool/
git commit -m "feat(skill): /add-linear-tool — wire Linear hosted MCP per group

Mirrors /add-gmail-tool / /add-gcal-tool. Pre-flight checks OneCLI Linear
connection, applies idempotent per-group container.json edits, restarts.
Distinct from the existing /add-linear channel skill.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Apply the skill to the local install

**Files:**
- Modify: `groups/slack_main/container.json`
- Modify: `groups/cli-with-leeor/container.json` (the global / CLI agent group)
- Possibly modify: per-group `CLAUDE.md` text mentioning the old `linear_*` tool names

Memory feedback: tools must be added to both `slack_main` AND the global agent group.

- [ ] **Step 1: Verify OneCLI is healthy and Linear is reachable**

Run: `onecli apps get --provider linear`
Expected: connected, or — if Linear isn't an OneCLI provider on this version — fall
back to a raw `LINEAR_API_KEY` in the per-group config. Decide with the user.

Run: `onecli agents list`
Expected: shows agent IDs for `ag-e800c54bae9a` (slack_main) and the global agent
group.

- [ ] **Step 2: Edit `groups/slack_main/container.json`**

Read the current file. Add `env.LINEAR_API_KEY` and `mcpServers.linear`. Preserve all
other fields.

```bash
node - <<'EOF'
const fs = require('fs');
const path = 'groups/slack_main/container.json';
const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
cfg.env = { ...(cfg.env || {}), LINEAR_API_KEY: 'onecli-managed' };
cfg.mcpServers = {
  ...(cfg.mcpServers || {}),
  linear: {
    type: 'http',
    url: 'https://mcp.linear.app/mcp',
    headers: { Authorization: 'Bearer ${LINEAR_API_KEY}' },
  },
};
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
EOF
```

- [ ] **Step 3: Edit `groups/cli-with-leeor/container.json`** (or whichever folder is the global agent group)

Verify which folder is the "global" group:

```bash
ls groups/ && grep -l '"agentGroupId"' groups/*/container.json | xargs grep -l 'global\|cli\|main'
```

Apply the same edit. Repeat the script above with the correct path.

- [ ] **Step 4: If the group's `CLAUDE.md` documents `linear_*` tool names, update**

```bash
grep -rn "linear_create_issue\|linear_update_issue\|linear_get_issue\|linear_list_issues\|linear_comment_on_issue" groups/ | head
```

For each match, replace the old name with the equivalent `mcp__linear__*` family or
delete the specific reference. Keep the change minimal.

- [ ] **Step 5: Re-build host and restart the service**

Run: `pnpm run build`
Expected: clean.

Run: `systemctl --user restart nanoclaw`
Expected: clean restart. Tail logs to confirm:

```bash
tail -50 logs/nanoclaw.log
```

Look for `[container-runner] mcpServers configured: ... linear` (or similar
log line; verify the exact wording from container-runner.ts at apply time).

- [ ] **Step 6: Manual verify from a real agent message**

Send a Slack message to the `slack_main` agent: "List my Linear teams." Confirm the
agent calls `mcp__linear__list_teams` (visible in `data/v2-sessions/<sid>/stderr.log`)
and replies with at least one team name.

If `401 Unauthorized` shows up, run the troubleshooting steps in the skill's Verify
section.

- [ ] **Step 7: Commit (only if local verify succeeded)**

```bash
git add groups/slack_main/container.json groups/cli-with-leeor/container.json
# If CLAUDE.md / fragments changed, add those too
git commit -m "chore(groups): wire Linear hosted MCP into slack_main + global

Per-group container.json points at https://mcp.linear.app/mcp with the
OneCLI-managed bearer header. Replaces the dropped custom GraphQL
wrapper.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Final sanity sweep

**Files:** none modified — verification only.

- [ ] **Step 1: All builds and tests pass on a clean working tree**

Run: `git status` — should show no uncommitted changes.
Run: `pnpm run build && pnpm test`
Run: `cd container/agent-runner && bun run typecheck && bun test`
Run: `./container/build.sh`

- [ ] **Step 2: No stray references to the old wrapper**

Run: `grep -rn "linear_create_issue\|linear_update_issue\|linear_get_issue\|linear_list_issues\|linear_comment_on_issue\|from './linear.js'" container/ src/ groups/ .claude/`
Expected: empty.

If matches remain, decide whether to update them or accept the divergence (e.g. an
old conversation transcript shouldn't be rewritten).

- [ ] **Step 3: No commit (verification step)**

Done.

---

## Self-Review Notes

- **Spec coverage:** every numbered Component in the spec has at least one Task.
  - Type extension (Component 1) → Tasks 1, 2.
  - Drop wrapper (Component 2) → Task 4.
  - Allowlist (Component 3) → Task 3.
  - Host passthrough (Component 4) → verified inline at Task 2 / Task 5.
  - Per-group config (Component 5) → Task 7.
  - OneCLI prereqs (Component 6) → Task 7 Step 1; documented in skill Phase 1.
  - New skill (Component 7) → Task 6.
- **Placeholders:** none. All steps include exact commands or full code.
- **Type consistency:** `McpServerConfig` is defined identically on host and
  container (Tasks 1 & 2 mirror the same union shape).
- **Risks acknowledged in the spec are surfaced in the skill's Phase 4 troubleshooting.**
