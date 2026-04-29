# PR: `skill/add-backoffice-tool`

## Summary

Adds the `add-backoffice-tool` skill: glue that wires an operator-supplied backoffice OpenAPI MCP server into agent containers when both `BO_API_URL` and `BO_AUTH_TOKEN` are present in the container env **and** the MCP package is bind-mounted at `/opt/backoffice-mcp/dist/index.js`. Same gate guards the `mcp__backoffice__*` tool allowlist entry. Secrets are scrubbed from `process.env` after the MCP server is configured so the agent cannot read them via Bash.

The MCP package itself stays operator-private — never bundled in this skill.

## Branches

Two branches were created in worktree `/home/leeor/repos/nanoclaw-v2-backoffice`:

| Branch | Purpose | HEAD |
|---|---|---|
| `skill/add-backoffice-tool` | Code changes (the skill payload) | `6838ae94f79d` |
| `skill-meta/add-backoffice-tool` | SKILL.md only, off `origin/main` (since `main` is checked out in another worktree and could not be switched into here) | `143e526f3e7d` |

Per the brief, the SKILL.md "goes on `main`". Since `main` was claimed by sibling worktree `/home/leeor/repos/nanoclaw-v2-slack-mcp`, it was committed to `skill-meta/add-backoffice-tool` (off `origin/main`) for fast-forward merge into `main` from a worktree that owns it.

## Files changed

### `skill/add-backoffice-tool` (3 commits, 4 files, +47/-1)

```
 container/Dockerfile                           |  7 ++++++
 container/agent-runner/src/index.ts            | 31 ++++++++++++++++++++++++++
 container/agent-runner/src/providers/claude.ts |  4 +++-
 container/agent-runner/src/providers/types.ts  |  6 +++++
 4 files changed, 47 insertions(+), 1 deletion(-)
```

Commits (oldest first):

1. `1f177d3f48a5` — `feat(agent-runner): add additionalAllowedTools provider option`
   - Extends `ProviderOptions` with `additionalAllowedTools?: string[]`; `ClaudeProvider` appends it to the SDK `allowedTools`. Empty default keeps existing behavior.
2. `a654af5b1407` — `feat(agent-runner): wire backoffice MCP server when env + mount present`
   - In `container/agent-runner/src/index.ts`: registers a `backoffice` MCP server when `BO_API_URL && BO_AUTH_TOKEN && fs.existsSync('/opt/backoffice-mcp/dist/index.js')`. Adds `mcp__backoffice__*` to the per-provider extra allowlist. Deletes both BO env vars from `process.env` after the MCP config captures them, before snapshotting `process.env` for the provider.
3. `6838ae94f79d` — `docs(container): note operator-supplied backoffice MCP bind mount`
   - Comment block in `container/Dockerfile` documenting the `/opt/backoffice-mcp` bind-mount convention. No build behavior change.

### `skill-meta/add-backoffice-tool` (1 commit, 1 file, +181)

- `143e526f3e7d` — `docs(skills): add add-backoffice-tool SKILL.md`
- New file: `.claude/skills/add-backoffice-tool/SKILL.md`

## Why this design

- **Two-side gate**: env vars + package presence. The skill is safe to merge globally; agent groups opt in by adding the bind mount and credentials.
- **Secret scrub**: matches v1's `776d6e7c` defense-in-depth — MCP server gets the values via its explicit `env:` block (captured before the `delete`), agent's Bash sees nothing.
- **Tool allowlist plumbing**: rather than special-casing `mcp__backoffice__*` inside `claude.ts`, added a generic `additionalAllowedTools` provider option. Future skills that wire optional MCP servers can use the same hook without re-editing the provider.
- **No package bundling**: per brief — operator-private. Mount path `/opt/backoffice-mcp/dist/index.js` matches v1 for compatibility.

## Test results

Run from `/home/leeor/repos/nanoclaw-v2-backoffice` on `skill/add-backoffice-tool`:

```
$ pnpm run build
> nanoclaw@2.0.14 build
> tsc
(clean — no errors)

$ pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
TypeScript: No errors found

$ pnpm test
 Test Files  23 passed (23)
      Tests  197 passed (197)
   Duration  1.73s
```

Tests verified clean across 3 consecutive runs. (Bun container tests not run — `bun` is not installed in this environment; brief only required `pnpm run build` and `pnpm test`.)

`./container/build.sh` was not executed (Docker not available in this sandbox), but the only Dockerfile change is a comment block — no build-graph impact. The agent-runner source changes are picked up by the bun runtime at container start (no in-image tsc).

## Verify (quick recipe for the operator)

```bash
grep "fs.existsSync('/opt/backoffice-mcp/dist/index.js')" container/agent-runner/src/index.ts
grep "delete process.env.BO_API_URL"                       container/agent-runner/src/index.ts
grep "mcp__backoffice__\*"                                  container/agent-runner/src/index.ts
```

All three should match.

## Push commands

Not pushed per instructions. To publish:

```bash
# From any worktree of the repo:
git push -u origin skill/add-backoffice-tool

# To get the SKILL.md onto main, in a worktree that owns main:
cd /home/leeor/repos/nanoclaw-v2-slack-mcp        # or wherever main lives
git fetch /home/leeor/repos/nanoclaw-v2-backoffice skill-meta/add-backoffice-tool
git merge --ff-only FETCH_HEAD                    # fast-forwards main by one commit
git push origin main

# Alternative: cherry-pick the single SKILL.md commit onto main
git cherry-pick 143e526f3e7d

# Then delete the meta branch (it was a workaround for the worktree lock):
git -C /home/leeor/repos/nanoclaw-v2-backoffice branch -D skill-meta/add-backoffice-tool
```

## Constraints honored

- v1 (`~/repos/nanoclaw`) was not modified.
- No remote pushes.
- No PR opened.
- Backoffice MCP package not bundled.
- Env-var scrub matches v1 `776d6e7c` pattern.
- Tool prefix gated on the same env-var presence check.

## Done criteria

- [x] Branch `skill/add-backoffice-tool` exists with code changes.
- [x] Dockerfile comment added (no real change).
- [x] `container/agent-runner/src/index.ts` patched: gate, env scrub, tool prefix.
- [x] `.claude/skills/add-backoffice-tool/SKILL.md` written (on `skill-meta/add-backoffice-tool`, ready to merge to `main`).
- [x] `pnpm run build` clean.
- [x] `pnpm test` clean (23 files / 197 tests).
- [x] Container typecheck clean (`pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`).
- [x] OUT doc written.
- [ ] Branch pushed (intentionally skipped per instructions).
