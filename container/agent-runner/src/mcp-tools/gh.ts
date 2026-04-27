/**
 * `gh` MCP tools — wrapper around the GitHub CLI.
 *
 * Each tool shells out to `gh` via `execFileSync` (no shell interpolation,
 * no quoting bugs), 30-second timeout per call. JSON-shaped responses are
 * parsed and returned as the MCP tool's text payload; errors bubble out
 * as `Error: gh ...` text plus a structured JSON line so the agent has
 * both a human-readable hint and a machine-parseable summary.
 *
 * The CLI inherits the user's existing `gh auth` (OneCLI / GH_TOKEN /
 * keyring — whatever's already configured on the container env). No
 * separate token wiring inside this file.
 */

import { execFileSync } from 'node:child_process';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const GH_TIMEOUT_MS = 30_000;

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(payload: { code: string; message: string; stderr?: string }) {
  // Two-line response: a human prefix (so agents that only read .text get
  // a useful nudge) plus a JSON blob (so structured-aware callers can
  // parse it). Mirrors the shape used by other MCP tool error returns
  // in this codebase.
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

function runGh(
  args: string[],
): { ok: true; stdout: string } | { ok: false; code: string; message: string; stderr: string } {
  try {
    const stdout = execFileSync('gh', args, {
      timeout: GH_TIMEOUT_MS,
      encoding: 'utf8',
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout };
  } catch (e) {
    const ex = e as NodeJS.ErrnoException & {
      stderr?: Buffer | string;
      stdout?: Buffer | string;
      status?: number | null;
      signal?: string | null;
    };
    const stderr = ex.stderr
      ? (Buffer.isBuffer(ex.stderr) ? ex.stderr.toString() : ex.stderr).trim()
      : '';
    const code =
      ex.signal === 'SIGTERM'
        ? 'TIMEOUT'
        : ex.code && typeof ex.code === 'string'
        ? ex.code
        : ex.status !== undefined && ex.status !== null
        ? `EXIT_${ex.status}`
        : 'UNKNOWN';
    return {
      ok: false,
      code,
      message: ex.message || `gh exited with ${code}`,
      stderr,
    };
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function requireString(v: unknown, name: string): string | { error: string } {
  const s = asString(v);
  if (!s) return { error: `${name} is required (string)` };
  return s;
}

function requireNumber(v: unknown, name: string): number | { error: string } {
  if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `${name} is required (number)` };
  return v;
}

export const ghPrView: McpToolDefinition = {
  tool: {
    name: 'gh_pr_view',
    description:
      'View a GitHub pull request. Returns the JSON object emitted by `gh pr view --json <fields>`. Default fields cover identity, status, author, labels, and review/merge state.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        pr_number: { type: 'number', description: 'PR number.' },
        repo: { type: 'string', description: 'Repo in "owner/name" form.' },
        fields: {
          type: 'string',
          description:
            'Comma-separated `gh pr view --json` field list. Default: number,title,state,url,author,headRefName,baseRefName,labels,reviewDecision,mergeable,mergeStateStatus,isDraft.',
        },
      },
      required: ['pr_number', 'repo'],
    },
  },
  async handler(args) {
    const prNumber = requireNumber(args.pr_number, 'pr_number');
    if (typeof prNumber !== 'number') return err({ code: 'BAD_INPUT', message: prNumber.error });
    const repo = requireString(args.repo, 'repo');
    if (typeof repo !== 'string') return err({ code: 'BAD_INPUT', message: repo.error });
    const fields =
      asString(args.fields) ||
      'number,title,state,url,author,headRefName,baseRefName,labels,reviewDecision,mergeable,mergeStateStatus,isDraft';

    const result = runGh(['pr', 'view', String(prNumber), '--repo', repo, '--json', fields]);
    if (!result.ok) {
      log(`gh_pr_view: ${repo}#${prNumber} failed (${result.code}): ${result.stderr}`);
      return err({ code: result.code, message: result.message, stderr: result.stderr });
    }
    return ok(result.stdout.trim());
  },
};

export const ghPrCreate: McpToolDefinition = {
  tool: {
    name: 'gh_pr_create',
    description:
      'Create a GitHub pull request. Returns the URL of the newly-opened PR. Run from inside a repo checkout — `head` and `base` are optional; gh will infer them from the current branch tracking config.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'PR title.' },
        body: { type: 'string', description: 'PR body (markdown).' },
        base: { type: 'string', description: 'Optional base branch.' },
        head: { type: 'string', description: 'Optional head branch.' },
        draft: { type: 'boolean', description: 'Open as draft.' },
        repo: { type: 'string', description: 'Optional repo override (owner/name).' },
      },
      required: ['title', 'body'],
    },
  },
  async handler(args) {
    const title = requireString(args.title, 'title');
    if (typeof title !== 'string') return err({ code: 'BAD_INPUT', message: title.error });
    const body = requireString(args.body, 'body');
    if (typeof body !== 'string') return err({ code: 'BAD_INPUT', message: body.error });

    const cmd: string[] = ['pr', 'create', '--title', title, '--body', body];
    const base = asString(args.base);
    if (base) cmd.push('--base', base);
    const head = asString(args.head);
    if (head) cmd.push('--head', head);
    if (args.draft === true) cmd.push('--draft');
    const repo = asString(args.repo);
    if (repo) cmd.push('--repo', repo);

    const result = runGh(cmd);
    if (!result.ok) {
      log(`gh_pr_create: failed (${result.code}): ${result.stderr}`);
      return err({ code: result.code, message: result.message, stderr: result.stderr });
    }
    // `gh pr create` writes the URL to stdout (last non-empty line, in case
    // gh prepends progress lines on a non-tty).
    const url = result.stdout.trim().split('\n').filter(Boolean).pop() || '';
    return ok(url);
  },
};

