/**
 * Linear MCP tools — talks to https://api.linear.app/graphql via Bun's
 * built-in fetch. Auth is `Authorization: <key>` (no `Bearer` prefix —
 * Linear's docs show the raw key form for personal API tokens).
 *
 * If `LINEAR_API_KEY` is missing the tools return a structured error
 * `{code: 'NO_API_KEY', ...}` rather than crashing the MCP server —
 * not every coding agent has Linear in scope, and the server has to
 * stay alive to serve the gh / devcontainer-cli / etc. tools.
 *
 * GraphQL queries are inlined here (small + readable). Returned JSON
 * is whatever Linear's `data.<root>` contains; on errors Linear's
 * `errors` array is bubbled up under `LINEAR_ERROR`.
 */

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(payload: { code: string; message: string; details?: unknown }) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `Error: ${payload.message}\n${JSON.stringify({ error: payload })}`,
      },
    ],
    isError: true,
  };
}

interface LinearGraphQLResult {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

async function linearRequest(
  query: string,
  variables: Record<string, unknown>,
): Promise<LinearGraphQLResult | { _localError: { code: string; message: string } }> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    return {
      _localError: {
        code: 'NO_API_KEY',
        message: 'LINEAR_API_KEY not set in agent environment',
      },
    };
  }
  try {
    const resp = await fetch(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return {
        _localError: {
          code: `HTTP_${resp.status}`,
          message: `Linear API returned ${resp.status}: ${text.slice(0, 500)}`,
        },
      };
    }
    return (await resp.json()) as LinearGraphQLResult;
  } catch (e) {
    const ex = e as Error;
    return {
      _localError: {
        code: 'FETCH_ERROR',
        message: ex.message || 'unknown fetch error',
      },
    };
  }
}

function unwrap<T>(
  result: LinearGraphQLResult | { _localError: { code: string; message: string } },
  rootKey: string,
):
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; details?: unknown } {
  if ('_localError' in result) {
    return { ok: false, code: result._localError.code, message: result._localError.message };
  }
  if (result.errors && result.errors.length > 0) {
    return {
      ok: false,
      code: 'LINEAR_ERROR',
      message: result.errors.map((e) => e.message).join('; '),
      details: result.errors,
    };
  }
  if (!result.data || !(rootKey in result.data)) {
    return { ok: false, code: 'BAD_RESPONSE', message: `missing data.${rootKey} in Linear response` };
  }
  return { ok: true, value: result.data[rootKey] as T };
}

export const linearCreateIssue: McpToolDefinition = {
  tool: {
    name: 'linear_create_issue',
    description:
      'Create a Linear issue. Returns {id, identifier, url, title}. Use linear_list_issues / linear_get_issue first to discover the team_id you want to file under.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        team_id: { type: 'string', description: 'Linear team UUID.' },
        title: { type: 'string', description: 'Issue title.' },
        description: { type: 'string', description: 'Markdown description (optional).' },
        priority: {
          type: 'number',
          description: 'Priority 0-4 (0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low).',
        },
        assignee_id: { type: 'string', description: 'User UUID to assign.' },
        label_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Label UUIDs to attach.',
        },
      },
      required: ['team_id', 'title'],
    },
  },
  async handler(args) {
    const teamId = args.team_id;
    const title = args.title;
    if (typeof teamId !== 'string' || !teamId) {
      return err({ code: 'BAD_INPUT', message: 'team_id is required' });
    }
    if (typeof title !== 'string' || !title) {
      return err({ code: 'BAD_INPUT', message: 'title is required' });
    }
    const input: Record<string, unknown> = { teamId, title };
    if (typeof args.description === 'string') input.description = args.description;
    if (typeof args.priority === 'number') input.priority = args.priority;
    if (typeof args.assignee_id === 'string') input.assigneeId = args.assignee_id;
    if (Array.isArray(args.label_ids)) input.labelIds = args.label_ids;

    const query = `
      mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier title url }
        }
      }`;
    const r = await linearRequest(query, { input });
    const u = unwrap<{ success: boolean; issue: Record<string, unknown> | null }>(r, 'issueCreate');
    if (!u.ok) {
      log(`linear_create_issue: ${u.code}: ${u.message}`);
      return err({ code: u.code, message: u.message, details: u.details });
    }
    if (!u.value.success || !u.value.issue) {
      return err({ code: 'CREATE_FAILED', message: 'Linear returned success=false' });
    }
    return ok(JSON.stringify(u.value.issue));
  },
};

export const linearUpdateIssue: McpToolDefinition = {
  tool: {
    name: 'linear_update_issue',
    description: 'Update an existing Linear issue. Any field omitted is left unchanged.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        issue_id: { type: 'string', description: 'Issue UUID.' },
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'number' },
        assignee_id: { type: 'string' },
        label_ids: { type: 'array', items: { type: 'string' } },
        state_id: { type: 'string', description: 'Workflow-state UUID (e.g. Done, In Progress).' },
      },
      required: ['issue_id'],
    },
  },
  async handler(args) {
    const issueId = args.issue_id;
    if (typeof issueId !== 'string' || !issueId) {
      return err({ code: 'BAD_INPUT', message: 'issue_id is required' });
    }
    const input: Record<string, unknown> = {};
    if (typeof args.title === 'string') input.title = args.title;
    if (typeof args.description === 'string') input.description = args.description;
    if (typeof args.priority === 'number') input.priority = args.priority;
    if (typeof args.assignee_id === 'string') input.assigneeId = args.assignee_id;
    if (Array.isArray(args.label_ids)) input.labelIds = args.label_ids;
    if (typeof args.state_id === 'string') input.stateId = args.state_id;
    if (Object.keys(input).length === 0) {
      return err({ code: 'BAD_INPUT', message: 'at least one field to update is required' });
    }

    const query = `
      mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue { id identifier title url }
        }
      }`;
    const r = await linearRequest(query, { id: issueId, input });
    const u = unwrap<{ success: boolean; issue: Record<string, unknown> | null }>(r, 'issueUpdate');
    if (!u.ok) {
      log(`linear_update_issue: ${u.code}: ${u.message}`);
      return err({ code: u.code, message: u.message, details: u.details });
    }
    if (!u.value.success) {
      return err({ code: 'UPDATE_FAILED', message: 'Linear returned success=false' });
    }
    return ok(`Issue ${issueId} updated`);
  },
};

