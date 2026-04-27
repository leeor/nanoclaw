# Obsolete prompts

These prompts targeted **direct trunk PRs** for the `containerBackend` registry and `setMessageInspector` hook. They were drafted before re-reading upstream `CONTRIBUTING.md`, which classifies any new capability/extension surface as a **skill**, not a trunk PR.

> Source code changes accepted: bug fixes, security fixes, simplifications, reducing code.
> Not accepted: features, capabilities, compatibility, enhancements. **These should be skills.**

## Pivot

The work didn't disappear — it moved into the corresponding skill branches:

| Obsolete prompt | Outcome | New home |
|---|---|---|
| `pr-container-backend.md` | Implementation done — branch renamed | `skill/add-coding-agent` (commit `ae7533e79024`); driven by `../skill-add-coding-agent.md` |
| `pr-message-inspector.md` | Implementation done — branch renamed | `skill/add-prompt-gate` (commit `52c64538fc36`); driven by `../skill-add-prompt-gate.md` |

The OUT docs (`*-OUT.md`) record what the implementing agents reported. Useful as engineering reference; superseded as PR plans.

## What stays valid

- The **proposal docs** at `docs/proposals/2026-04-27-container-backend-registry.md` and `docs/proposals/2026-04-27-message-inspector-hook.md` are still the design references. They describe the registry and the hook — both real architectural changes the skill branches ship.
- The **commits** on `skill/add-coding-agent` and `skill/add-prompt-gate` are the implementations described in those proposals.

## What's different now

- No trunk PR for the registry or hook in isolation.
- Each ships as part of a feature skill that bundles the consumer (devcontainer backend, prompt-gate inspector) with the extension surface that enables it.
- Single PR per skill: SKILL.md goes onto `main`; the code lives on `skill/*` branch; users opt in via `/customize` or `scripts/apply-skill.ts`.
