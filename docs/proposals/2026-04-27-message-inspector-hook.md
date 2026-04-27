# Message Inspector Hook

**Date:** 2026-04-27
**Status:** Proposal — pre-PR
**Owner:** Leeor

---

## Problem

`setAccessGate` at `src/router.ts:81` is a **single-slot** policy hook, already taken by the permissions module (`src/modules/permissions/index.ts:147`). It enforces identity policy: who is the sender, are they an owner / admin / member, etc.

External skills that want to do **content validation** (prompt-injection scanning, sender-ID verification beyond ownership, allow/deny lists, audit-trail decisioning) cannot register at the same slot — they would clobber permissions.

Workarounds:

- Chain the existing handler — fragile, requires reading core's private state.
- Add a second `setAccessGate` registration — current code log-warns and overwrites (`router.ts:82–84`).
- Skip the gate, validate inside a delivery action — too late: container already woken.

The policies are different concerns:

- **Identity** (permissions): given who the sender is, is this conversation allowed?
- **Content** (prompt-gate): given the message text + attachments, is this safe to deliver?

Two concerns → two hooks.

## Current code

- `src/router.ts:70` — `AccessGateResult = { allowed: true } | { allowed: false; reason: string }`.
- `src/router.ts:72` — `AccessGateFn` signature: `(event, userId, mg, agentGroupId) => AccessGateResult`.
- `src/router.ts:81` — `setAccessGate(fn)`, single-slot, log-warns on overwrite.
- `src/router.ts:265` — invocation point: `engages && (!accessGate || accessGate(event, userId, mg, agent.agent_group_id).allowed)`.
- `src/router.ts:266` — sister hook `setSenderScopeGate` follows same pattern, is per-wiring.
- `src/modules/permissions/index.ts:147` — sole current consumer; identity-policy decisions, calls `handleUnknownSender(...)` on refuse for audit and approval-flow surfacing.

## Proposed change

Add a new hook `setMessageInspector` that runs **between** `setAccessGate` (identity) and `deliverToAgent` (wake). It receives the same arguments + the resolved messageText + attachments so a skill can inspect content without re-reading them.

### 1. Type + setter

Patch `src/router.ts` near the existing access-gate definitions:

```typescript
/**
 * Message-content inspection hook. Runs after the access gate, before
 * delivery. Distinct from access-gate because the concern is different
 * (content validation, not identity policy). Skills installing prompt-
 * injection scanners, content allow/deny rules, or audit-trail logging
 * register here — not at setAccessGate, which is for identity decisions.
 *
 * Single-slot. Returns `allowed: false` to block delivery. The skill is
 * responsible for recording its own audit row on refusal.
 */
export type MessageInspectorResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export type MessageInspectorFn = (
  event: InboundEvent,
  userId: string | null,
  mg: MessagingGroup,
  agentGroupId: string,
  messageText: string,
) => MessageInspectorResult | Promise<MessageInspectorResult>;

let messageInspector: MessageInspectorFn | null = null;

export function setMessageInspector(fn: MessageInspectorFn): void {
  if (messageInspector) {
    log.warn('Message inspector overwritten');
  }
  messageInspector = fn;
}
```

### 2. Invocation

Patch the routing block at `router.ts:265`. Today:

```typescript
const accessOk = engages && (!accessGate || accessGate(event, userId, mg, agent.agent_group_id).allowed);
const scopeOk = engages && (!senderScopeGate || senderScopeGate(event, userId, mg, agent).allowed);

if (engages && accessOk && scopeOk) {
  await deliverToAgent(...);
  ...
}
```

Becomes:

```typescript
const accessOk = engages && (!accessGate || accessGate(event, userId, mg, agent.agent_group_id).allowed);
const scopeOk = engages && (!senderScopeGate || senderScopeGate(event, userId, mg, agent).allowed);

let inspectionOk = engages && accessOk && scopeOk;
if (inspectionOk && messageInspector) {
  const result = await messageInspector(event, userId, mg, agent.agent_group_id, messageText);
  inspectionOk = result.allowed;
  if (!result.allowed) {
    log.info('Message blocked by inspector', {
      reason: result.reason,
      sessionAgent: agent.agent_group_id,
      mg: mg.id,
    });
    // Note: the inspector module is responsible for any audit/dropped_messages row.
  }
}

if (inspectionOk) {
  await deliverToAgent(...);
  ...
}
```

The inspector is allowed to be async — content scanning may make HTTP calls (e.g. to a remote injection-detection service). The other gates today are sync; making this one async is consistent with router's existing async surface (`deliverToAgent` is awaited).

### 3. Re-export

Add `setMessageInspector` to the same export site that `setAccessGate` is exported from (no separate barrel needed).

## Why a separate hook, not multi-handler accessGate

