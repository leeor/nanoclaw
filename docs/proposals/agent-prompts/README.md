# Agent Prompts

Self-contained briefs for fresh agent sessions to do specific migration work in this clone. Each prompt assumes the agent has *no* prior context — just drop it into a fresh session in `~/repos/nanoclaw-v2`.

## Working tree

All work happens in `~/repos/nanoclaw-v2` (this directory). The sibling `~/repos/nanoclaw` is the running v1 install — **read-only**, do not modify.

## Pivot — 2026-04-27

The first round of prompts (`pr-container-backend.md`, `pr-message-inspector.md`) targeted **direct trunk PRs**. After re-reading upstream `CONTRIBUTING.md`, the right shape is **feature skills**, not trunk PRs:

> **Source code changes accepted:** bug fixes, security fixes, simplifications, reducing code.
> **Not accepted:** features, capabilities, compatibility, enhancements. **These should be skills.**

The completed implementations were renamed onto skill branches (`skill/add-coding-agent`, `skill/add-prompt-gate`); their PR scaffolding moved to `obsolete/`. New prompts continue from the existing branch tips.

## Prompts

| File | Goal | Branch | Status |
|---|---|---|---|
| `skill-add-icm-tool.md` | ICM MCP integration | `skill/add-icm-tool` | Ready (independent) |
| `skill-add-backoffice-tool.md` | Backoffice OpenAPI MCP | `skill/add-backoffice-tool` | Ready (independent) |
| `skill-slack-mcp-tools.md` | Slack read-side MCP tools | `skill/slack-mcp-tools` | Ready (independent) |
| `skill-add-prompt-gate.md` | Content-validation pipeline (hook + consumer + audit) | `skill/add-prompt-gate` | Ready — extends existing branch (`52c64538fc36`) |
| `skill-add-coding-agent.md` | Per-task devcontainer-backed coding agent | `skill/add-coding-agent` | Ready — extends existing branch (`ae7533e79024`) |

| File | Status |
|---|---|
| `obsolete/pr-container-backend.md` + `-OUT.md` | Superseded by `skill-add-coding-agent.md` |
| `obsolete/pr-message-inspector.md` + `-OUT.md` | Superseded by `skill-add-prompt-gate.md` |
| `obsolete/README.md` | Pivot rationale + cross-references |

## Order

The 5 active prompts can run in **any order** — independent file scopes. Skill branches are isolated. Each prompt commits to its own `skill/*` branch and a corresponding `.claude/skills/<name>/SKILL.md` on `main`.

The two extension-branch skills (`add-prompt-gate`, `add-coding-agent`) are larger because they bundle the underlying hook/registry refactor with its consumer. The 3 MCP skills are smaller (single Dockerfile + agent-runner patch each).

## Conventions

- **Branch from `main`** for new skill branches (`skill/add-icm-tool`, `skill/add-backoffice-tool`, `skill/slack-mcp-tools`).
- **Continue from existing tip** for `skill/add-coding-agent` and `skill/add-prompt-gate` — do NOT alter the existing two commits on each (they're the upstream-PR-shaped portion).
- One commit per atomic change. Descriptive messages.
- **SKILL.md goes on `main`**, code goes on `skill/*` branch. Per upstream `CONTRIBUTING.md`.
- Run `pnpm run build` and `pnpm test` before claiming done.
- Output a PR description (or running diary for `add-coding-agent`) at the end of each session — `docs/proposals/agent-prompts/<name>-OUT.md`. The operator pushes when satisfied.
- Push both `main` (with SKILL.md) and the skill branch to fork (`git push fork main && git push fork skill/<name>`).
- Reference v1 fork code by absolute path: `~/repos/nanoclaw/...` and by commit hash from v1's git history.

## Migration context

This clone is the v2 baseline of NanoClaw. v1 is the production install we're porting from. The plan lives in `~/repos/nanoclaw/docs/superpowers/plans/2026-04-26-v2-migration.md`. See that doc for the architectural map (which subsystems were rewritten, which fork features are being re-expressed as skills).

For deeper context: `docs/architecture.md`, `docs/skills-as-branches.md`, `docs/module-contract.md` in this clone.

For PR shaping: `CONTRIBUTING.md` at the root — the four skill types, SKILL.md format, PR description requirements.

## Push + PR workflow

1. From v2 clone:
   ```bash
   git push fork skill/<name>     # code branch
   git checkout main && git push fork main   # SKILL.md
   ```
2. Open cross-fork PR in browser:
   ```
   https://github.com/qwibitai/nanoclaw/compare/main...leeor:nanoclaw:main
   ```
   PR description references the skill branch (which the SKILL.md tells `/customize` how to fetch + merge).

3. The operator opens the PR — `gh pr create --repo qwibitai/nanoclaw` requires permission scopes the current PAT doesn't have for cross-fork PRs.
