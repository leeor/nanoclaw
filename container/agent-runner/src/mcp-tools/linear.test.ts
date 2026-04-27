import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  linearCommentOnIssue,
  linearCreateIssue,
  linearGetIssue,
  linearListIssues,
  linearUpdateIssue,
} from './linear.js';

/**
 * Mock fetch by replacing the global with a recording stub. Each test
 * sets a single response (status + json body); the stub records the
 * request URL, method, headers, and body so assertions can inspect
 * what the tool sent.
 */

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

let originalFetch: typeof fetch;
let savedApiKey: string | undefined;
let recorded: RecordedRequest[];
let nextResponse: { status: number; body: unknown } | null;

function setResponse(body: unknown, status = 200): void {
  nextResponse = { status, body };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  savedApiKey = process.env.LINEAR_API_KEY;
  process.env.LINEAR_API_KEY = 'lin_api_test_key';
  recorded = [];
  nextResponse = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    recorded.push({
      url,
      method: init?.method || 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    if (!nextResponse) {
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }
    return new Response(JSON.stringify(nextResponse.body), { status: nextResponse.status });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (savedApiKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = savedApiKey;
});

describe('linear_create_issue', () => {
  it('posts an issueCreate mutation and returns the new issue', async () => {
    setResponse({
      data: {
        issueCreate: {
          success: true,
          issue: {
            id: 'iss-uuid',
            identifier: 'ENG-1',
            title: 'Hello',
            url: 'https://linear.app/x/issue/ENG-1',
          },
        },
      },
    });
    const r = await linearCreateIssue.handler({
      team_id: 'team-uuid',
      title: 'Hello',
      description: 'World',
      priority: 2,
      label_ids: ['lbl-1', 'lbl-2'],
    });
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse((r.content[0] as { text: string }).text);
    expect(parsed.identifier).toBe('ENG-1');

    expect(recorded).toHaveLength(1);
    expect(recorded[0].url).toBe('https://api.linear.app/graphql');
    expect(recorded[0].method).toBe('POST');
    expect(recorded[0].headers.authorization).toBe('lin_api_test_key');
    const sent = JSON.parse(recorded[0].body);
    expect(sent.query).toContain('issueCreate');
    expect(sent.variables.input).toEqual({
      teamId: 'team-uuid',
      title: 'Hello',
      description: 'World',
      priority: 2,
      labelIds: ['lbl-1', 'lbl-2'],
    });
  });

  it('returns NO_API_KEY error when LINEAR_API_KEY is unset', async () => {
    delete process.env.LINEAR_API_KEY;
    const r = await linearCreateIssue.handler({ team_id: 't', title: 'x' });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('NO_API_KEY');
  });

  it('bubbles GraphQL errors as LINEAR_ERROR', async () => {
    setResponse({ errors: [{ message: 'team not found' }] });
    const r = await linearCreateIssue.handler({ team_id: 'bogus', title: 'x' });
    expect(r.isError).toBe(true);
    const txt = (r.content[0] as { text: string }).text;
    expect(txt).toContain('LINEAR_ERROR');
    expect(txt).toContain('team not found');
  });

  it('rejects missing title', async () => {
    const r = await linearCreateIssue.handler({ team_id: 't' });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('title');
  });
});

describe('linear_update_issue', () => {
  it('posts an issueUpdate mutation with only the changed fields', async () => {
    setResponse({
      data: {
        issueUpdate: { success: true, issue: { id: 'iss-uuid', identifier: 'ENG-1', title: 'New', url: '' } },
      },
    });
    const r = await linearUpdateIssue.handler({
      issue_id: 'iss-uuid',
      title: 'New',
      state_id: 'state-done',
    });
    expect(r.isError).toBeFalsy();
    const sent = JSON.parse(recorded[0].body);
    expect(sent.variables).toEqual({
      id: 'iss-uuid',
      input: { title: 'New', stateId: 'state-done' },
    });
  });

  it('rejects when no fields to update', async () => {
    const r = await linearUpdateIssue.handler({ issue_id: 'iss-uuid' });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('at least one field');
  });
});

describe('linear_get_issue', () => {
  it('returns issue JSON', async () => {
    setResponse({
      data: { issue: { id: 'iss-uuid', identifier: 'ENG-1', title: 'X', url: '' } },
    });
    const r = await linearGetIssue.handler({ issue_id: 'ENG-1' });
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse((r.content[0] as { text: string }).text);
    expect(parsed.identifier).toBe('ENG-1');
  });

  it('returns NOT_FOUND when issue is null', async () => {
    setResponse({ data: { issue: null } });
    const r = await linearGetIssue.handler({ issue_id: 'ENG-999' });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('NOT_FOUND');
  });

  it('reports HTTP errors with the status code', async () => {
    setResponse('unauthorized', 401);
    const r = await linearGetIssue.handler({ issue_id: 'ENG-1' });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('HTTP_401');
  });
});

describe('linear_list_issues', () => {
  it('forwards team / state / query as filters', async () => {
    setResponse({ data: { issues: { nodes: [{ id: '1' }] } } });
    const r = await linearListIssues.handler({
      team_id: 'team-uuid',
      state: 'In Progress',
      query: 'memory leak',
      limit: 5,
    });
    expect(r.isError).toBeFalsy();
    const sent = JSON.parse(recorded[0].body);
    expect(sent.variables.first).toBe(5);
    expect(sent.variables.filter.team).toEqual({ id: { eq: 'team-uuid' } });
    expect(sent.variables.filter.state).toEqual({ name: { eq: 'In Progress' } });
    expect(sent.variables.filter.title).toEqual({ containsIgnoreCase: 'memory leak' });
  });

  it('returns an empty array when there are no nodes', async () => {
    setResponse({ data: { issues: { nodes: [] } } });
    const r = await linearListIssues.handler({});
    expect(r.isError).toBeFalsy();
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual([]);
  });
});

describe('linear_comment_on_issue', () => {
  it('posts commentCreate with the body', async () => {
    setResponse({
      data: { commentCreate: { success: true, comment: { id: 'c-1', url: 'https://x' } } },
    });
    const r = await linearCommentOnIssue.handler({ issue_id: 'iss-uuid', body: 'lgtm' });
    expect(r.isError).toBeFalsy();
    const sent = JSON.parse(recorded[0].body);
    expect(sent.variables.input).toEqual({ issueId: 'iss-uuid', body: 'lgtm' });
  });

  it('rejects empty body', async () => {
    const r = await linearCommentOnIssue.handler({ issue_id: 'iss-uuid', body: '' });
    expect(r.isError).toBe(true);
  });
});
