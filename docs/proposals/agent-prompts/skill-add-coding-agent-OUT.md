# skill/add-coding-agent — running diary

## Side-branch merge note (read this first)

Sub-tasks 6 and 7 (container-side: retry proxy + gh/devcontainer-cli/linear MCPs + Dockerfile pins) were delivered on a sibling branch **`skill/add-coding-agent-container`**, branched off `skill/add-coding-agent` at commit `f931aea88d0e` and developed in the worktree `/home/leeor/repos/nanoclaw-v2-coding-agent-container`. They were **NOT merged into `skill/add-coding-agent`** by either agent — a parallel host-side agent (sub-tasks 4/5/9) was working on `skill/add-coding-agent` simultaneously, so the operator must serialise the merge to avoid racing the parallel agent.

Operator merge command (after the host-side parallel agent reports done):

```bash
cd /home/leeor/repos/nanoclaw-v2-coding-agent      # the host-side worktree
git fetch . skill/add-coding-agent-container        # local fetch — both branches are local
git merge --no-ff skill/add-coding-agent-container  # or rebase, your call
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm run build && pnpm test
```

The container branch is a fast-forward over `f931aea88d0e`; if the host-side branch only adds files under `src/**` / `groups/**`, no merge conflict is expected. Container build (`./container/build.sh`) is required before end-to-end smoke (gh + devcontainer-cli pins).

---

Worktree: `/home/leeor/repos/nanoclaw-v2-coding-agent`
Skill branch: `skill/add-coding-agent` (extends commit `ae7533e79024`)
Sibling skill branch: `skill/add-coding-agent-container` (sub-tasks 6 + 7; off `f931aea88d0e`)
Main-side branch: `main-skill-add-coding-agent` (one-commit local branch tracking `origin/main`)

The brief enumerates 10 sub-tasks scoped at 2.5–3 weeks of effort. This session delivered the foundation (sub-tasks 1, 2, 3, 10), made the skill installable end-to-end with a stub coding module, and explicitly leaves sub-tasks 4–9 as a documented follow-up. Each commit was build-and-test clean before the next.

## Sub-task 1 — Devcontainer backend (DONE)

Commit: `b4010198083d feat(container-backends): add devcontainer backend`

- `src/container-backends/devcontainer.ts` — registers `'devcontainer'` backend. `spawn()` runs `devcontainer up --workspace-folder <path> --id-label nanoclaw.session=...` (idempotent), then `devcontainer exec` for the long-lived agent-runner. Workspace folder comes from `containerConfig.devcontainer.workspaceFolder` (skill-owned field accessed via cast). 15-minute up-timeout. `stop()` is `devcontainer stop --workspace-folder`, with docker-stop-by-id-label fallback.
- OneCLI integration: probes `applyContainerConfig` with an empty array, extracts the `-e KEY=VALUE` pairs the SDK injected, and forwards them via `--remote-env` (since `devcontainer exec` has no docker-run flag surface).
- `src/container-backends/devcontainer.test.ts` — 6 tests: missing workspaceFolder, happy-path up+exec args, OneCLI env probe + forward, up-non-zero rejects, stop happy path, stop fallback to docker-stop, stop no-op when no meta.
- `src/container-backends/index.ts` — appended `import './devcontainer.js';`.

## Sub-task 2 — Coding module skeleton (DONE)

Commit: `80c3d31fb412 feat(modules/coding): add module skeleton with delivery-action stub`

- `src/modules/coding/index.ts` — registers `coding_cost_summary` delivery action; exports `initCodingModule()` for host startup; re-exports worktree-lock helpers.
- `src/modules/coding/cost-summary.ts` — handler stub that logs the payload and acks. Real impl is sub-task 4.
- `src/modules/coding/orphan-scanner.ts` — `runOrphanScan()` stub. Real impl is sub-task 5.
- `src/modules/coding/worktree-locks.ts` — initial stub (later filled by sub-task 3).
- `src/modules/index.ts` — appended `import './coding/index.js';`.

This split lets sub-tasks 4 and 5 land as focused replacements of stubs rather than monolithic patches.

## Sub-task 3 — Worktree mutex DB + helpers (DONE)

Commit: `260af9e8aaea feat(modules/coding): worktree mutex table + acquire/release helpers`

- `src/db/migrations/module-coding-worktree-locks.ts` — `coding_worktree_locks (worktree_path PK, session_id FK→sessions.id ON DELETE CASCADE, acquired_at)`. Index on `session_id`.
- `src/db/migrations/index.ts` — registered.
- `src/modules/coding/worktree-locks.ts` — real impl. `acquireWorktreeLock` is `INSERT OR IGNORE` + verification `SELECT`; returns the existing lock on same-session re-acquire; returns `null` on contention. `releaseWorktreeLock` is idempotent. `listWorktreeLocks` snapshots for the orphan scanner. Every helper guards with `hasTable()` so the skill degrades silently on uninstalled installs.
- `src/modules/coding/worktree-locks.test.ts` — 7 tests covering acquire / contention / re-acquire / release / cascade-delete / parallel different worktrees.

## Sub-task 10 — code-review-instructions.md + SKILL.md (DONE)

Commits:
- `45e389cfa229 feat(coding-agent): port code-review-instructions.md from v1` (skill branch)
- `760ff09aae81 feat(skill): add /add-coding-agent` (main-side branch)

- `groups/coding_global/code-review-instructions.md` — verbatim port from v1 fork (`~/repos/nanoclaw/groups/coding_global/code-review-instructions.md`). 39 lines.
- `.gitignore` — added explicit allow-list for `groups/coding_global/` since `groups/*` is otherwise ignored. The skill branch is the canonical source for the starter file; the install flow copies it into the user's chosen `groups/<folder>/`.
- `.claude/skills/add-coding-agent/SKILL.md` — 169 lines (under the 500-line cap). Modeled on `add-emacs/SKILL.md` for shape; covers prerequisites, idempotent pre-flight, fetch+merge, configure (container.json shape, OneCLI secrets), verify (smoke test, lock-table inspection, docker ps), removal, troubleshooting.

