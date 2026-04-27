# Prompt: Message Inspector Hook PR

You are an autonomous agent working in `~/repos/nanoclaw-v2`. Your task: implement the proposal in `docs/proposals/2026-04-27-message-inspector-hook.md` exactly as specified there. Read that doc first.

## Goal

Add a new `setMessageInspector` hook in `src/router.ts` that runs after `setAccessGate` (identity policy) and before `deliverToAgent` (wake). The hook is for **content-validation** policy — distinct concern from the existing access-gate.

## Branch

```bash
git checkout main
git pull origin main
git checkout -b feat/message-inspector-hook
```

## Implementation

The proposal doc has the full design. Follow it exactly. Key points:

- Hook is **single-slot** (matching `setAccessGate` shape).
- Hook is **async-friendly** — return type is `MessageInspectorResult | Promise<MessageInspectorResult>`.
- Hook receives `(event, userId, mg, agentGroupId, messageText)`.
- Inspector throws → treated as `{ allowed: false, reason: 'inspector_error' }`. **Failsafe by default**: when content scanning fails, refuse delivery.
- Position: runs in the routing loop, after the engage / accessGate / scopeGate checks, only when those allow. (See proposal §2 for placement.)
- The inspector is responsible for its own audit-trail row on refusal — core just logs the block.

### Files to modify

- `src/router.ts`:
  - Add `MessageInspectorResult` and `MessageInspectorFn` types.
  - Add `messageInspector` module-level state (`null` default).
  - Add `setMessageInspector(fn)` — log-warn on overwrite (matches `setAccessGate` pattern).
  - Patch the engage block (currently around `router.ts:259-293` — locate via existing `accessGate(event, userId, mg, agent.agent_group_id)` call). Wrap with inspector await + try/catch. On refusal: don't deliver; log the block reason.

- `docs/architecture.md` (if it has a "Hook surfaces" section):
  - Add `setMessageInspector` to the list.

- `docs/module-contract.md` (if it lists registration points):
  - Add inspector.

### Files to create

- No new source files. Pure addition to `router.ts`.

### Tests

Add to `src/router.test.ts` (or sibling test file):

1. No inspector registered → routing proceeds as before.
2. Inspector returns `{ allowed: true }` → message delivered.
3. Inspector returns `{ allowed: false, reason: 'foo' }` → no delivery; log emitted with reason.
4. Inspector throws → no delivery; treated as block; no agent wake.
5. Inspector returns `Promise<MessageInspectorResult>` → awaited correctly.
6. accessGate refuses + inspector registered → inspector NOT called (short-circuit).

## Verify

```bash
pnpm run build
pnpm test
```

Both must pass.

## Output

Write a PR description to `docs/proposals/agent-prompts/pr-message-inspector-OUT.md`:

- Summary of the change.
- File-by-file diff summary.
- Any deviations from the proposal doc.
- Test results.
- Reviewer notes.

Push:

```bash
git push -u origin feat/message-inspector-hook
```

## Constraints

- **Pure addition**: no existing API signature changes. `setAccessGate` and `setSenderScopeGate` keep their current shape.
- **Single-slot**: prompt-gate is the only intended consumer; multi-handler not needed yet.
- **Failsafe on throw**: documented behavior. Don't swallow throws silently.
- **Async-aware**: `await` the inspector call. Don't assume sync.
- **No DB schema impact**: pure code addition.
- **Don't touch v1**: `~/repos/nanoclaw` is read-only.
- **Do not modify** `docs/proposals/2026-04-27-message-inspector-hook.md`. Record design issues in the OUT doc.

## Reference

- `src/router.ts:81` — existing `setAccessGate(fn)` for the pattern to mirror.
- `src/router.ts:265` — current invocation point for access-gate, where inspector slots in.
- `src/modules/permissions/index.ts:147` — example consumer of `setAccessGate` (single-slot pattern).

## Done criteria

- [ ] Branch `feat/message-inspector-hook` exists.
- [ ] `router.ts` has the hook + invocation.
- [ ] Tests cover all 6 cases above.
- [ ] `pnpm run build` clean.
- [ ] `pnpm test` clean.
- [ ] Doc updates done.
- [ ] OUT doc written.
- [ ] Branch pushed.
