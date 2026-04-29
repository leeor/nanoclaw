import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ghPrView, ghPrCreate, ghPrComment, ghPrList, ghRepoView } from './gh.js';

/**
 * gh-MCP tests use a fake `gh` shim on PATH instead of mocking
 * `child_process` — `execFileSync` calls into a real binary, so a real
 * binary on a tmpdir PATH is the lowest-friction way to exercise both
 * the happy path (exit 0 with stdout) and the error path (non-zero exit
 * with stderr) under bun:test.
 *
 * The shim is a tiny shell script that:
 *  - records every invocation into $GH_LOG (one JSON line per call)
 *  - reads its response from $GH_RESPONSE_FILE (a JSON file with
 *    `{ stdout, stderr, exit }`)
 */

let tmp: string;
let savedPath: string | undefined;

function writeShim(): void {
  const shim = `#!/bin/sh
# Record args one per line, prefixed with the call index so multiple calls
# can be inspected.
{
  printf '%s\\n' "ARGV-COUNT $#"
  for a in "$@"; do printf '%s\\n' "ARG: $a"; done
  echo '---'
} >> "$GH_LOG"

# Read response config.
if [ -f "$GH_RESPONSE_FILE" ]; then
  STDOUT=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).stdout || '')" "$GH_RESPONSE_FILE")
  STDERR=$(node -e "console.error(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).stderr || '')" "$GH_RESPONSE_FILE" 2>&1 1>/dev/null)
  EXIT=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).exit || 0)" "$GH_RESPONSE_FILE")
  printf '%s' "$STDOUT"
  if [ -n "$STDERR" ]; then printf '%s' "$STDERR" 1>&2; fi
  exit "$EXIT"
fi
exit 0
`;
  fs.writeFileSync(path.join(tmp, 'gh'), shim, { mode: 0o755 });
}

function setResponse(resp: { stdout?: string; stderr?: string; exit?: number }): void {
  fs.writeFileSync(path.join(tmp, 'response.json'), JSON.stringify(resp));
}

function readLastInvocation(): string[] {
  const log = fs.readFileSync(path.join(tmp, 'gh.log'), 'utf8');
  // Take the LAST '---'-delimited block.
  const blocks = log.split('---\n').filter((b) => b.trim().length > 0);
  const last = blocks[blocks.length - 1] || '';
  return last
    .split('\n')
    .filter((l) => l.startsWith('ARG: '))
    .map((l) => l.slice('ARG: '.length));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-mcp-test-'));
  fs.writeFileSync(path.join(tmp, 'gh.log'), '');
  fs.writeFileSync(path.join(tmp, 'response.json'), JSON.stringify({ stdout: '', exit: 0 }));
  writeShim();
  savedPath = process.env.PATH;
  process.env.PATH = `${tmp}:${process.env.PATH || ''}`;
  process.env.GH_LOG = path.join(tmp, 'gh.log');
  process.env.GH_RESPONSE_FILE = path.join(tmp, 'response.json');
});

