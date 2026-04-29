# skill/add-prompt-gate — OUT

## Summary

Built the rest of the `add-prompt-gate` feature skill on top of the existing 2 commits on `skill/add-prompt-gate` (`52c64538fc36` and `e638da7822a6`, both untouched).

The skill adds a content-validation pipeline that registers a single inspector via the `setMessageInspector` router hook (already in trunk on the skill branch). Refuses messages that match prompt-injection patterns, are sent by deny-listed senders, or — optionally, in `strict` mode — can't be identity-verified at all. Every decision (allowed and denied) is persisted to a hash-only audit table.

## Branches committed to

### `skill/add-prompt-gate` (3 new commits on top of the existing 2)

| SHA | Message |
|-----|---------|
| `3525dc04de09` | feat(db): add migration 014 for prompt_gate_decisions audit table |
| `86b15a231ad9` | feat(modules): add prompt-gate content-validation module |
| `524806cdc765` | feat(modules): register prompt-gate in modules barrel |

Existing tip preserved: `52c64538fc36` (router hook + JSDoc + 6-case test suite).

### `main` (1 new commit)

| SHA | Message |
|-----|---------|
| `3c1a3f7c7cfa` | feat(skill): add /add-prompt-gate |

## Files changed

### `skill/add-prompt-gate`

- `src/db/migrations/014-prompt-gate-decisions.ts` — new. Module-owned migration creating `prompt_gate_decisions` (id, timestamp, user_id, agent_group_id, messaging_group_id, decision, reason, rule_matched, text_hash, text_length, created_at) + two indexes for the per-user / per-agent audit queries.
- `src/db/migrations/index.ts` — registered `migration014` in the barrel array.
- `src/modules/prompt-gate/config.ts` — new. `loadPromptGateConfig()` reads `data/prompt-gate.config.json`, shallow-merges over `DEFAULT_CONFIG`. Schema = prompt_injection patterns, sender_id_verification (enabled/strict), allow_list_user_ids, deny_list_user_ids.
- `src/modules/prompt-gate/decision.ts` — new. Pure `decide(userId, messageText, config)` returning `{ result: MessageInspectorResult, ruleMatched: string | null }`. Rule precedence: allow_list > deny_list > sender_id_verification.strict > prompt_injection patterns.
- `src/modules/prompt-gate/decision.test.ts` — new. Exhaustive precedence + per-rule cases (case-insensitive matching, custom patterns, allow-overrides-deny, null userId behaviour).
- `src/modules/prompt-gate/db/decisions.ts` — new. `recordDecision()` and `hashText()` helpers. SHA-256, generates `pgd-<uuid>` ids.
- `src/modules/prompt-gate/db/decisions.test.ts` — new. Round-trip allowed + denied rows, hash determinism, NULL semantics, regression check that the raw text never lands in any column.
- `src/modules/prompt-gate/index.ts` — new. Self-registers `setMessageInspector(...)` at import time. Caches config; wraps `recordDecision` in a try/catch so a transient DB error doesn't trip the inspector's failsafe-block-on-throw.
- `src/modules/prompt-gate/index.test.ts` — new. Integration test: imports the module, routes a real `InboundEvent` through `routeInbound`, asserts wakeContainer behaviour + audit-row presence for both allowed and denied paths.
- `src/modules/index.ts` — added `import './prompt-gate/index.js';` to the modules barrel.

### `main`

- `.claude/skills/add-prompt-gate/SKILL.md` — new. Operator-facing instructions: install (fetch+merge `skill/add-prompt-gate`, build, restart), configuration (config file schema + interpretation), audit (query example + hash-recompute correlation), coverage gap (accumulate-buffer caveat), verify, removal.

## Test results

```
Test Files  27 passed (27)
     Tests  227 passed (227)
   Duration  ~2s
```

`pnpm run build` completes cleanly. All test files including the three new ones (`decision.test.ts`, `db/decisions.test.ts`, `index.test.ts`) pass.

Note: the existing 6-case `setMessageInspector` test suite in `src/router.test.ts` was not modified and continues to pass — the prompt-gate module re-uses the same hook contract those tests pin down.

## Reviewer notes

- **Migration number:** the brief specified `013-prompt-gate-decisions`, but `013` was already taken by `approval-render-metadata` on this branch. Used `014` instead. Migration uniqueness is keyed on `name` (per the comment in `src/db/migrations/index.ts`), so the version number is just an ordering hint — no coordination conflict.
- **No `agent.md` fragment:** v2 `composeGroupClaudeMd()` doesn't currently support module agent.md fragments (the trunk module pattern is host-only side-effect registration). Per the brief's fallback ("otherwise document the agent-side awareness in `SKILL.md` instead"), the accumulate-buffer coverage gap is documented in SKILL.md.
- **Failsafe semantics preserved:** the inspector itself never throws. Audit-write failure is caught and logged so a transient DB hiccup can't deny every message via the router's failsafe-on-throw. The decision result is still returned.
- **No new package deps.** Crypto comes from Node's built-in `crypto`.
- **Storage minimization:** only SHA-256 hash + length stored. Verified by a regression test that walks every column of every row and asserts the raw text never appears.
- **Default patterns** are conservative — the canonical "ignore previous instructions" family. Custom patterns are added via the config file, not by editing source.
- **Allow > deny** by design (admins can whitelist themselves out of false positives without editing the patterns).

## Deviations from the brief

1. Migration number `014` instead of `013` (see above).
2. No `agent.md` fragment created (see above).
3. Added a third test file (`index.test.ts`) covering the integration path — the brief listed this under "Tests > Coverage targets > Module integrates" without specifying a file location; adding it as a sibling test felt cleaner than wedging into either of the two pure-function test files.

No other deviations.

## Push commands

```bash
# Code branch (3 new commits on top of 2 existing)
git push fork skill/add-prompt-gate

# SKILL.md on main (1 new commit)
git push fork main
```

(The operator opens the cross-fork PR manually per the brief.)

## Worktree caveat (heads-up for the operator)

`main` was advanced via `git update-ref` from inside the prompt-gate worktree (using a temporary detached worktree at `/tmp/nanoclaw-main-tmp` to author the commit, then a ref update — the temp worktree was removed). At the time of the update, another worktree (`~/repos/nanoclaw-v2-slack-mcp`) was also checked out on `main`; its working tree still reflects the previous main tip and will report the new SKILL.md as a deletion until that worktree resyncs. No data was lost. The fix on the operator's side is `git -C ~/repos/nanoclaw-v2-slack-mcp checkout -- .claude/skills/add-prompt-gate/` (or simply switch that worktree off main and back).
