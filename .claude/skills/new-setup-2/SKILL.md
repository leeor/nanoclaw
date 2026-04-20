---
name: new-setup-2
description: Follow-on to /new-setup. Captures the operator and agent names, wires a real messaging channel, and adds quality-of-life extras. Linear rollthrough; every step is skippable. Invoked when the user picks "continue setup" at the end of /new-setup.
allowed-tools: Bash(bash setup/probe.sh) Bash(bash setup/install-telegram.sh:*) Bash(pnpm exec tsx setup/index.ts:*) Bash(pnpm exec tsx scripts/init-first-agent.ts:*) Bash(tail:*) Bash(head:*) Bash(grep:*)
---

# NanoClaw phase-2 setup

Runs after `/new-setup`. At this point the host is running and a throwaway CLI-only agent exists (used during /new-setup for the end-to-end ping check — inferred name, not user-facing). This flow creates the **real** agent and wires it to a messaging channel.

**Linear — one step at a time.** Every step is skippable: if the user says "skip", "not now", "later", or similar, move on without complaint. If they say they're done at any point, stop cleanly — don't push the remaining steps.

Before each step, narrate in your own words what's about to happen — one short, friendly sentence, no jargon. Match the tone of `/new-setup`.

## Current state

!`bash setup/probe.sh`

Parse the probe block above for `INFERRED_DISPLAY_NAME` and `PLATFORM` — referenced below.

## Steps

### 1. What should the agent call you?

Plain-prose ask (do **not** use `AskUserQuestion`):

> What should your agent call you? (Default: `<INFERRED_DISPLAY_NAME>`)

Capture the answer into a local variable `OPERATOR_NAME`. **Don't persist yet** — this value is consumed by step 3's channel wiring. If the user skips or confirms the default, set `OPERATOR_NAME = INFERRED_DISPLAY_NAME`.

### 2. What's your agent's name?

Plain-prose ask:

> What would you like to call your agent? (Default: `<OPERATOR_NAME>`)

Capture as `AGENT_NAME`. If skipped, set `AGENT_NAME = OPERATOR_NAME`. Nothing persisted yet.

### 3. Timezone

Run `pnpm exec tsx setup/index.ts --step timezone` and parse the status block.

- **RESOLVED_TZ is `UTC` or `Etc/UTC`** — before leaving UTC in `.env`, confirm with the user in plain prose:

  > Your system reports UTC as the timezone. Is that actually right, or are you somewhere else? If elsewhere, tell me the IANA zone (e.g. `America/New_York`, `Europe/London`, `Asia/Tokyo`). Skip to keep UTC.

  If they name a different IANA timezone, re-run `pnpm exec tsx setup/index.ts --step timezone -- --tz <answer>` to overwrite `.env`. If they skip, leave UTC in place — nothing else to do.

- **NEEDS_USER_INPUT=true** — autodetection failed. Ask for an IANA timezone (e.g. `America/New_York`, `Europe/London`, `Asia/Tokyo`), then re-run `pnpm exec tsx setup/index.ts --step timezone -- --tz <answer>`. If they skip, move on.

- Otherwise — timezone is already set; move on.

### 4. Pick a messaging channel

Print the list as plain prose. **Do not use `AskUserQuestion` for this step** — just the list, then wait for the user's reply:

> Which messaging channel should I wire your agent to?
>
> - **WhatsApp (native)** — `/add-whatsapp`
> - **WhatsApp Cloud (Meta official)** — `/add-whatsapp-cloud`
> - **Telegram** — `/add-telegram`
> - **Slack** — `/add-slack`
> - **Discord** — `/add-discord`
> - **iMessage** — `/add-imessage`
> - **Teams** — `/add-teams`
> - **Matrix** — `/add-matrix`
> - **Google Chat** — `/add-gchat`
> - **Linear** — `/add-linear`
> - **GitHub** — `/add-github`
> - **Webex** — `/add-webex`
> - **Resend (email)** — `/add-resend`
> - **Emacs** — `/add-emacs`
>
> Or say "skip" to leave this for later.

When the user picks one:

1. **Install the adapter.** For **Telegram**, run `bash setup/install-telegram.sh` directly — it bundles the preflight + fetch + copy + register + `pnpm install` + build from `/add-telegram` into one idempotent call, then continue with credentials and pairing (invoke `/add-telegram` afterwards and its preflight will skip straight to Credentials). For every other channel, invoke the matching `/add-<channel>` skill via the Skill tool; it copies the adapter source in from the `channels` branch, registers it, installs the pinned npm package, and handles credentials. Some channels also run a pairing step as part of their flow.
2. **Capture platform IDs.** After the `/add-<channel>` skill finishes, you need two values: the operator's user-id on that platform, and the chat/channel platform-id. Each channel surfaces these differently — consult the **Channel Info** section at the bottom of that skill's `SKILL.md` for the exact path. For Telegram, for example, the `pair-telegram` step emits `PLATFORM_ID` and `ADMIN_USER_ID` in a status block once the user sends the 4-digit code.
3. **Wire the agent.** Run `init-first-agent.ts` in DM mode with `--no-cli-bonus` (this keeps the new agent off the CLI messaging group so the pre-existing throwaway agent still owns CLI routing cleanly):

   ```
   pnpm exec tsx scripts/init-first-agent.ts \
     --channel <channel> \
     --user-id "<platform-user-id>" \
     --platform-id "<platform-chat-id>" \
     --display-name "<OPERATOR_NAME>" \
     --agent-name "<AGENT_NAME>" \
     --no-cli-bonus
   ```

4. **Announce.** On success, emit the encouragement line verbatim:

   > Your agent is now available on {channel-name}, you can already start chatting — But I encourage you to continue and finish this setup, we're almost done!

   Substitute `{channel-name}` with the friendly name (e.g. "Telegram", "WhatsApp", "Slack").

If the user skipped, move on to step 5.

### 5. Quality of life

Optional polish. Print the list; the user may pick zero, one, or several — invoke each chosen skill in sequence:

> Want to add any of these? Pick any that sound useful — or skip:
>
> - `/add-dashboard` — browser dashboard showing agent activity
> - `/add-compact` — `/compact` slash command for managing long sessions
> - `/add-karpathy-llm-wiki` — persistent knowledge-base memory for the agent

If the probe reports `PLATFORM=darwin`, also offer:

> - `/add-macos-statusbar` — macOS menu bar indicator with Start/Stop/Restart controls

Do **not** list `/add-macos-statusbar` on Linux. If the user skips everything, just move on.

### 6. Done

Short wrap-up:

> Setup complete. You can chat with your agent on {channel-name} — or via CLI with `pnpm run chat <message>`.

Substitute `{channel-name}` with whatever was wired in step 4. If step 4 was skipped, drop the "on {channel-name} — or" clause entirely so the line just mentions the CLI form.

## If anything fails

Same rule as `/new-setup`: don't bypass errors to keep moving. Read `logs/setup.log` or `logs/nanoclaw.log`, diagnose, fix the underlying cause, re-run the failed step.