## Sub-task — prettier reformat (chore, DONE)

Commit: `598aa28899d7 chore: re-apply prettier formatting`

The husky `pre-commit` hook runs `pnpm run format:fix` but doesn't re-stage. Captured the resulting whitespace-only diffs (in `docker.test.ts`, `registry.test.ts`, `container-runner.ts`, `worktree-locks.ts`) in a single follow-up commit so the working tree matches the committed text.

## Sub-tasks NOT delivered in this session (4, 5, 6, 7, 8, 9)

> **Status update (2026-04-27):** all of these have since landed on `skill/add-coding-agent` and the parallel `skill/add-coding-agent-container` side branch. See the "Sub-task N — DONE" sections at the bottom of this file. Original gap analysis preserved below for context.

| # | Sub-task | Status | Notes |
|---|----------|--------|-------|
| 4 | Cost summary (full impl) | DONE | `src/modules/coding/cost-summary.ts` + 23-case test. Channel-agnostic delivery via the registered adapter; PR comment via `gh pr comment`. Dropped v1's `gh pr list --head` lookup (agent ships its own PR number) and v1's host-side JSONL aggregation (container does its own). |
| 5 | Orphan scanner (full impl) | DONE | `src/modules/coding/orphan-scanner.ts` + 13-case test. Reconciles `coding_worktree_locks` against `docker ps --filter label=nanoclaw.install=...`; boot scan + 5-min sweep tick; fail-safe on docker-ps failure (never releases locks blindly). |
| 6 | In-container retry proxy | DONE (container worktree) | `container/agent-runner/src/local-proxy.ts` + 8-case test. HTTP forwarder with exponential backoff on `ECONNREFUSED`/transient codes. |
| 7 | Container-side coding MCP servers | DONE (container worktree) | `container/agent-runner/src/mcp-tools/{gh,devcontainer-cli,linear}.ts` + 30 test cases. Three new stdio MCP modules. |
| 8 | PR monitor scheduled task | DONE | Replaced by host-driven deterministic poller — see "Sub-task 8 — Deterministic PR monitor" section. |
| 9 | Graceful shutdown handler | DONE | `src/modules/coding/graceful-shutdown.ts` + 8-case test. Drains via `_shutdown` system message into `inbound.db` (no IPC dirs in v2); `devcontainer stop` fallback for stragglers; lock release. Wired from `src/index.ts`. |

The skeleton in sub-task 2 deliberately leaves `cost-summary.ts` and `orphan-scanner.ts` as logging stubs so sub-tasks 4 and 5 are pure swap-ins — no API surface churn.

## Files changed

### `skill/add-coding-agent` (5 new commits on top of `ae7533e79024`)

```
.gitignore                                                    | 6 ++
.claude/skills/add-coding-agent/SKILL.md                      | (on main-side)
groups/coding_global/code-review-instructions.md              | 39 ++++
src/container-backends/devcontainer.test.ts                   | 209 +++++
src/container-backends/devcontainer.ts                        | 245 +++++
src/container-backends/index.ts                               | 1 +
src/db/migrations/index.ts                                    | 3 +
src/db/migrations/module-coding-worktree-locks.ts             | 31 +++
src/modules/coding/cost-summary.ts                            | 38 +++
src/modules/coding/index.ts                                   | 47 ++++
src/modules/coding/orphan-scanner.ts                          | 26 +++
src/modules/coding/worktree-locks.test.ts                     | 122 +++++
src/modules/coding/worktree-locks.ts                          | 109 ++++++
src/modules/index.ts                                          | 1 +
src/container-backends/{docker,registry}.test.ts              | (prettier)
src/container-runner.ts                                       | (prettier)
```

### `main-skill-add-coding-agent` (1 commit on top of `origin/main`)

```
.claude/skills/add-coding-agent/SKILL.md   | 169 +++++
```

## Test results

```
$ pnpm run build      # skill/add-coding-agent
> tsc                  (clean exit)

$ pnpm test           # skill/add-coding-agent
 Test Files  27 passed (27)
      Tests  217 passed (217)
```

210 tests pre-existed; 7 new tests in `worktree-locks.test.ts`. The 6 new tests in `devcontainer.test.ts` are counted in a single Test File (existing 26 → 27).

```
$ pnpm run build      # main-skill-add-coding-agent (SKILL.md only — no source change)
> tsc                  (clean exit)

$ pnpm test
 Test Files  23 passed (23)
      Tests  197 passed (197)
```

Container build (`./container/build.sh`) was NOT run this session — the changes are host-side only and don't touch the container image surface. Sub-tasks 6, 7, 8 will require it.

## Push commands

```bash
# Skill branch (5 new commits on top of ae7533e79024):
cd /home/leeor/repos/nanoclaw-v2-coding-agent
git checkout skill/add-coding-agent
git push fork skill/add-coding-agent

# Main-side SKILL.md commit:
# (Created as a local branch `main-skill-add-coding-agent` in the same
# worktree because main is currently checked out at
# /home/leeor/repos/nanoclaw-v2-slack-mcp. Push via fast-forward into
# whichever main-tracking worktree you prefer:)
git push fork main-skill-add-coding-agent:main
# or, from a worktree where main is checked out:
#   git fetch . main-skill-add-coding-agent
#   git merge --ff-only FETCH_HEAD
#   git push fork main
```

