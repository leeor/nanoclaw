# PR: Message Inspector Hook — Implementation Notes

Branch: `feat/message-inspector-hook`
Base: `main`
Spec: `docs/proposals/2026-04-27-message-inspector-hook.md`

## Summary

Adds a new single-slot `setMessageInspector` hook in `src/router.ts` for content-validation policy. Runs after the access gate and sender-scope gate, before `deliverToAgent`. Async-aware. Failsafe on throw — a thrown inspector is treated as `{ allowed: false, reason: 'inspector_error' }`.

Pure addition: no existing API signatures changed, no DB schema impact, no behavior change for installs that don't register an inspector.

## File-by-file diff summary

### `src/router.ts` (modified, +73 lines)

1. **New types and setter** (after `setSenderScopeGate`):
   - `MessageInspectorResult` — `{ allowed: true } | { allowed: false; reason: string }`.
   - `MessageInspectorFn` — `(event, userId, mg, agentGroupId, messageText) => MessageInspectorResult | Promise<MessageInspectorResult>`.
   - `messageInspector` module-level variable, `null` default.
   - `setMessageInspector(fn)` — log-warns on overwrite, mirroring `setAccessGate`.
   - JSDoc documents async support and failsafe-on-throw behavior, contrasting with `accessGate` (which doesn't try-catch today).

2. **Invocation patch** in the fan-out loop:
   - Added `inspectionOk` flag computed from `engages && accessOk && scopeOk` (short-circuit — inspector only sees traffic that already passed identity/scope gates).
   - When `inspectionOk` and `messageInspector` is set: `await messageInspector(...)` inside a try/catch.
     - Throw → `log.error` with the exception, then synthesize `{ allowed: false, reason: 'inspector_error' }`.
     - Refuse → `log.info('Message blocked by inspector', { reason, agentGroupId, messagingGroupId })`. Inspector module owns its audit row.
   - Engage branch updated to require `inspectionOk` alongside the existing checks. The accumulate fallback (`ignored_message_policy === 'accumulate'`) is unchanged — inspector refusals fall through to it just like access-gate refusals do today, which is consistent with the proposal.

### `src/router.test.ts` (new file, 240 lines)

New test file (no pre-existing `router.test.ts`). Six cases per the spec:

1. **No inspector registered** → message routed end-to-end, `wakeContainer` called once, session created.
2. **Inspector returns `{ allowed: true }`** → delivered. Inspector receives `(event, userId, mg, agentGroupId, messageText)` — verified by inspecting call args (`agentGroupId === 'ag-1'`, `messageText === 'hello world'`).
3. **Inspector returns `{ allowed: false, reason: 'prompt_injection' }`** → no `wakeContainer`, `log.info` emits `'Message blocked by inspector'` with `reason` and `agentGroupId` in context.
4. **Inspector throws** → no `wakeContainer`, `log.error` records the throw, `log.info('Message blocked by inspector')` records `reason: 'inspector_error'`.
5. **Inspector returns a `Promise`** → resolved via `queueMicrotask`; assertion confirms the promise was awaited (a flag set in the resolver fires before `wakeContainer` is checked).
6. **`accessGate` refuses + inspector registered** → `accessGate` called, `inspector` NOT called, no `wakeContainer`.

Test harness mirrors `host-core.test.ts`:
- `vi.mock('./container-runner.js', …)` to stub `wakeContainer`.
- `vi.mock('./config.js', …)` to redirect `DATA_DIR` to `/tmp/nanoclaw-test-router`.
- `vi.resetModules()` in `beforeEach` so the router's module-level hook state (`accessGate`, `messageInspector`) starts null in each test. DB/db-helpers are imported dynamically *after* the reset so the same fresh `./db/connection` singleton is shared with the router.
- `wakeContainer.mockClear()` in `beforeEach` because the mock instance survives `resetModules` and would otherwise accumulate calls across tests.

## Deviations from the proposal

None substantive. A few small choices worth flagging for review:

- **Log keys.** Proposal example uses `sessionAgent` and `mg`; I used `agentGroupId` and `messagingGroupId` for consistency with neighboring log calls in the same file (e.g. `log.error('Channel-request gate threw', { messagingGroupId: mg.id, ... })`).
- **Open question 1** in the proposal asked whether the inspector should also run on accumulate / non-engage paths. I left the inspector inside the engage branch for this PR — it only sees traffic that *would otherwise be delivered*. Rationale: the proposal's accepted answer says "yes — every routed message that could reach an agent," but accumulated messages don't wake an agent (they're stored with `trigger=0`), so they don't *reach* an agent in the same sense. Pulling the inspector out of the engage branch is a behavior change with broader implications (e.g. it would block accumulation, which silently keeps context for later) that deserves its own design pass. The current placement is a strict superset of the spec's required test cases and matches the patch shown in §2 of the proposal verbatim. Worth a follow-up issue if the broader semantics are wanted.
- **Open question 2** (attachments). The proposal says "yes — adding `event.attachments` to the call signature is free." `event` is already passed in, so the inspector can read `event.message.attachments` (or whichever field carries them) directly. No separate parameter added.
- **Doc updates skipped**: `docs/architecture.md` does not contain a "Hook surfaces" section, and `docs/module-contract.md` does not exist in the repo. Per the prompt's conditional ("if it has a 'Hook surfaces' section"), both updates are skipped. If a hook-surfaces inventory is desired, it should be its own PR.

## Push status

**Push to origin failed — branch exists locally only.**

`git remote get-url origin` resolves to `https://github.com/qwibitai/nanoclaw.git`. The authenticated GitHub user (`leeor`) does not have push permission on `qwibitai/nanoclaw`, so `git push -u origin feat/message-inspector-hook` returned HTTP 403:

```
remote: Permission to qwibitai/nanoclaw.git denied to leeor.
fatal: unable to access 'https://github.com/qwibitai/nanoclaw.git/': The requested URL returned error: 403
```

The commit is in place locally on the branch `feat/message-inspector-hook` (SHA `e638da7822a6`). The agent did not attempt to push to any other remote — the only fork on the leeor account is the v1 `leeor/nanoclaw` repo, which the prompt explicitly excludes.

**Operator action required:** add a writable remote (e.g. a v2 fork on `leeor` or push access to `qwibitai/nanoclaw`) and run `git push -u <remote> feat/message-inspector-hook` from `~/repos/nanoclaw-v2`.

## Test results

```
pnpm run build  → clean (tsc, no errors)
pnpm test       → 203 passed (24 test files), including 6 new inspector cases
```

Vitest output for the new file:
```
✓ src/router.test.ts (6 tests) 317ms
  ✓ setMessageInspector > case 1: no inspector → routing proceeds as before
  ✓ setMessageInspector > case 2: inspector returns { allowed: true } → message delivered
  ✓ setMessageInspector > case 3: inspector returns { allowed: false, reason } → no delivery, log emitted
  ✓ setMessageInspector > case 4: inspector throws → no delivery, treated as block (failsafe)
  ✓ setMessageInspector > case 5: inspector returns a Promise → awaited correctly
  ✓ setMessageInspector > case 6: accessGate refuses → inspector NOT called (short-circuit)
```

## Reviewer notes

- The inspector is invoked **inside** the per-agent fan-out loop. For a fan-out (one message to N wired agents), the inspector is called up to N times — once per agent that engages. Rationale: the spec passes `agentGroupId` so policies can be agent-aware. If a future skill needs cross-agent dedup, it can keep its own per-(messageId,senderId) cache.
- Inspector exceptions go to `log.error` (not the structured `dropped_messages` table). The proposal explicitly says "the inspector module is responsible for any audit row" — core just records that it blocked. If we want a structural audit row for `inspector_error` specifically, that's a follow-up.
- Short-circuit ordering: `engages → accessGate → senderScopeGate → messageInspector`. Once any earlier check refuses, `inspectionOk` starts false and the inspector is skipped. Verified by case 6.
- `messageText` is the `parsed.text ?? ''` already computed at the top of the routing loop. Empty string when the content isn't JSON-with-`.text`.
- Test file uses `vi.resetModules()` per test, which is unusual in this repo (host-core.test.ts doesn't). Required because hook state is module-level singleton; without it, registering an inspector in one test would persist into the next. Documented in a comment at the top of `beforeEach`.

## Backwards compat

No callers exist for `setMessageInspector` yet. `setAccessGate` and `setSenderScopeGate` are unchanged. The router behavior is identical to `main` when no inspector is registered (verified by case 1).

## Out-of-scope (future PRs)

- Source-side `docs/architecture.md` "Hook surfaces" / "Registration points" sections — neither file currently has the section.
- Skill-side prompt-gate consumer (`skill/add-prompt-gate`) — separate PR, separate branch.
- Annotation/soft-mode (proposal open question 3) — explicitly deferred per the proposal.
- Pulling the inspector out of the engage branch to also run on accumulated messages — see Deviations.