export const ghPrComment: McpToolDefinition = {
  tool: {
    name: 'gh_pr_comment',
    description: 'Post a comment on a GitHub pull request.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        pr_number: { type: 'number', description: 'PR number.' },
        repo: { type: 'string', description: 'Repo in "owner/name" form.' },
        body: { type: 'string', description: 'Comment body (markdown).' },
      },
      required: ['pr_number', 'repo', 'body'],
    },
  },
  async handler(args) {
    const prNumber = requireNumber(args.pr_number, 'pr_number');
    if (typeof prNumber !== 'number') return err({ code: 'BAD_INPUT', message: prNumber.error });
    const repo = requireString(args.repo, 'repo');
    if (typeof repo !== 'string') return err({ code: 'BAD_INPUT', message: repo.error });
    const body = requireString(args.body, 'body');
    if (typeof body !== 'string') return err({ code: 'BAD_INPUT', message: body.error });

    const result = runGh(['pr', 'comment', String(prNumber), '--repo', repo, '--body', body]);
    if (!result.ok) {
      log(`gh_pr_comment: ${repo}#${prNumber} failed (${result.code}): ${result.stderr}`);
      return err({ code: result.code, message: result.message, stderr: result.stderr });
    }
    return ok(`Comment posted on ${repo}#${prNumber}`);
  },
};

export const ghPrList: McpToolDefinition = {
  tool: {
    name: 'gh_pr_list',
    description:
      'List GitHub pull requests in a repo. Returns a JSON array as emitted by `gh pr list --json`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repo in "owner/name" form.' },
        state: {
          type: 'string',
          description: 'open | closed | merged | all. Default: open.',
        },
        head: { type: 'string', description: 'Filter by head branch.' },
        limit: { type: 'number', description: 'Max results (default 30).' },
      },
      required: ['repo'],
    },
  },
  async handler(args) {
    const repo = requireString(args.repo, 'repo');
    if (typeof repo !== 'string') return err({ code: 'BAD_INPUT', message: repo.error });
    const state = asString(args.state) || 'open';
    const head = asString(args.head);
    const limit = typeof args.limit === 'number' ? args.limit : 30;

    const cmd: string[] = [
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      state,
      '--limit',
      String(limit),
      '--json',
      'number,title,state,url,author,headRefName,baseRefName,isDraft,createdAt,updatedAt',
    ];
    if (head) cmd.push('--head', head);

    const result = runGh(cmd);
    if (!result.ok) {
      log(`gh_pr_list: ${repo} failed (${result.code}): ${result.stderr}`);
      return err({ code: result.code, message: result.message, stderr: result.stderr });
    }
    return ok(result.stdout.trim());
  },
};

export const ghRepoView: McpToolDefinition = {
  tool: {
    name: 'gh_repo_view',
    description: 'View metadata for a GitHub repo.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repo in "owner/name" form.' },
      },
      required: ['repo'],
    },
  },
  async handler(args) {
    const repo = requireString(args.repo, 'repo');
    if (typeof repo !== 'string') return err({ code: 'BAD_INPUT', message: repo.error });

    const result = runGh([
      'repo',
      'view',
      repo,
      '--json',
      'name,nameWithOwner,description,url,defaultBranchRef,visibility,isPrivate,pushedAt,owner',
    ]);
    if (!result.ok) {
      log(`gh_repo_view: ${repo} failed (${result.code}): ${result.stderr}`);
      return err({ code: result.code, message: result.message, stderr: result.stderr });
    }
    return ok(result.stdout.trim());
  },
};

registerTools([ghPrView, ghPrCreate, ghPrComment, ghPrList, ghRepoView]);