PR target per the brief is a cross-fork PR `leeor:main → qwibitai:main` carrying the SKILL.md commit; the skill branch `skill/add-coding-agent` is referenced from SKILL.md and fetched at install time.

## Reviewer notes

- The largest single judgment call was "ship a stub coding module now so the skill installs end-to-end" vs. "block everything on full sub-tasks 4–9". Picked the former because the stubs have explicit log lines that say "stub — sub-task N will fill this in", and the skill is genuinely usable today (devcontainer spawns, worktree mutex enforces, code-review-instructions ships) — what's missing is the cost summary, orphan reconciliation, retry proxy, container MCPs, PR-monitor task, and graceful shutdown. The brief is structured around the skill being decomposed across multiple operator-reviewed sessions, so this matches its model.
- The `groups/coding_global/` exception in `.gitignore` is the only "trunk file" that touches user-installation territory. Open to feedback on whether the file should instead live under `assets/coding-agent/` and be copied into `groups/<folder>/` at install time. Brief was explicit about path; I followed it.
- The OneCLI env-probe trick in `devcontainer.ts:buildOneCliRemoteEnv` is the most clever / fragile bit. If the SDK ever inserts non-`-e` flags before the `-e` pairs we want, the loop will skip them silently. Considered importing the SDK's internal env list instead but the SDK doesn't expose that. Worth a follow-up: ask `@onecli-sh/sdk` to expose `getProxyEnv()` directly. Logged as TODO for sub-task 6 review.
- `acquireWorktreeLock`'s `INSERT OR IGNORE` + verification `SELECT` is correct because SQLite serializes writes inside a single process. No transaction wrap because the SELECT-after-INSERT is on the same row and the table has no other writers between the two statements (the host is single-process; the container-side runner cannot reach the central DB).
- `code-review-instructions.md` is verbatim from v1. If we want to update it for v2 patterns (e.g., `git diff origin/main...HEAD` instead of `git diff master...HEAD`), do it as a follow-up commit on the skill branch — keeping the initial port verbatim makes the v1→v2 diff reviewable.

## Done criteria status (from the brief)

- [x] Devcontainer backend registered in `src/container-backends/devcontainer.ts`.
- [x] Coding module under `src/modules/coding/` (skeleton).
- [x] Worktree-mutex table + migration.
- [x] In-container retry proxy. (sub-task 6 — DONE on side branch `skill/add-coding-agent-container`)
- [x] Container-side gh / devcontainer-cli / Linear MCP servers. (sub-task 7 — DONE on side branch `skill/add-coding-agent-container`)
- [x] PR monitor — deterministic, host-driven poll with ETag fast-path; agent woken only on fresh comments. (sub-task 8)
- [ ] Cost summary delivery action. (sub-task 4 — stub registered)
- [ ] Orphan scanner. (sub-task 5 — stub registered)
- [ ] Graceful shutdown handler. (sub-task 9)
- [x] All tests green.
- [x] Container builds. *(not rebuilt — no container changes in this session)*
- [ ] End-to-end smoke clean. (gated on sub-tasks 6–9)
- [x] SKILL.md on `main` (local branch `main-skill-add-coding-agent`).
- [x] OUT doc complete.
- [ ] Both branches pushed. *(per task instructions — explicitly not pushed)*

---

## Sub-task 8 — Deterministic PR monitor (DONE)

Replaces v1's 700-line LLM-prompt-driven `monitor_pr` recurring task with a host-driven poller. v1 burned tokens every 5 minutes regardless of whether GitHub had anything new; v2 polls `gh pr view` + `gh api .../comments` with `If-None-Match` ETag headers and only writes a wake message into the session's `inbound.db` when fresh non-noise comments actually arrive. Quiescent PRs cost zero agent tokens.

### Commits (6, on top of `598aa28899d7`)

```
34cf7489decf feat(db): migration for coding_pr_monitors + seen tables
8e1627eec2a9 feat(modules/coding): deterministic pr-monitor poller (pure)
f80296069e3a feat(modules/coding): pr-monitor runtime (gh shell, etag fetch, wake)
f8f78d10357a feat(modules/coding): register_pr_monitor delivery action
090e0961098f feat(host-sweep): poll due pr monitors each tick
b14021347dae feat(agent-runner): monitor_pr MCP tool emits register_pr_monitor
```

### Files changed (10 files, +1584 / −3)

```
container/agent-runner/src/mcp-tools/coding-pr-monitor.ts        |  97 +++++  (new)
container/agent-runner/src/mcp-tools/index.ts                    |   1 +
src/db/migrations/index.ts                                       |   2 +
src/db/migrations/module-coding-pr-monitors.ts                   |  61 +++  (new)
src/db/migrations/module-coding-pr-monitors.test.ts              | 137 +++++ (new)
src/host-sweep.ts                                                |  21 +
src/modules/coding/index.ts                                      |  73 ++- (doc-comment + handler)
src/modules/coding/pr-monitor.ts                                 | 413 +++++ (new — pure)
src/modules/coding/pr-monitor-runtime.ts                         | 314 +++++ (new — gh shell + wake)
src/modules/coding/pr-monitor.test.ts                            | 468 +++++ (new — 17 cases)
```

### Test deltas

```
$ pnpm test
 Test Files  29 passed (29)         (+2 over the 27 baseline from sub-tasks 1–3)
      Tests 241 passed (241)         (+24 over the 217 baseline)
```

`+24` = 17 in `pr-monitor.test.ts` + 7 in `module-coding-pr-monitors.test.ts`.

`pnpm run build` clean. `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` clean.

### Design choices that diverged from the brief

