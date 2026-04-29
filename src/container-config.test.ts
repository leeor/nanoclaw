import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, GROUPS_DIR: '/tmp/nanoclaw-cfg-test' };
});

const TEST_GROUPS_DIR = '/tmp/nanoclaw-cfg-test';

// readEnvFile reads from process.cwd()/.env. Point it at the test groups dir
// so each test can write its own .env without touching the project's real one.
const ORIG_CWD = process.cwd();

import { readContainerConfig } from './container-config.js';

beforeEach(() => {
  if (fs.existsSync(TEST_GROUPS_DIR)) fs.rmSync(TEST_GROUPS_DIR, { recursive: true });
  fs.mkdirSync(TEST_GROUPS_DIR, { recursive: true });
  process.chdir(TEST_GROUPS_DIR);
});

afterEach(() => {
  process.chdir(ORIG_CWD);
  if (fs.existsSync(TEST_GROUPS_DIR)) fs.rmSync(TEST_GROUPS_DIR, { recursive: true });
});

describe('readContainerConfig', () => {
  it('parses an http MCP server entry without dropping the type/url/headers', () => {
    const folder = 'g1';
    const dir = path.join(TEST_GROUPS_DIR, folder);
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'container.json'),
      JSON.stringify({
        mcpServers: {
          linear: {
            type: 'http',
            url: 'https://mcp.linear.app/mcp',
            headers: { Authorization: 'Bearer onecli-managed' },
          },
        },
      }),
    );

    const cfg = readContainerConfig(folder);
    const linear = cfg.mcpServers.linear;
    expect(linear).toBeDefined();
    if (linear && 'type' in linear && linear.type === 'http') {
      expect(linear.url).toBe('https://mcp.linear.app/mcp');
      expect(linear.headers?.Authorization).toBe('Bearer onecli-managed');
    } else {
      throw new Error('expected http variant');
    }
  });

  it('expands ${VAR} references in stdio args, env values, and additional mounts using .env values', () => {
    const folder = 'g3';
    const dir = path.join(TEST_GROUPS_DIR, folder);
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(TEST_GROUPS_DIR, '.env'),
      [
        'ANCHOR_DB_URL=postgresql://u:p@10.50.0.5:5432/anchor?sslmode=disable',
        'GMAIL_REFRESH=tok-abc',
        'EXTRA_REPOS=/home/leeor/repos',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'container.json'),
      JSON.stringify({
        mcpServers: {
          'anchor-db': {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-postgres', '${ANCHOR_DB_URL}'],
            env: {},
          },
          gmail: {
            command: 'pnpm',
            args: ['dlx', '@shinzolabs/gmail-mcp'],
            env: { REFRESH_TOKEN: '${GMAIL_REFRESH}' },
          },
        },
        additionalMounts: [{ hostPath: '${EXTRA_REPOS}', containerPath: 'repos', readonly: false }],
      }),
    );
    const cfg = readContainerConfig(folder);
    const anchor = cfg.mcpServers['anchor-db'];
    if (!anchor || ('type' in anchor && anchor.type === 'http')) throw new Error('expected stdio variant');
    const stdio = anchor as { args?: string[]; env?: Record<string, string> };
    expect(stdio.args?.[2]).toBe('postgresql://u:p@10.50.0.5:5432/anchor?sslmode=disable');
    const gmail = cfg.mcpServers.gmail as { env?: Record<string, string> };
    expect(gmail.env?.REFRESH_TOKEN).toBe('tok-abc');
    expect(cfg.additionalMounts[0].hostPath).toBe('/home/leeor/repos');
  });

  it('expands ${VAR} references in http url and headers', () => {
    const folder = 'g4';
    const dir = path.join(TEST_GROUPS_DIR, folder);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(TEST_GROUPS_DIR, '.env'), 'MCP_HOST=mcp.example.com\nTOKEN=xyz');
    fs.writeFileSync(
      path.join(dir, 'container.json'),
      JSON.stringify({
        mcpServers: {
          remote: {
            type: 'http',
            url: 'https://${MCP_HOST}/mcp',
            headers: { Authorization: 'Bearer ${TOKEN}' },
          },
        },
      }),
    );
    const cfg = readContainerConfig(folder);
    const remote = cfg.mcpServers.remote;
    if (!remote || !('type' in remote) || remote.type !== 'http') throw new Error('expected http variant');
    expect(remote.url).toBe('https://mcp.example.com/mcp');
    expect(remote.headers?.Authorization).toBe('Bearer xyz');
  });

  it('leaves ${VAR} literal when the variable is missing from .env', () => {
    const folder = 'g5';
    const dir = path.join(TEST_GROUPS_DIR, folder);
    fs.mkdirSync(dir);
    // No .env file written.
    fs.writeFileSync(
      path.join(dir, 'container.json'),
      JSON.stringify({
        mcpServers: {
          x: { command: 'npx', args: ['${MISSING_VAR}'], env: {} },
        },
      }),
    );
    const cfg = readContainerConfig(folder);
    const x = cfg.mcpServers.x as { args?: string[] };
    expect(x.args?.[0]).toBe('${MISSING_VAR}');
  });

  it('preserves the `repos` registry verbatim for the coding-task resolver', () => {
    const folder = 'g-repos';
    const dir = path.join(TEST_GROUPS_DIR, folder);
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'container.json'),
      JSON.stringify({
        additionalMounts: [{ hostPath: '/host/code', containerPath: 'code' }],
        repos: {
          mono: { containerPath: 'code/mono/master', defaultBaseBranch: 'origin/last-green' },
          billing: {
            containerPath: 'code/billing',
            defaultBaseBranch: 'origin/main',
            worktreeRoot: 'code/billing-worktrees',
          },
        },
      }),
    );

    const cfg = readContainerConfig(folder);
    expect(cfg.repos?.mono).toEqual({
      containerPath: 'code/mono/master',
      defaultBaseBranch: 'origin/last-green',
    });
    expect(cfg.repos?.billing).toEqual({
      containerPath: 'code/billing',
      defaultBaseBranch: 'origin/main',
      worktreeRoot: 'code/billing-worktrees',
    });
  });

  it('still parses a stdio MCP server entry without an explicit type', () => {
    const folder = 'g2';
    const dir = path.join(TEST_GROUPS_DIR, folder);
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'container.json'),
      JSON.stringify({
        mcpServers: {
          icm: { command: 'icm', args: ['serve', '--compact'], env: {} },
        },
      }),
    );
    const cfg = readContainerConfig(folder);
    const icm = cfg.mcpServers.icm;
    expect(icm).toBeDefined();
    if (icm && (!('type' in icm) || icm.type === 'stdio' || icm.type === undefined)) {
      expect(icm.command).toBe('icm');
    } else {
      throw new Error('expected stdio variant');
    }
  });
});
