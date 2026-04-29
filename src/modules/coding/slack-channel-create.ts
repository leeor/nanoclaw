/**
 * Per-task Slack channel creation for coding tasks.
 *
 * Used by `handleCreateCodingTask` when the parent agent is wired to a Slack
 * channel. Mirrors v1 behavior: creates `coding-<ticket-lower>`, joins the
 * bot, invites the supplied user IDs (typically the owner), and reuses an
 * archived channel of the same name when present.
 *
 * Talks to Slack via `@slack/web-api` directly using `SLACK_BOT_TOKEN` from
 * `.env`. Bypasses the @chat-adapter/slack abstraction because that package
 * does not expose channel creation. The bot needs `channels:manage` and
 * `channels:invite` (private channels: `groups:write`, `groups:write.invites`)
 * scopes — without them the create / invite calls return a Slack error
 * which the caller surfaces back to the parent agent.
 */
import { WebClient } from '@slack/web-api';

import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';

export interface CodingTaskChannelOptions {
  /** Channel name. Will be sanitized to lowercase a-z 0-9 and `-`, max 80 chars. */
  name: string;
  /** Raw Slack user IDs to invite (without `slack:` prefix). */
  inviteUserIds: string[];
}

export interface CodingTaskChannelResult {
  channelId: string;
  channelName: string;
  reused: boolean;
}

function sanitize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

export async function createSlackChannelForCodingTask(
  opts: CodingTaskChannelOptions,
): Promise<CodingTaskChannelResult> {
  const env = readEnvFile(['SLACK_BOT_TOKEN']);
  if (!env.SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN not set');
  const client = new WebClient(env.SLACK_BOT_TOKEN);
  const sanitized = sanitize(opts.name);
  if (!sanitized) throw new Error('coding-task channel name is empty after sanitization');

  let channelId: string;
  let channelName: string;
  let reused = false;

  try {
    const r = await client.conversations.create({ name: sanitized, is_private: false });
    if (!r.channel?.id) throw new Error('Slack conversations.create returned no channel id');
    channelId = r.channel.id;
    channelName = r.channel.name ?? sanitized;
  } catch (e) {
    const slackErr = e as { data?: { error?: string } };
    if (slackErr?.data?.error !== 'name_taken') throw e;

    // Reuse existing channel of the same name (unarchive if needed).
    let cursor: string | undefined;
    let found: { id?: string; name?: string; is_archived?: boolean } | undefined;
    do {
      const r = await client.conversations.list({
        types: 'public_channel,private_channel',
        exclude_archived: false,
        limit: 200,
        cursor,
      });
      found = r.channels?.find((c: { name?: string }) => c.name === sanitized);
      if (found) break;
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor);

    if (!found?.id) throw new Error(`Slack name_taken but channel "${sanitized}" not found in list`);
    if (found.is_archived) {
      await client.conversations.unarchive({ channel: found.id });
    }
    channelId = found.id;
    channelName = found.name ?? sanitized;
    reused = true;
  }

  // Bot joins (idempotent — already a member if we created it).
  try {
    await client.conversations.join({ channel: channelId });
  } catch (e) {
    const err = e as { data?: { error?: string } };
    if (err?.data?.error && err.data.error !== 'method_not_supported_for_channel_type') {
      log.warn('Slack conversations.join failed', { channelId, error: err.data.error });
    }
  }

  // Invite users (best-effort).
  if (opts.inviteUserIds.length > 0) {
    try {
      await client.conversations.invite({
        channel: channelId,
        users: opts.inviteUserIds.join(','),
      });
    } catch (e) {
      const err = e as { data?: { error?: string } };
      const code = err?.data?.error;
      if (code && !['already_in_channel', 'cant_invite_self', 'cant_invite'].includes(code)) {
        log.warn('Slack conversations.invite warning', { channelId, error: code });
      }
    }
  }

  return { channelId, channelName, reused };
}