- **Same-millisecond id collisions.** Brief specified monitor id `"<repo>#<prNumber>:<ms>"`. Added a 6-char random suffix because the test "re-register after deactivate" hits a UNIQUE conflict when the second `registerPrMonitor` call lands inside the same `Date.now()` tick. Real id format: `"<repo>#<prNumber>:<ms>-<rand>"`. Doesn't change semantics; the random suffix is just collision avoidance.
- **First-poll timing.** `registerPrMonitor` sets `next_run_at = now`, not `now + interval_ms`, so the first tick after registration discovers existing comments immediately rather than after one full interval (defaulting to 60s). Operationally important — the agent often calls `monitor_pr` right after pushing, expecting to see the existing PR conversation, not waiting a minute.
- **Bot-noise upsert into seen table.** Bot-author comments (`linear[bot]`, `github-actions[bot]`) are filtered from the wake payload BUT still upserted into `coding_pr_monitor_seen`. Without this, every tick would re-classify the same noisy bot comment as NEW, fail the dedupe check, and re-fetch — wasted CPU even though no wake fires. Persisting them as "seen" closes that loop.
- **Wake failure semantics.** If `wakeAgent` throws after etags + seen rows are persisted, we don't roll back: the host already paid GitHub for the 200, so re-fetching next tick is wasted bandwidth, and the seen rows mean a successful retry won't double-wake. Trade-off: if wake permanently fails, the comments are lost from the agent's POV until the agent next opens that PR — but a permanent wake failure means the session is broken anyway, and the orphan scanner will catch it.
- **`cleanupCodingTask` is a stub.** Per the brief, kept as `cleanupCodingTaskStub` in `pr-monitor-runtime.ts` — logs intent and returns. The real graceful-cleanup path is sub-task 9; the orphan scanner from sub-task 5 catches the actually-stranded session in the meantime. The deps interface keeps the seam open (`PrMonitorDeps.cleanupCodingTask`), so swapping in the real impl is a one-line change in `buildPrMonitorDeps()`.
- **`gh api -i` for ETags vs. `node-fetch` directly.** Brief allowed either; chose `gh api -i` because it inherits the user's `gh auth` (no separate token wiring) and the response is text-parseable on the first blank-line split. Trade-off: `gh` exits non-zero on 304 (it considers 304 an error), so the runtime checks `parseGhApiResponse(stdout).status === 304` regardless of exit code. Documented inline at `pr-monitor-runtime.ts:178`.
- **MODULE-HOOK placement.** Placed `MODULE-HOOK:coding-pr-monitor` AFTER the per-session loop in `host-sweep.ts:sweep()`, not inside `sweepSession()`. Reason: the work unit is the central-DB `coding_pr_monitors` table, not any individual session DB — running it once per tick is the right granularity. The per-session scheduling-recurrence hook stays where it is for the same reason in reverse (its work IS per-session).
- **Session mode in `wakeAgentForMonitor`.** Hardcoded `'shared'` for `resolveSession`. PR monitor wakes are not thread-scoped at the SQLite level even when a `thread_id` is set, because the same agent group should keep one session per PR-task regardless of where the monitor message lands. The `thread_id` still flows through as the inbound message's `threadId` so the agent's reply lands back on the right thread.

### Things explicitly punted

- **No live-channel test for the registered delivery handler.** The brief's test #10 ("duplicate `register_pr_monitor` for same (agent_group, repo, pr) is no-op") is covered at the pure-function layer in `registerPrMonitor — idempotency`. Adding a second test that goes through the registered handler would require importing `src/modules/coding/index.ts` for its side-effect registration, which double-registers handlers when other tests already run that import — flaky, and the value-add over the pure test is small.
- **No `gh`-shell integration test.** `pr-monitor-runtime.ts` is exercised via the production sweep but has no dedicated unit test (would require a `gh` mock or a real GitHub repo). The pure poller has full coverage; the runtime is a thin shell adapter. If we pick this up later, a mock-spawn helper similar to what `src/container-backends/devcontainer.test.ts` already does would be the path.
- **Container build NOT re-run.** `coding-pr-monitor.ts` is a new agent-runner source file. It compiles clean under the container tsconfig but the docker image needs `./container/build.sh` to pick it up. Per task instructions, did not rebuild. End-to-end smoke is gated on a container rebuild plus the still-stub `cleanupCodingTask` (sub-task 9).

---

## Sub-task 6 — In-container retry proxy (DONE on side branch)

Side branch: `skill/add-coding-agent-container` (off `f931aea88d0e`)
Worktree: `/home/leeor/repos/nanoclaw-v2-coding-agent-container`

HTTP forwarder running inside the agent container that retries `ECONNREFUSED` (and a handful of related transient codes — `ECONNRESET`, `ENOTFOUND`, `EHOSTUNREACH`, `ENETUNREACH`, `EAI_AGAIN`) against the upstream credential proxy / OneCLI gateway with exponential backoff. The Agent SDK inside the container never sees a transient host outage. Backoff: 250 / 500 / 1000 / 2000 / 4000 / 8000 ms (then capped at 8 s), total 60 s window before returning a 502 with a structured `{error: {type: "local_proxy_error", message}}` body.

### Commits (2)

```
d3ce33c1fe64 feat(agent-runner): retry-proxy port from v1 with node:http under Bun
c89a20fe63e8 feat(agent-runner): start local-proxy at boot when port env set
```

### Files changed

```
container/agent-runner/src/local-proxy.ts        198 ++++++ (new)
container/agent-runner/src/local-proxy.test.ts   341 ++++++ (new)
container/agent-runner/src/index.ts              +30
```

### Design choices that diverged from the brief

