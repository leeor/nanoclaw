import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { devcontainerExec, devcontainerRebuild } from './devcontainer-cli.js';

/**
 * Same fake-binary-on-PATH approach as gh.test.ts. The shim records its
 * argv into $DEVC_LOG and returns whatever's described in
 * $DEVC_RESPONSE_FILE.
 */

let tmp: string;
let savedPath: string | undefined;
let savedWorkspaceFolder: string | undefined;

function writeShim(): void {
  // Logs argv to $DEVC_LOG, then dispatches to a node helper that writes
  // the canned stdout/stderr bytes exactly (no shell-substitution newline
  // trimming) and exits with the canned exit code.
  const shim = `#!/bin/sh
{
  for a in "$@"; do printf '%s\\n' "ARG: $a"; done
  echo '---'
} >> "$DEVC_LOG"

if [ -f "$DEVC_RESPONSE_FILE" ]; then
  exec node -e '
const r = JSON.parse(require("fs").readFileSync(process.env.DEVC_RESPONSE_FILE, "utf8"));
process.stdout.write(r.stdout || "");
process.stderr.write(r.stderr || "");
process.exit(typeof r.exit === "number" ? r.exit : 0);
'
fi
exit 0
`;
  fs.writeFileSync(path.join(tmp, 'devcontainer'), shim, { mode: 0o755 });
}

function setResponse(resp: { stdout?: string; stderr?: string; exit?: number }): void {
  fs.writeFileSync(path.join(tmp, 'response.json'), JSON.stringify(resp));
}

function readLastInvocation(): string[] {
  const log = fs.readFileSync(path.join(tmp, 'devc.log'), 'utf8');
  const blocks = log.split('---\n').filter((b) => b.trim().length > 0);
  const last = blocks[blocks.length - 1] || '';
  return last
    .split('\n')
    .filter((l) => l.startsWith('ARG: '))
    .map((l) => l.slice('ARG: '.length));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devc-mcp-test-'));
  fs.writeFileSync(path.join(tmp, 'devc.log'), '');
  fs.writeFileSync(path.join(tmp, 'response.json'), JSON.stringify({ stdout: '', exit: 0 }));
  writeShim();
  savedPath = process.env.PATH;
  savedWorkspaceFolder = process.env.WORKSPACE_FOLDER;
  process.env.PATH = `${tmp}:${process.env.PATH || ''}`;
  process.env.DEVC_LOG = path.join(tmp, 'devc.log');
  process.env.DEVC_RESPONSE_FILE = path.join(tmp, 'response.json');
  process.env.WORKSPACE_FOLDER = '/workspace/repo';
});

afterEach(() => {
  if (savedPath !== undefined) process.env.PATH = savedPath;
  if (savedWorkspaceFolder === undefined) delete process.env.WORKSPACE_FOLDER;
  else process.env.WORKSPACE_FOLDER = savedWorkspaceFolder;
  delete process.env.DEVC_LOG;
  delete process.env.DEVC_RESPONSE_FILE;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('devcontainer_exec', () => {
  it('runs devcontainer exec with workspace folder + sh -c', async () => {
    setResponse({ stdout: 'hello\n', exit: 0 });
    const r = await devcontainerExec.handler({ command: 'echo hello' });
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse((r.content[0] as { text: string }).text);
    expect(parsed.stdout).toBe('hello\n');
    expect(parsed.code).toBe(0);

    const argv = readLastInvocation();
    expect(argv).toEqual([
      'exec',
      '--workspace-folder',
      '/workspace/repo',
      'sh',
      '-c',
      'echo hello',
    ]);
  });

  it('wraps command with cd <cwd> when cwd provided', async () => {
    setResponse({ stdout: '', exit: 0 });
    await devcontainerExec.handler({ command: 'pwd', cwd: '/workspace/repo/subdir' });
    const argv = readLastInvocation();
    const shellCmdIdx = argv.indexOf('-c');
    expect(argv[shellCmdIdx + 1]).toBe(`cd '/workspace/repo/subdir' && pwd`);
  });

  it('escapes single-quotes in cwd', async () => {
    setResponse({ stdout: '', exit: 0 });
    await devcontainerExec.handler({ command: 'pwd', cwd: `/foo/'evil` });
    const argv = readLastInvocation();
    const shellCmdIdx = argv.indexOf('-c');
    // Standard '\'' idiom: the single quote is closed, an escaped quote
    // inserted, then a new single-quote opened.
    expect(argv[shellCmdIdx + 1]).toBe(`cd '/foo/'\\''evil' && pwd`);
  });

  it('returns structured error on missing WORKSPACE_FOLDER', async () => {
    delete process.env.WORKSPACE_FOLDER;
    const r = await devcontainerExec.handler({ command: 'true' });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('NO_WORKSPACE_FOLDER');
  });

  it('returns structured error on missing command', async () => {
    const r = await devcontainerExec.handler({});
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('command is required');
  });

  it('reports non-zero exit code in the result envelope (not isError)', async () => {
    // devcontainer exec returning non-zero is a legitimate "command
    // failed" — the agent wants the {stdout, stderr, code} payload, not
    // an isError wrapper. isError is reserved for tool-level failures.
    setResponse({ stdout: 'partial\n', stderr: 'whoops\n', exit: 2 });
    const r = await devcontainerExec.handler({ command: 'false' });
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse((r.content[0] as { text: string }).text);
    expect(parsed.code).toBe(2);
    expect(parsed.stderr).toBe('whoops\n');
    expect(parsed.stdout).toBe('partial\n');
  });
});

describe('devcontainer_rebuild', () => {
  it('runs devcontainer up with --remove-existing-container', async () => {
    setResponse({ stdout: 'ok\n', exit: 0 });
    const r = await devcontainerRebuild.handler({});
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse((r.content[0] as { text: string }).text);
    expect(parsed.ok).toBe(true);

    const argv = readLastInvocation();
    expect(argv).toEqual([
      'up',
      '--workspace-folder',
      '/workspace/repo',
      '--remove-existing-container',
    ]);
  });

  it('returns structured error when up exits non-zero', async () => {
    setResponse({ stdout: '', stderr: 'Cannot connect to the Docker daemon', exit: 1 });
    const r = await devcontainerRebuild.handler({});
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('EXIT_1');
    expect((r.content[0] as { text: string }).text).toContain('Cannot connect');
  });

  it('errors when WORKSPACE_FOLDER is unset', async () => {
    delete process.env.WORKSPACE_FOLDER;
    const r = await devcontainerRebuild.handler({});
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('NO_WORKSPACE_FOLDER');
  });
});
