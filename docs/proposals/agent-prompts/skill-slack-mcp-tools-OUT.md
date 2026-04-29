# PR: `skill/slack-mcp-tools`

## Summary

Adds a fork-skill that gives container-side agents a Slack tool kit (read channels/threads, search, user profile, canvas, file send) by wiring the upstream `slack-mcp-server` package as an MCP server. Distinct from `/add-slack`, which ships only the channel adapter (host-side, inbound/outbound messages). When `SLACK_BOT_TOKEN` is in the container env the runner registers `slack-mcp-server@latest` (fetched via `npx -y`), exposes `mcp__slack__*` to the agent, and scrubs the raw token from `process.env` so it can't be read via Bash.

Implementation mirrors the v1 pattern (commit `776d6e7c`) adapted to v2's reorganized agent-runner: Slack wiring happens in `container/agent-runner/src/index.ts` next to the rest of the per-spawn MCP setup, and the allowed-tool list is extended through a new `extraAllowedTools` field on `ProviderOptions` so the static `TOOL_ALLOWLIST` in `claude.ts` stays declarative and other providers can opt in the same way.

## Branches

- **`skill/slack-mcp-tools`** — code commit (agent-runner wiring + provider option). 1 commit.
  - `eb91c03ce39b` `feat(agent-runner): wire Slack MCP read tools when SLACK_BOT_TOKEN is present`
- **`main`** — operator-facing skill docs. 1 commit.
  - `e189face407c` `docs(skill): add slack-mcp-tools SKILL.md`

## Files changed

### On `skill/slack-mcp-tools`

| File | Change |
|---|---|
| `container/agent-runner/src/index.ts` | Conditionally add `slack` to `mcpServers` (cmd `npx -y slack-mcp-server@latest`, env `SLACK_MCP_XOXB_TOKEN`); push `mcp__slack__*` onto `extraAllowedTools`; `delete process.env.SLACK_BOT_TOKEN` after wiring; log `Slack MCP server enabled (SLACK_BOT_TOKEN present)`. |
| `container/agent-runner/src/providers/types.ts` | Add `extraAllowedTools?: string[]` to `ProviderOptions` with comment. |
| `container/agent-runner/src/providers/claude.ts` | Concatenate `options.extraAllowedTools` onto `TOOL_ALLOWLIST` at construction; pass to SDK as `allowedTools`. |

### On `main`

| File | Change |
|---|---|
| `.claude/skills/slack-mcp-tools/SKILL.md` | New. Operator-facing install: prerequisites (depends on `/add-slack`), required Slack OAuth bot scopes (`search:read`, `files:write`, `canvases:read`, `canvases:write`), idempotent pre-flight, `git fetch origin skill/slack-mcp-tools` + cherry-pick, token-passthrough notes (`.env` vs OneCLI vault), build + restart, verification (env grep, runner log, end-to-end smoke from a Slack DM). |
| `.claude/skills/slack-mcp-tools/VERIFY.md` | New. Three `grep` commands operators can run to check the patch is applied. |

## Test results

```
pnpm run build           # tsc clean (host)
pnpm test                # 23 files / 197 tests passed
```

Run multiple times on both `skill/slack-mcp-tools` and `main` (post-commit). Both build clean and all 197 host tests pass.

Note on flakiness: occasional pre-existing parallel-test flakiness was observed in the permissions/channel registration tests (also reproducible on plain `main` without these changes — sporadic, not consistent). It is not caused by this skill. No new test was added — the skill is gated config in agent-runner, and the brief explicitly marks tests optional. The container test suite (`bun test`) was not run in this environment because `bun` is not installed here; the typecheck `tsc -p container/agent-runner/tsconfig.json --noEmit` from the repo root passes (skip-lib-check, types resolved).

`./container/build.sh` was not run in this environment (no Docker/Apple Container available on this host); it is documented in the SKILL.md as a required step for the operator.

## Push commands

Code branch:

```bash
git -C /home/leeor/repos/nanoclaw-v2-slack-mcp push -u origin skill/slack-mcp-tools
```

SKILL docs (commit on `main`) — typically goes through normal upstream PR review rather than a direct push, but if pushing main directly:

```bash
git -C /home/leeor/repos/nanoclaw-v2-slack-mcp push origin main
```

(Per task instructions, no push was performed by the agent.)

## Notes for review

- **Choice of `extraAllowedTools` vs editing `TOOL_ALLOWLIST` directly.** v1 inlined `mcp__slack__*` directly in the allowed-tools array next to the per-call MCP server build. v2 has split provider config into a typed `ProviderOptions` shape and moved the static allowlist into `claude.ts`. Adding the prefix dynamically through a new option keeps the static list declarative and preserves the option pattern other skills (and other providers) can reuse — e.g. a future Linear MCP skill or per-group toggle would do `extraAllowedTools.push('mcp__linear__*')` in the same `index.ts` block. If reviewers prefer the v1-style inline addition, the change would simplify to a 1-line literal in `TOOL_ALLOWLIST`.
- **No new repo dependency.** `slack-mcp-server` is fetched at runtime by `npx -y`, matching v1 and avoiding both `package.json`/`bun.lock` churn and the `minimumReleaseAge` policy. First-wake cost is a single npm pull; subsequent wakes hit the npm cache.
- **Token scrub.** `delete process.env.SLACK_BOT_TOKEN` runs immediately after the MCP server entry is built. The MCP server's own env is captured at `mcpServers.slack.env = { SLACK_MCP_XOXB_TOKEN: process.env.SLACK_BOT_TOKEN }` before the delete, so the scrub doesn't break the server — it only blinds the agent's Bash tool to the raw token.
- **Distinct from `/add-slack`** — explicitly documented in SKILL.md so operators understand they need both: `/add-slack` for inbound/outbound messages, `slack-mcp-tools` for proactive read access.
- **Outcome path.** The brief calls out this is likely upstream-mergeable as a core extension of `/add-slack`. Built as a fork-skill on `skill/slack-mcp-tools` per the brief; operator decides upstream-PR vs keep-fork after review.
