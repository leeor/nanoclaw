import type { AgentGroup } from '../types.js';
import { getDb } from './connection.js';

export function createAgentGroup(group: AgentGroup): void {
  // role defaults to 'user_facing' at the SQL layer too — callers that
  // build AgentGroup objects before migration 015 was added (older
  // fixtures, test seeds) still work because the column has a NOT NULL
  // DEFAULT. Explicit callers (e.g. create-coding-task setting 'worker')
  // override it.
  getDb()
    .prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, role, created_at)
       VALUES (@id, @name, @folder, @agent_provider, COALESCE(@role, 'user_facing'), @created_at)`,
    )
    .run({
      id: group.id,
      name: group.name,
      folder: group.folder,
      agent_provider: group.agent_provider,
      role: group.role ?? null,
      created_at: group.created_at,
    });
}

export function getAgentGroup(id: string): AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE id = ?').get(id) as AgentGroup | undefined;
}

export function getAgentGroupByFolder(folder: string): AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE folder = ?').get(folder) as AgentGroup | undefined;
}

export function getAllAgentGroups(): AgentGroup[] {
  return getDb().prepare('SELECT * FROM agent_groups ORDER BY name').all() as AgentGroup[];
}

export function updateAgentGroup(id: string, updates: Partial<Pick<AgentGroup, 'name' | 'agent_provider'>>): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  getDb()
    .prepare(`UPDATE agent_groups SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

export function deleteAgentGroup(id: string): void {
  getDb().prepare('DELETE FROM agent_groups WHERE id = ?').run(id);
}