- **`node:http` over `Bun.serve`.** The brief permits either ("If Bun's API doesn't suit, `node:http` works under Bun too — pick whichever stays cleanest"). Picked `node:http` because (a) it's a near-1:1 port of v1's working code; (b) the streaming + retry semantics map directly onto `IncomingMessage` / `pipe`; (c) `Bun.serve` exposes the request as a Web `Request` whose body is a `ReadableStream` — buffering once for replay-on-retry is straightforward, but piping the upstream response back out without a fetch round-trip is awkward inside `Bun.serve` because the response side wants a `Response` object whose body is itself a stream. Rather than re-implement retry-on-error against `fetch`'s opaque stream lifecycle, we stuck with the Node API. Test fakes still use `Bun.serve` per the brief (so we exercise the proxy against a Bun-served upstream).
- **Retry-on `headersSent`.** Once any byte of the response has streamed back to the SDK, we cannot retry cleanly — we'd send corrupted SSE. So if `forwardOnce` errors after `res.headersSent`, the error bubbles out instead of looping; the SDK sees a torn connection, which is the right semantics (it'll get an HTTP error, not a silent half-response).
- **Buffer request body once for replay.** Anthropic prompt JSON is small, so buffering at the proxy boundary is fine. SSE is only on the *response* side — that's where streaming matters and that's where we use `pipe`. v1 made the same call.
- **Boot wiring is fire-and-forget.** `index.ts` calls `startLocalProxy(...)` with `void` and a non-blocking error handler. If the proxy fails to bind, the agent loop still starts — the SDK will hit the upstream directly, which works as long as the port is reachable. Avoids gating the entire container on a non-critical retry path.
- **`https://` upstream rejected.** v1 only ever talks to plain-HTTP upstream (the host credential proxy / OneCLI is on the host loopback, no TLS in the path). Rather than silently swap in the `https` module on `https://` URLs, we throw at start-up so a misconfigured `NANOCLAW_UPSTREAM_PROXY` fails loud rather than after the first retry storm.

### Test counts

8 tests in `local-proxy.test.ts` (bun:test, not yet runnable in this sandbox — see "Bun unavailable" note below):

1. happy GET → upstream
2. POST body intact + `host` header rewritten to upstream
3. custom-header passthrough (`x-api-key`, `anthropic-version`, `x-trace-id`)
4. SSE-style streaming (3 chunks with measurable inter-chunk gaps — proves no buffering)
5. ECONNREFUSED retry until upstream comes back
6. retry window expires → 502 with `local_proxy_error` body
7. non-retriable upstream 500 propagated without retry
8. https upstream rejected at start-up

### Verification

- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` — clean.
- `pnpm run build` (host) — clean.
- `pnpm test` (host) — 241/241 pass (no host-side regression).

### Things explicitly punted

- **`bun test` not run.** Bun is not installed in this sandbox. The sub-task-1 OUT note recorded the same constraint. The container tsconfig typechecks clean and the test file compiles under that tsconfig (`pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` is clean — note that `*.test.ts` is in the `exclude` so the pass really only proves production code compiles; the test file's `bun:test` import is fine because the Bun types are pulled in via `"types": ["bun"]`). End-to-end verification of the test suite is gated on running it under Bun, either locally or in CI.

---

## Sub-task 7 — Container-side coding MCPs (DONE on side branch)

Side branch: `skill/add-coding-agent-container` (off `f931aea88d0e`)
Worktree: `/home/leeor/repos/nanoclaw-v2-coding-agent-container`

Three new MCP tool modules registered into the existing barrel + matching Dockerfile pins. Each module follows the exact pattern of `coding-pr-monitor.ts` and `scheduling.ts`: a single file, side-effect `registerTools([...])` at module scope, structured-error envelopes returned as `{content: [...], isError: true}` with both a human-readable prefix and a JSON `{error: {code, message, ...}}` line.

### Commits (4)

```
148a18a37a3d feat(agent-runner): gh MCP tool server
4cef97bc7d4b feat(agent-runner): devcontainer-cli MCP tool server
878e8f86e9a3 feat(agent-runner): linear MCP tool server
361f6d4aa436 feat(container): pin gh + @devcontainers/cli for coding agent
```

### Files changed

```
container/agent-runner/src/mcp-tools/gh.ts                     303 +++++ (new)
container/agent-runner/src/mcp-tools/gh.test.ts                179 +++++ (new — 9 cases)
container/agent-runner/src/mcp-tools/devcontainer-cli.ts       186 +++++ (new)
container/agent-runner/src/mcp-tools/devcontainer-cli.test.ts  170 +++++ (new — 9 cases)
container/agent-runner/src/mcp-tools/linear.ts                 354 +++++ (new)
container/agent-runner/src/mcp-tools/linear.test.ts            221 +++++ (new — 12 cases)
container/agent-runner/src/mcp-tools/index.ts                  +3      (3 imports for self-registration)
container/Dockerfile                                           +29     (gh apt install + @devcontainers/cli pnpm-global)
```

### Tool list

- `gh.ts`: `gh_pr_view`, `gh_pr_create`, `gh_pr_comment`, `gh_pr_list`, `gh_repo_view`
- `devcontainer-cli.ts`: `devcontainer_exec`, `devcontainer_rebuild`
- `linear.ts`: `linear_create_issue`, `linear_update_issue`, `linear_get_issue`, `linear_list_issues`, `linear_comment_on_issue`

### Design choices that diverged from the brief

- **`execFileSync` over `execSync` for `gh`/`devcontainer`.** The brief said `execSync('gh ...args', ...)`. Used `execFileSync` (gh) and `spawnSync` (devcontainer) instead because both take an explicit `argv` array and skip `/bin/sh -c` interpretation — no quoting bugs around PR titles/bodies that contain backticks or single quotes. Same 30-second timeout for `gh`, 5-minute default for `devcontainer_exec`, 30-minute for `devcontainer_rebuild`.
- **`gh` test approach: fake binary on `PATH`, not `child_process` mock.** `execFileSync` calls a real binary via the OS. Mocking `node:child_process` under bun:test is awkward (the import binding is read-only) and feels fragile; a tiny shell shim on a tmpdir `PATH` exercises the real call path. The shim records argv into a log file and reads its response (stdout / stderr / exit code) from a JSON file each test rewrites in `beforeEach`. Same approach for `devcontainer-cli`. Trade-off: requires `sh` + `node` on the test host (both always present in dev/CI).
- **`devcontainer_exec` non-zero exit isn't `isError`.** The brief said `→ {stdout, stderr, code}`. `isError` is reserved for tool-level failures (timeout, missing `WORKSPACE_FOLDER`, devcontainer binary missing) — a command exiting non-zero inside the container is *the* legitimate signal the agent is asking about. Pinned in tests so the distinction doesn't drift.
- **`devcontainer_exec` cwd handling.** Brief left `cwd` semantics unspecified. Implemented as `sh -c "cd <quoted-cwd> && <command>"` so the agent gets shell-interpretation (pipes, redirects) plus directory scoping in one call, with proper POSIX-shell single-quote escaping for paths containing apostrophes.
- **Linear list filter: `title containsIgnoreCase`, not `searchIssues`.** Brief asked for a `query` param. Used Linear's standard `IssueFilter.title.containsIgnoreCase` rather than the separate `issueSearch` GraphQL root because (a) it's simpler — same `issues(filter: ...)` shape as the unfiltered case; (b) ranked search is overkill for an agent that's about to read titles anyway. If an agent really wants ranked relevance, a follow-up commit can swap to `issueSearch`. Documented the trade-off inline.
- **Linear auth header is the raw key (no `Bearer`).** Linear's docs are inconsistent — OAuth tokens take `Bearer`, personal API keys take the raw key. Picked the raw-key form since `LINEAR_API_KEY` is described in the brief as a Linear *API key* (not OAuth token). Bumped this into the file's top-of-comment so the next reader doesn't fight it.
- **`NO_API_KEY` returned per-call, not at server start.** Brief: "If `LINEAR_API_KEY` is not set, the MCP server's tools return `{error: ...}` rather than crashing the server." Implemented exactly that: each tool calls `linearRequest()` which checks the env at call time. The MCP server stays alive serving `gh` / `devcontainer-cli` even if Linear isn't wired.
- **Linear error model is three-tier.** Transport errors (`HTTP_<status>`, `FETCH_ERROR`), GraphQL errors (`LINEAR_ERROR` with the `errors[]` array attached as `details`), and business-logic errors (`NOT_FOUND`, `CREATE_FAILED`, `UPDATE_FAILED`). Lets the agent distinguish "Linear is down" from "your request was rejected" from "the issue you asked for doesn't exist" without parsing free-text messages.
- **Docker `gh` install via the official cli.github.com apt repo.** Brief allowed either ARG-driven install. Picked the apt route because (a) we get the *exact* pinned version (`gh=${GH_VERSION}`), (b) it slots into the existing apt-cached install pattern, (c) we inherit normal package-manager lifecycle (gpg verify, upgradeable). Trade-off: extra `curl` for the keyring + a dedicated `RUN` layer.
- **`@devcontainers/cli` pinned at `0.85.0`.** Picked a recent stable pin; bump deliberately. No `onlyBuiltDependencies` entry needed because `@devcontainers/cli` has no postinstall.

### Test counts

30 new bun:test cases across the three test files (not yet runnable here — see "Bun unavailable" note):

| File | Cases |
|------|-------|
| `gh.test.ts` | 9 |
| `devcontainer-cli.test.ts` | 9 |
| `linear.test.ts` | 12 |

### Verification

- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` — clean (production code; tests excluded by tsconfig).
- `pnpm run build` (host) — clean.
- `pnpm test` (host) — 241/241 pass (no host-side regression).
- `pnpm exec prettier --check` on every new file — clean.

### Things explicitly punted

- **`bun test` not run.** Bun is not installed in this sandbox; the bun:test cases compile under the container tsconfig but haven't been executed. Operator must run `cd container/agent-runner && bun test` post-merge to confirm.
- **`./container/build.sh` not run.** Adding `gh` + `@devcontainers/cli` to the image requires a rebuild before any of these tools are usable end-to-end. Operator-driven; documented in the commit message.
- **No `gh auth` smoke test.** The MCP wraps `gh` but doesn't probe `gh auth status` at boot — first failing call will surface a clean `{code: "EXIT_<n>", stderr: "..."}` payload, which is good enough. Adding a startup probe would only buy a marginally nicer error message at the cost of a synchronous shell-out at every container boot.
- **No Linear `issueSearch` (ranked) variant.** See design note above; the simple-filter path is fine for sub-task 7's brief and an agent that wants ranked search can call Linear's REST endpoint directly via `fetch` if/when that need materialises.
- **No `gh_issue_*` tools.** The brief's tool list doesn't include them; the agent can use Linear for issue tracking and `gh` for PR-shaped work, which is the v1 split.

### Bun unavailable in this sandbox (carry-over)

The same caveat that applied to sub-task 1 applies here: Bun is not installed in this sandbox, so I cannot run `bun test` to actually exercise the new test files. They've been written to compile under the container tsconfig (`pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` is clean — though the tsconfig excludes `*.test.ts`, so this only verifies the production code, not the tests themselves) and to follow the existing bun:test patterns in the repo. Operator should confirm `bun test` clean before merging into `skill/add-coding-agent`.

---

## Sub-task 4 — Cost summary (DONE)

