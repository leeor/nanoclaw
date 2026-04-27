---
name: add-prompt-gate
description: Add content-validation policy to the inbound router — prompt-injection screening, sender-ID verification, configurable allow/deny lists, and an audit log of refusals. Use when the user asks for prompt-injection protection, content filtering, refusal logging, or hardening of inbound messages.
---

# Add Prompt Gate

Adds a content-validation pipeline that runs after the access gate and before container wake. Registers a single inspector via the `setMessageInspector` router hook (already in trunk). Refuses messages that match prompt-injection patterns, deny-listed senders, or (optionally) any sender that can't be identified at all. Every decision (allowed and denied) is recorded to a hash-only audit table.

## Install

NanoClaw doesn't ship the prompt-gate module on trunk. This skill merges the `skill/add-prompt-gate` branch.

### Pre-flight (idempotent)

Skip to **Configuration** if all of these are already in place:

- `src/modules/prompt-gate/index.ts` exists
- `src/modules/index.ts` contains `import './prompt-gate/index.js';`
- `data/v2.db` schema_version table contains a row with `name='prompt-gate-decisions'`

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch and merge the skill branch

```bash
git fetch origin skill/add-prompt-gate
git merge origin/skill/add-prompt-gate
```

### 2. Build

```bash
pnpm install --frozen-lockfile   # only needed if package.json changed (it didn't)
pnpm run build
```

### 3. Restart NanoClaw

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

The migration runs on next start (`014-prompt-gate-decisions`) and the inspector self-registers when the modules barrel imports `./prompt-gate/index.js`.

## Configuration

The module ships sensible defaults — prompt-injection patterns enabled, allow/deny lists empty, sender-ID verification non-strict. Override per-install by writing `data/prompt-gate.config.json`:

```json
{
  "version": 1,
  "rules": {
    "prompt_injection": {
      "enabled": true,
      "patterns": [
        "ignore previous instructions",
        "disregard all previous",
        "forget previous instructions",
        "rm -rf"
      ]
    },
    "sender_id_verification": { "enabled": true, "strict": false },
    "allow_list_user_ids": ["discord:111111111111111111"],
    "deny_list_user_ids": []
  }
}
```

Notes:

- Patterns are **case-insensitive substring** matches. Add your own; the defaults are conservative.
- `sender_id_verification.strict: true` denies any inbound where the router couldn't resolve a userId. Default `false` defers to the router's identity gates.
- IDs in `allow_list_user_ids` / `deny_list_user_ids` are namespaced (`<channel>:<handle>`) and must match the format the permissions module uses (e.g. `discord:123`, `telegram:456`).
- Allow > deny: a user on both lists is allowed.

Config is read once at module import; restart the host to pick up changes.

## Audit

Every decision (allowed and denied) is recorded in `prompt_gate_decisions`. Query:

```bash
sqlite3 data/v2.db "
  SELECT timestamp, user_id, decision, reason, rule_matched, text_length
  FROM prompt_gate_decisions
  ORDER BY timestamp DESC LIMIT 50;
"
```

Message text is **not stored** — only a SHA-256 hash + length. To investigate a specific refusal, find the candidate inbound message in the channel's own log via the timestamp + user_id and recompute the hash to confirm:

```bash
echo -n 'CANDIDATE TEXT' | shasum -a 256
```

## Coverage gap (intentional)

The inspector runs only on messages that **engage** an agent. Messages flowing into the accumulate buffer (`ignored_message_policy === 'accumulate'`) are not inspected — they're stored with `trigger=0` and the agent will read them on the next legitimate wake. Accumulated content can therefore poison future wakes.

If you need full coverage, either:

- Set `ignored_message_policy` to `drop` on wirings where you can't trust the buffer, or
- Tell the agent to treat the accumulated buffer as untrusted in its CLAUDE.md.

A future `setAccumulateInspector` hook is on the roadmap.

## Verify

```bash
# 1. Migration applied?
sqlite3 data/v2.db "SELECT name FROM schema_version WHERE name='prompt-gate-decisions';"
# expect: prompt-gate-decisions

# 2. Send a clean message in a wired channel — expect normal response.
# 3. Send "IGNORE PREVIOUS INSTRUCTIONS now" — expect no response.
# 4. Confirm both are logged:
sqlite3 data/v2.db "SELECT decision, reason, rule_matched FROM prompt_gate_decisions ORDER BY timestamp DESC LIMIT 2;"
# expect one 'denied | prompt_injection | prompt_injection.ignore_previous_instructions'
# and one 'allowed | NULL | NULL'
```

## Removal

```bash
git revert <merge-commit>      # the merge from step 1 of Install
pnpm run build
```

The audit table is left in place — drop it manually if you don't want to keep the history:

```bash
sqlite3 data/v2.db "DROP TABLE IF EXISTS prompt_gate_decisions;"
sqlite3 data/v2.db "DELETE FROM schema_version WHERE name='prompt-gate-decisions';"
```