afterEach(() => {
  if (savedPath !== undefined) process.env.PATH = savedPath;
  delete process.env.GH_LOG;
  delete process.env.GH_RESPONSE_FILE;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('gh_pr_view', () => {
  it('shells gh pr view with the right args and returns stdout', async () => {
    setResponse({ stdout: '{"number":42,"title":"hello"}', exit: 0 });
    const r = await ghPrView.handler({ pr_number: 42, repo: 'foo/bar' });
    expect(r.isError).toBeFalsy();
    expect((r.content[0] as { text: string }).text).toBe('{"number":42,"title":"hello"}');

    const argv = readLastInvocation();
    expect(argv).toContain('pr');
    expect(argv).toContain('view');
    expect(argv).toContain('42');
    expect(argv).toContain('--repo');
    expect(argv).toContain('foo/bar');
    // Default field set must include reviewDecision.
    const fieldsIdx = argv.indexOf('--json');
    expect(argv[fieldsIdx + 1]).toContain('reviewDecision');
  });

  it('returns structured error on non-zero exit', async () => {
    setResponse({ stdout: '', stderr: 'GraphQL: Could not resolve to a PullRequest', exit: 1 });
    const r = await ghPrView.handler({ pr_number: 99, repo: 'foo/bar' });
    expect(r.isError).toBe(true);
    const txt = (r.content[0] as { text: string }).text;
    expect(txt).toContain('Error:');
    expect(txt).toContain('"code":"EXIT_1"');
    expect(txt).toContain('Could not resolve');
  });

  it('rejects missing pr_number', async () => {
    const r = await ghPrView.handler({ repo: 'foo/bar' });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('pr_number');
  });
});

describe('gh_pr_create', () => {
  it('shells gh pr create with title/body/draft and returns URL', async () => {
    setResponse({ stdout: 'https://github.com/foo/bar/pull/123\n', exit: 0 });
    const r = await ghPrCreate.handler({
      title: 'My PR',
      body: 'Body',
      base: 'main',
      head: 'feature',
      draft: true,
      repo: 'foo/bar',
    });
    expect(r.isError).toBeFalsy();
    expect((r.content[0] as { text: string }).text).toBe('https://github.com/foo/bar/pull/123');

    const argv = readLastInvocation();
    expect(argv).toEqual([
      'pr',
      'create',
      '--title',
      'My PR',
      '--body',
      'Body',
      '--base',
      'main',
      '--head',
      'feature',
      '--draft',
      '--repo',
      'foo/bar',
    ]);
  });

  it('returns structured error when gh fails', async () => {
    setResponse({ stdout: '', stderr: 'a pull request already exists', exit: 1 });
    const r = await ghPrCreate.handler({ title: 'x', body: 'y' });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('already exists');
  });
});

describe('gh_pr_comment', () => {
  it('shells gh pr comment with body', async () => {
    setResponse({ stdout: 'https://github.com/foo/bar/pull/1#issuecomment-1', exit: 0 });
    const r = await ghPrComment.handler({ pr_number: 1, repo: 'foo/bar', body: 'lgtm' });
    expect(r.isError).toBeFalsy();

    const argv = readLastInvocation();
    expect(argv).toEqual(['pr', 'comment', '1', '--repo', 'foo/bar', '--body', 'lgtm']);
  });

  it('rejects missing body', async () => {
    const r = await ghPrComment.handler({ pr_number: 1, repo: 'foo/bar' });
    expect(r.isError).toBe(true);
  });
});

describe('gh_pr_list', () => {
  it('defaults to state=open and limit=30', async () => {
    setResponse({ stdout: '[]', exit: 0 });
    const r = await ghPrList.handler({ repo: 'foo/bar' });
    expect(r.isError).toBeFalsy();
    const argv = readLastInvocation();
    expect(argv).toContain('--state');
    expect(argv[argv.indexOf('--state') + 1]).toBe('open');
    expect(argv).toContain('--limit');
    expect(argv[argv.indexOf('--limit') + 1]).toBe('30');
  });

  it('forwards --head when provided', async () => {
    setResponse({ stdout: '[]', exit: 0 });
    await ghPrList.handler({ repo: 'foo/bar', head: 'feature/x', state: 'all', limit: 5 });
    const argv = readLastInvocation();
    expect(argv).toContain('--head');
    expect(argv[argv.indexOf('--head') + 1]).toBe('feature/x');
    expect(argv[argv.indexOf('--state') + 1]).toBe('all');
    expect(argv[argv.indexOf('--limit') + 1]).toBe('5');
  });
});

describe('gh_repo_view', () => {
  it('returns repo metadata JSON', async () => {
    setResponse({ stdout: '{"name":"bar"}', exit: 0 });
    const r = await ghRepoView.handler({ repo: 'foo/bar' });
    expect(r.isError).toBeFalsy();
    expect((r.content[0] as { text: string }).text).toBe('{"name":"bar"}');
  });
});