export const linearGetIssue: McpToolDefinition = {
  tool: {
    name: 'linear_get_issue',
    description: 'Fetch a single Linear issue by id (UUID or identifier like "ENG-123").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        issue_id: { type: 'string', description: 'Issue UUID or identifier.' },
      },
      required: ['issue_id'],
    },
  },
  async handler(args) {
    const issueId = args.issue_id;
    if (typeof issueId !== 'string' || !issueId) {
      return err({ code: 'BAD_INPUT', message: 'issue_id is required' });
    }
    const query = `
      query Issue($id: String!) {
        issue(id: $id) {
          id identifier title description url
          state { id name type }
          priority
          assignee { id name email }
          team { id key name }
          labels { nodes { id name } }
          createdAt updatedAt
        }
      }`;
    const r = await linearRequest(query, { id: issueId });
    const u = unwrap<Record<string, unknown> | null>(r, 'issue');
    if (!u.ok) {
      log(`linear_get_issue: ${u.code}: ${u.message}`);
      return err({ code: u.code, message: u.message, details: u.details });
    }
    if (!u.value) {
      return err({ code: 'NOT_FOUND', message: `Issue ${issueId} not found` });
    }
    return ok(JSON.stringify(u.value));
  },
};

export const linearListIssues: McpToolDefinition = {
  tool: {
    name: 'linear_list_issues',
    description:
      'List Linear issues, optionally filtered by team / text query / workflow state. Returns a JSON array.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        team_id: { type: 'string', description: 'Filter to issues on this team.' },
        query: { type: 'string', description: 'Free-text search (title + description).' },
        state: { type: 'string', description: 'Workflow state name (e.g. "In Progress", "Done").' },
        limit: { type: 'number', description: 'Max results (default 25).' },
      },
    },
  },
  async handler(args) {
    const teamId = typeof args.team_id === 'string' ? args.team_id : undefined;
    const query = typeof args.query === 'string' ? args.query : undefined;
    const state = typeof args.state === 'string' ? args.state : undefined;
    const limit = typeof args.limit === 'number' ? args.limit : 25;

    const filter: Record<string, unknown> = {};
    if (teamId) filter.team = { id: { eq: teamId } };
    if (state) filter.state = { name: { eq: state } };

    const variables: Record<string, unknown> = { first: limit, filter };
    if (query) variables.searchableContent = query;

    const gql = `
      query Issues($first: Int!, $filter: IssueFilter, $searchableContent: String) {
        issues(
          first: $first
          filter: $filter
          ${query ? '' : ''}
        ) {
          nodes {
            id identifier title url
            state { name }
            priority
            assignee { name }
            team { key }
            updatedAt
          }
        }
      }`;
    // Note: Linear's free-text search uses a separate `searchIssues` query;
    // for parity with v1's lightweight wrapping we just filter by title
    // when `query` is provided. (`searchableContent` was a placeholder —
    // the real plumbing would use `issueSearch`. Keep the simpler path
    // until an agent actually demands ranked search.)
    const filterWithTitle = query
      ? { ...filter, title: { containsIgnoreCase: query } }
      : filter;

    const r = await linearRequest(gql, { first: limit, filter: filterWithTitle });
    const u = unwrap<{ nodes: unknown[] }>(r, 'issues');
    if (!u.ok) {
      log(`linear_list_issues: ${u.code}: ${u.message}`);
      return err({ code: u.code, message: u.message, details: u.details });
    }
    return ok(JSON.stringify(u.value.nodes));
  },
};

export const linearCommentOnIssue: McpToolDefinition = {
  tool: {
    name: 'linear_comment_on_issue',
    description: 'Post a comment on a Linear issue.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        issue_id: { type: 'string', description: 'Issue UUID.' },
        body: { type: 'string', description: 'Comment body (markdown).' },
      },
      required: ['issue_id', 'body'],
    },
  },
  async handler(args) {
    const issueId = args.issue_id;
    const body = args.body;
    if (typeof issueId !== 'string' || !issueId) {
      return err({ code: 'BAD_INPUT', message: 'issue_id is required' });
    }
    if (typeof body !== 'string' || !body) {
      return err({ code: 'BAD_INPUT', message: 'body is required' });
    }
    const query = `
      mutation CommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment { id url }
        }
      }`;
    const r = await linearRequest(query, { input: { issueId, body } });
    const u = unwrap<{ success: boolean; comment: Record<string, unknown> | null }>(
      r,
      'commentCreate',
    );
    if (!u.ok) {
      log(`linear_comment_on_issue: ${u.code}: ${u.message}`);
      return err({ code: u.code, message: u.message, details: u.details });
    }
    if (!u.value.success) {
      return err({ code: 'COMMENT_FAILED', message: 'Linear returned success=false' });
    }
    return ok(`Comment posted on ${issueId}`);
  },
};

registerTools([
  linearCreateIssue,
  linearUpdateIssue,
  linearGetIssue,
  linearListIssues,
  linearCommentOnIssue,
]);