| Trade-off | Multi-handler `addAccessGate` | Separate `setMessageInspector` |
|---|---|---|
| API change | Replace `setAccessGate` | Add `setMessageInspector` |
| Existing callers | Break (must rename to `addAccessGate`) | No change |
| Conceptual split | One slot for "is this allowed?" — mixes identity + content | Identity vs content stay distinct |
| Handler ordering | Must define priority semantics | Not needed — inspector runs after access-gate by position |
| Async support | Have to retrofit each handler in sequence | Inspector is async-from-day-one |
| Audit trail | Hard to attribute refusal to which handler | Refusal source is unambiguous (which hook) |

Separate hook wins on all axes except "fewer hook names." That's a small price — readability is improved by the explicit name (`messageInspector` is clearer than yet-another-`accessGate`).

## Alternatives considered

- **Pre-route `setMessageFilter`** that runs before agent resolution. Rejected: agent-aware decisions (e.g. "block this content for coding agent but not main") need the resolved agentGroupId.
- **Container-side filter** (inside agent-runner). Rejected: too late — the wake has already happened. Also can't apply uniform policy across providers.
- **Combine with `setSenderScopeGate`**. Rejected: scope-gate is per-wiring (per-agent), inspector is per-message. Different invariants.

## Backwards compatibility

Pure addition. No existing code changes signature. No DB schema impact. Skills that don't register an inspector see no behavior change.

## Test plan

New tests in `router.test.ts`:

- Inspector not registered → routing proceeds as before.
- Inspector registered, returns `{ allowed: true }` → message delivered.
- Inspector returns `{ allowed: false, reason: ... }` → no delivery, refusal logged with reason.
- Inspector throws → treated as block + logged (failsafe behavior — content validation failure should refuse-by-default, not allow-by-default).
- Inspector returns Promise — awaited.
- Inspector + accessGate both refuse — accessGate fires first; inspector never runs.

A skill-side test (lives in `skill/add-prompt-gate`) registers a fake inspector that blocks any message containing `"IGNORE PREVIOUS INSTRUCTIONS"` and asserts the refusal path.

## Failsafe behavior on throw

If the inspector throws (network failure on remote scanner, bug in regex, etc.), the router treats it as `{ allowed: false, reason: 'inspector_error' }`. **Content validation is failsafe by default**: when in doubt, refuse. The inspector module is responsible for catching its own recoverable errors and returning `{ allowed: true }` for the cases it deems safe to ignore.

This is the opposite of `accessGate` failure handling (which today doesn't try-catch — a throw would crash the router). Document this distinction clearly in the JSDoc.

## Implementation steps

1. Add type + setter + module-level variable in `src/router.ts`. ~25 lines.
2. Patch the invocation point (router.ts:265 area) — wrap the engage check with the inspector await + try/catch. ~12 lines.
3. Add tests to `src/router.test.ts`. ~80 lines covering the cases above.
4. Update `docs/architecture.md` "Hook surfaces" section — add `setMessageInspector`.
5. Update `docs/module-contract.md` — add inspector to the list of skill registration points.

## Effort estimate

Code change is small (~50 lines + ~80 lines of test). Doc updates ~20 lines.

Total: half a day. Review surface is small; the patch is mechanical.

PR turnaround on upstream: 3–7 days. The change is additive and doesn't conflict with any in-progress feature work I'm aware of.

## Open questions

1. ~~Should the inspector also run for accumulate-path messages?~~ → **Resolved: narrow scope (engage path only).** As-shipped, the inspector runs only when a message engages an agent (`engages && accessOk && scopeOk`). Accumulate-path messages (`ignored_message_policy === 'accumulate'`, stored with `trigger=0`) are NOT inspected. Decision rationale (2026-04-27):
   - **Cost**: accumulate-path volume can dominate engagement volume in busy channels; running content scanners on every channel message is expensive (especially remote-API scanners).
   - **Reversibility asymmetry**: cheaper to broaden later than retract. Broadening is purely additive.
   - **Concrete vectors target live traffic**: most current prompt-injection research targets the user-prompt path, not historical context buffers.
   - **Accumulate use is fork-style behavior**: not heavily exercised by upstream installs yet.

   **Known coverage gap**: malicious content can land in the accumulate buffer un-inspected; on the next legitimate wake the agent reads it as historical context. Skills that need full coverage should either (a) instruct the agent in CLAUDE.md to treat the accumulate buffer as untrusted, or (b) wait for a future `setAccumulateInspector` hook.

   **Revisit trigger**: open follow-up if (i) real-world prompt-injection-via-accumulate attacks materialize, or (ii) accumulate semantics change such that accumulated messages drive agent action without an intervening engage. Until then: narrow stays.

2. Should the inspector receive the **list of attachments** too (image URLs, file IDs)? Resolved: `event.attachments` is already on `InboundEvent`, so the inspector reads attachments via `event.message.attachments` directly. No separate parameter added.
3. Should there be a way to **annotate** rather than refuse? E.g. "tag this message as suspicious but still deliver." Out of scope for v1 of this hook — skills can persist their own audit rows separately if they want soft-mode.
