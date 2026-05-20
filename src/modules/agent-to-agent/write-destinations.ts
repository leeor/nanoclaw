/**
 * Project the agent's central `agent_destinations` rows into its per-session
 * `inbound.db` so the running container can resolve names locally. Called on
 * every container wake and after admin-time destination edits (e.g. create_agent).
 *
 * Core container-runner calls this via a dynamic import guarded by a
 * `hasTable('agent_destinations')` check — without the agent-to-agent module
 * installed, the central table doesn't exist and the projection is skipped.
 */
import fs from 'fs';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { replaceDestinations, type DestinationRow } from '../../db/session-db.js';
import { log } from '../../log.js';
import { inboundDbPath, openInboundDb } from '../../session-manager.js';
import { getDestinations } from './db/agent-destinations.js';

export function writeDestinations(agentGroupId: string, sessionId: string): void {
  const dbPath = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return;

  // Role-based filtering (migration 015). user_facing agents never project
  // worker destinations into their map — they have no business writing
  // <message to="ancr-..."> in response to a user message; coding work is
  // dispatched via the create_coding_task MCP tool. Worker agents never
  // project user_facing destinations either — their replies go through
  // their own channel. This keeps the model from "seeing" destinations
  // the routing layer would refuse anyway.
  const sourceAgent = getAgentGroup(agentGroupId);
  const sourceRole = sourceAgent?.role ?? 'user_facing';

  const rows = getDestinations(agentGroupId);
  const resolved: DestinationRow[] = [];

  // Prepend a `main` destination for the session's primary messaging group.
  // Without this, when the agent has 2+ explicit destinations the prompt
  // addendum forces every reply into a `<message to="...">` block — leaving no
  // way to address the originating user, and the agent picks an arbitrary
  // (often coding-task) destination instead. The `main` entry gives every
  // session a stable target for replies to the human regardless of how many
  // sibling agents are wired.
  const session = getSession(sessionId);
  if (session?.messaging_group_id) {
    const mg = getMessagingGroup(session.messaging_group_id);
    if (mg) {
      resolved.push({
        name: 'main',
        display_name: mg.name ?? 'main',
        type: 'channel',
        channel_type: mg.channel_type,
        platform_id: mg.platform_id,
        agent_group_id: null,
      });
    }
  }

  for (const row of rows) {
    if (row.target_type === 'channel') {
      const mg = getMessagingGroup(row.target_id);
      if (!mg) continue;
      resolved.push({
        name: row.local_name,
        display_name: mg.name ?? row.local_name,
        type: 'channel',
        channel_type: mg.channel_type,
        platform_id: mg.platform_id,
        agent_group_id: null,
      });
    } else if (row.target_type === 'agent') {
      const ag = getAgentGroup(row.target_id);
      if (!ag) continue;
      // Role gate (mirrors agent-route.ts rejection paths):
      //   - user_facing source never sees agent destinations at all
      //   - worker source never sees user_facing agent destinations
      // Channel destinations are not filtered — humans on the other end can
      // legitimately receive cross-channel a2a-style replies.
      if (sourceRole === 'user_facing') continue;
      if (sourceRole === 'worker' && ag.role === 'user_facing') continue;
      resolved.push({
        name: row.local_name,
        display_name: ag.name,
        type: 'agent',
        channel_type: null,
        platform_id: null,
        agent_group_id: ag.id,
      });
    }
  }

  const db = openInboundDb(agentGroupId, sessionId);
  try {
    replaceDestinations(db, resolved);
  } finally {
    db.close();
  }
  log.debug('Destination map written', { sessionId, count: resolved.length });
}