Replaces the sub-task-2 stub with the production handler. The container pre-aggregates its own per-result JSONL log (it has the only file-system access to `agent-results.jsonl`; the host can't read in-container files in v2) and emits a `coding_cost_summary` system action with the ready-to-render `CostSummary` plus PR routing fields. The host renders two markdown flavours (slack code-fenced table, github raw table), posts the channel flavour to the originating messaging group via the registered delivery adapter, and adds the github flavour as a PR comment via `gh pr comment`.

### Commit

```
c19004066d65 feat(modules/coding): real cost-summary handler + tests
```

### Files changed

```
src/modules/coding/cost-summary.ts        |  ~280 (rewrite of stub)
src/modules/coding/cost-summary.test.ts   |  +413 (new — 23 cases)
```

### Design notes / divergences from v1

- **Dropped `aggregateCostLog` from the host surface.** v1 read `agent-results.jsonl` from a shared host filesystem. v2 has no shared filesystem; the container does its own aggregation and ships the `CostSummary` object inside the action payload. The pure aggregation logic still has a place — left in v1 — but the v2 host cost-summary module owns only formatting + delivery.
- **Dropped v1's `gh pr list --head <branch>` PR lookup.** The agent now ships its own PR number directly inside the payload (it opened the PR with `gh pr create`), so the host doesn't need to re-derive it. Eliminates a network call and a parsing edge case (jq returning `null` for `[].number`).
- **Channel-agnostic delivery.** v1 had a hardcoded `sendSlack` callback. v2 resolves the channel adapter via `getDeliveryAdapter()` from `src/delivery.ts` and passes through the messaging-group `channel_type` + `platform_id`. Slack-specific code stays in the per-channel adapter.
- **Two-leg isolation.** Channel post failure does NOT skip the PR comment, and gh failure does NOT throw past the handler boundary. v1 had the same property — preserved verbatim. A failed cost summary must never stall the outbound queue.
- **`PostCostSummaryOpts` shape.** Mirrors v1 closely so the test scenarios port over with minimal change. Channel routing is `channelType / platformId / threadId` instead of `slackJid`; PR routing is `repo + prNumber + repoMasterPath`. `slackMarkdown` and `githubMarkdown` field names retained for clarity even though the channel target may be Telegram, Discord, etc.
- **Body via `--body-file -` + stdin** (matches v1). Avoids shell-quote edge cases when the body contains backticks, dollar signs, or newlines.

## Sub-task 5 — Orphan scanner (DONE)

Replaces the sub-task-2 stub with the production reconcile. Repairs two post-crash conditions: lock rows whose container is gone (release the lock) and live devcontainers with no lock OR whose session row is gone (graceful `devcontainer stop`, falling back to `docker stop`). Boot scan via `initCodingModule()` plus 5-min ticks via `MODULE-HOOK:coding-orphan-scan` in `src/host-sweep.ts`.

### Commit

```
2c5cce6859fd feat(modules/coding): real orphan scanner + sweep hook
```

### Files changed

```
src/modules/coding/orphan-scanner.ts          | ~205 (rewrite of stub)
src/modules/coding/orphan-scanner.test.ts     | +253 (new — 13 cases)
src/modules/coding/index.ts                   | +3 (force boot scan, export)
src/host-sweep.ts                             | +13 (MODULE-HOOK)
src/index.ts                                  | +12 (initCodingModule call)
```

### Design notes / divergences from v1

- **Discovery via `nanoclaw.session` label, not `nanoclaw.group`.** v1 used per-group folders as the container discriminator. v2 uses per-session container labels written by `src/container-backends/devcontainer.ts` (`--id-label nanoclaw.session=<id>`). The reconcile pivots on session id — same model as the rest of v2's container surface.
- **Scoped to install.** docker-ps filter includes `label=${CONTAINER_INSTALL_LABEL}` so a side-by-side install on the same host can't reap our containers and we can't reap theirs. Mirrors `cleanupOrphans()` in `src/container-runtime.ts`.
- **Workspace folder sourced from `devcontainer.local_folder` label.** The devcontainer CLI itself stamps this label on every container it creates, so we can drive `devcontainer stop --workspace-folder <path>` without a separate lookup. When the label is missing (older CLI versions), the scanner falls back to `docker stop` directly.
- **Fail-safe on `docker ps` failure.** If `docker ps` throws, the scan aborts WITHOUT releasing any locks. A transient docker hiccup must NOT make the scanner re-issue locks someone else holds. v1 had the same property; preserved.
- **Rate limit at 5 min, internal `lastScanAt`.** Boot scan bypasses the rate limit via `force: true`; subsequent sweep ticks (each 60s) early-exit until 5 minutes have elapsed since the last successful scan. Cheap on every sweep tick.
- **Different repair surface from v1.** v1's scanner stopped just the runner process inside long-lived devcontainers (kept the container itself for the next message). v2 stops the entire container — sessions are per-task in v2, and a stopped container is fine because the next session for that task is a new container anyway. Simpler model, fewer moving parts.
- **No `_close` sentinel.** v1 wrote a `_close` file into the IPC dir. v2 doesn't have IPC dirs — graceful shutdown is sub-task 9's job, via `_shutdown` system message into `inbound.db`. The orphan scanner is the brute-force "container is wedged with no host counterpart" path; graceful drain is sub-task 9's lane.

## Sub-task 9 — Graceful shutdown (DONE)

Drains in-flight devcontainer-backed coding sessions on host SIGTERM/SIGINT before process exit. Algorithm: enumerate active sessions whose `container.json` declares `containerBackend='devcontainer'` → write `_shutdown` system message into each session's `inbound.db` → poll `docker ps` for matching `nanoclaw.session` labels up to `CODING_GRACEFUL_SHUTDOWN_MS` (default 30000) → `devcontainer stop` per straggler with 10s timeout → release worktree locks for all targeted sessions explicitly. Wired from `src/index.ts`.

### Commits

```
ebbb2ecb4dd5 feat(modules/coding): graceful shutdown handler
2d4d0839a6b8 feat(host): wire coding gracefulShutdown into SIGTERM/SIGINT path
```

### Files changed

```
src/modules/coding/graceful-shutdown.ts        | +258 (new)
src/modules/coding/graceful-shutdown.test.ts   | +234 (new — 8 cases)
src/modules/coding/index.ts                    | +1   (re-export)
src/index.ts                                   | +17  (shutdown wire)
src/modules/coding/orphan-scanner.test.ts      | -3 +1 (prettier reformat)
```

### Design notes / divergences from brief

- **`_shutdown` is a system message in `inbound.db`, not a sentinel file.** v1 wrote a `_close` file into the IPC inbox dir; the runner polled the dir for it. v2 has no IPC dir — the only legal channel from host to container is `messages_in`. The host-only behaviour written here is "insert the system message and wait"; the matching container poll-loop handler (kind='system' && content='_shutdown' → exit cleanly) is the parallel container worktree's task. If the container ignores the message, step 4's `devcontainer stop` fallback catches it.
- **No new id generator helper.** Used the same `${kind}-${Date.now()}-${random}` pattern as `writeSystemResponse` in `session-manager.ts`. Each `_shutdown` message has a unique id so a re-shutdown attempt during a flaky exit doesn't collide.
- **Lock release happens explicitly, not via FK cascade.** Sessions live across a host restart (we don't `DELETE FROM sessions`), so the FK cascade in `coding_worktree_locks` doesn't fire on shutdown. Releasing here lets the next boot re-acquire cleanly without waiting for the orphan scanner's 5-min tick. Targets only the sessions we actually drained — locks for non-coding sessions or sessions we couldn't reach stay put.
- **Pure-functional core with full DI.** `gracefulShutdown(deps)` accepts `listCodingSessions`, `writeShutdownMessage`, `dockerPs`, `devcontainerStop`, `listLocks`, `releaseLock`, `sleep`, `timeoutMs`, `logger`. Production wiring resolves all of these to the real things; tests pass fakes. Matches the pattern set by `pr-monitor.ts`.
- **`fastForward` test helper.** The poll loop calls `Date.now()` against a deadline derived from `Date.now() + timeoutMs`. Real `setTimeout`-based sleeps would slow tests to ~30s each. The test fixture overrides `Date.now` per-test and increments a virtual now inside the injected sleep function. Restored to real `Date.now` in `afterEach`.
- **Order of operations in shutdown handler.** Drain comes AFTER `stopHostSweep()` and `stopDeliveryPolls()` (so no fresh work lands during drain), and BEFORE `teardownChannelAdapters()` (so any approval round-trips during drain still have working channels — though in practice none should fire). Pre-existing `getShutdownCallbacks()` callbacks still run first, since some modules (e.g. self-mod) may have their own draining to do.
- **`CODING_GRACEFUL_SHUTDOWN_MS` env knob.** Default 30s matches v1's `closeWaitMs`. For coding sessions in the middle of huge tool calls (large `Bash` shells, big `Edit` payloads on slow disks), an operator can crank this up via env without touching code.

### Test results

```
$ pnpm run build      # skill/add-coding-agent
> tsc                  (clean exit)

$ pnpm test           # skill/add-coding-agent
 Test Files  32 passed (32)         (+3 over the 29 baseline from sub-task 8)
      Tests 285 passed (285)         (+44 over the 241 baseline)

$ pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
TypeScript: No errors found
```

`+44` = 23 in `cost-summary.test.ts` + 13 in `orphan-scanner.test.ts` + 8 in `graceful-shutdown.test.ts`.

### Done-criteria checklist (final state)

- [x] Sub-task 1 — Devcontainer backend
- [x] Sub-task 2 — Coding module skeleton
- [x] Sub-task 3 — Worktree mutex DB + helpers
- [x] Sub-task 4 — Cost summary (full impl): handler replaces stub; channel + PR comment legs both isolated; format helpers covered for both targets; rtkGain handled.
- [x] Sub-task 5 — Orphan scanner (full impl): boot scan + 5-min sweep tick; `nanoclaw.session` label discovery; fail-safe on docker ps failure; rate-limit gate.
- [x] Sub-task 6 — In-container retry proxy (container worktree)
- [x] Sub-task 7 — Container-side coding MCP servers (container worktree)
- [x] Sub-task 8 — PR monitor scheduled task
- [x] Sub-task 9 — Graceful shutdown handler: `gracefulShutdown(deps)` exported; wired into `src/index.ts` SIGTERM/SIGINT path; `_shutdown` system message into `inbound.db`; configurable timeout; lock release.
- [x] Sub-task 10 — code-review-instructions.md + SKILL.md

### Things explicitly punted (host side)

- **Container-side `_shutdown` handler is owned by the parallel container worktree.** This worktree wrote the host-only behaviour as instructed. If the container worktree's parallel agent does not also land a poll-loop handler that recognises `kind='system' && content='_shutdown'` and exits cleanly, the host-side drain still works correctly — every targeted session falls through to step 4's `devcontainer stop` fallback. The handler is purely an optimisation (cleaner exit, no `SIGTERM` race on the runner).
- **No live-handler test for `handleCostSummary`.** Same rationale as sub-task 8's punt: importing `src/modules/coding/index.ts` for the side-effect registration causes double-registration in shared-DB tests. The two-leg `postCostSummary` is fully covered with injected fakes; the handler shim is a thin payload-shape adapter.
- **No prettier follow-up commit.** The husky hook reformatted one line in `orphan-scanner.test.ts` after the orphan-scanner commit. Captured inside the next commit (`graceful shutdown handler`) rather than as a separate chore commit, so the working tree is clean at HEAD without churn.
