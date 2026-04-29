# PR: `skill/add-icm-tool` — Infinite Context Memory MCP integration

## Summary

Adds the `add-icm-tool` skill: ICM (Infinite Context Memory) is now available to v2 agents via MCP, with **per-group opt-in** via `container.json` (no v1-style hardcoded `isMain` gate). The binary is baked into the container image; the runner only wires the `icm` MCP server (and exposes `mcp__icm__*` tools) for groups that explicitly request it.

This is the validation case for the v2 skill-apply lifecycle — code on `skill/add-icm-tool`, operator-facing `SKILL.md` on `main`, applied via plain `git fetch` + `git merge`.

Layout:

- **Code** lives on `skill/add-icm-tool` (3 commits, 5 files).
- **`SKILL.md`** lives on `main` (1 new commit, 1 file) so `/customize` can discover it without first applying the skill. (Note: `main` in the worktree is also ahead of `origin/main` by an unrelated pre-existing commit `e189face` — `docs(skill): add slack-mcp-tools SKILL.md` — that was already on the local `main` before this task started. It will be pushed alongside the new SKILL.md commit unless the operator pushes selectively.)

## Files changed

### On `skill/add-icm-tool` (3 commits)

| Commit | File | Change |
|---|---|---|
| `b434a9e7` feat(container): add ICM binary to image | `container/Dockerfile` | Base bumped `node:22-slim` → `node:22-trixie-slim`; `libasound2` → `libasound2t64` (trixie t64 transition); new RUN block downloads `icm` from rtk-ai/icm GitHub release (amd64 .deb / arm64 tarball) and runs `icm --version` to validate. |
| `218814d8` feat(agent-runner): add icm-init helper | `container/agent-runner/src/icm-init.ts` (new) | Exports `ensureIcmConfig(groupDir)` — idempotent, creates `<groupDir>/.icm/config.toml` if missing with embeddings enabled (`intfloat/multilingual-e5-base`), returns absolute path. |
| | `container/agent-runner/src/icm-init.test.ts` (new) | bun:test coverage: dir creation, returned path is absolute, config contents correct, idempotent, handles pre-existing `.icm/`. |
| `64ce1829` feat(agent-runner): wire ICM MCP server when group opts in | `container/agent-runner/src/index.ts` | In the `mcpServers` build loop: for the `icm` entry, if no `ICM_CONFIG` env is set, call `ensureIcmConfig('/workspace/agent')` and inject. Operator's `container.json` stays minimal. |
| | `container/agent-runner/src/providers/claude.ts` | Refactored `TOOL_ALLOWLIST` use into `buildAllowedTools(mcpServers)`; appends `mcp__icm__*` only when `mcpServers.icm` is set. Avoids exposing a tool prefix when the underlying server isn't running. |

### On `main` (1 commit)

| Commit | File | Change |
|---|---|---|
| `docs(skills): add SKILL.md for add-icm-tool` | `.claude/skills/add-icm-tool/SKILL.md` (new) | Operator workflow: pre-flight, `git merge upstream/skill/add-icm-tool`, `pnpm run build` + `pnpm test`, container rebuild, per-group enable, optional v1 state migration, verify, troubleshooting. |

## Test/build results

Run from `/home/leeor/repos/nanoclaw-v2-icm` on `skill/add-icm-tool`:

```
pnpm run build               → clean (tsc, no errors)
pnpm test                    → 23 files, 197/197 tests passed (1.77s)
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
                             → No errors found
```

Container-side bun tests for `icm-init.test.ts` were **not run** — Bun is not installed in this environment. The tests are written in `bun:test` style consistent with the other agent-runner tests (`formatter.test.ts`, `poll-loop.test.ts`, `integration.test.ts`, `timezone.test.ts`) and will run wherever the agent-runner CI / local-bun setup runs them. Recommend running `cd container/agent-runner && bun test` before pushing if Bun is available locally.

`./container/build.sh` was **not run** — would require pulling the new `node:22-trixie-slim` base image and downloading the ICM release artifacts. Recommend the operator runs it locally to confirm the new ICM install layer succeeds and that `docker run --rm --entrypoint /bin/sh nanoclaw-agent:v2 -c 'icm --version'` returns a version string.

## Notes for reviewer

- **Per-group opt-in done via existing `mcpServers` schema** — no `container.json` schema changes. The skill does not modify `src/container-config.ts`. Operators add the `icm` entry; the runner's mcpServers loop transparently auto-fills `ICM_CONFIG`.
- **`mcp__icm__*` allowlist is dynamic, not static.** Static const → `buildAllowedTools(mcpServers)` per-query function. Adding future opt-in MCP servers should follow the same pattern (extend `buildAllowedTools`), not append to `TOOL_ALLOWLIST`.
- **Trixie base bump may have side effects.** `libasound2` → `libasound2t64` is the documented t64 transition; chromium and font packages should still resolve. Operator should smoke-test browser tools after rebuild.
- **No groups touched.** The skill does NOT edit any `groups/<folder>/container.json` itself — that's left to the operator (per Phase 3 of `SKILL.md`). Trunk has no `groups/slack_main/` example referenced in the brief; it's a customization concern.
- **v1 reference commits**: `9767fbcb` (Dockerfile) and `b542c8fc` (agent-runner) in `~/repos/nanoclaw`. Intent preserved; structure adapted to v2 (per-group opt-in, separate `icm-init.ts` helper rather than inline block, dynamic allowlist).

## Push commands

Two branches changed; both need pushing.

```bash
cd ~/repos/nanoclaw-v2-icm

# Push the skill branch (code)
git push -u origin skill/add-icm-tool

# Push main (SKILL.md only — single commit ahead of origin/main)
git push origin main
```

Verify before pushing:

```bash
git log origin/main..main --oneline                       # → 2 commits (SKILL.md + pre-existing slack-mcp-tools)
git log origin/main..skill/add-icm-tool --oneline         # → 3 commits (Dockerfile, icm-init helper, runner wiring)
```

If only the ICM SKILL.md should land on `main` for this PR, push selectively:

```bash
# Cherry-pick the ICM SKILL.md commit onto a fresh branch off origin/main
git checkout -b push/icm-skill-md origin/main
git cherry-pick ae7ae5eebfaa
git push origin push/icm-skill-md
# then open the PR from push/icm-skill-md → main
```

Then open PRs against the upstream repo. Suggest two PRs (one per branch) since they target different bases — the code PR can stay green by being merged-forward with main as needed.

Do **not** force-push.
