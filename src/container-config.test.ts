import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, GROUPS_DIR: '/tmp/nanoclaw-cfg-test' };
});

import { readContainerConfig } from './container-config.js';

const TEST_GROUPS_DIR = '/tmp/nanoclaw-cfg-test';

beforeEach(() => {
  if (fs.existsSync(TEST_GROUPS_DIR)) fs.rmSync(TEST_GROUPS_DIR, { recursive: true });
  fs.mkdirSync(TEST_GROUPS_DIR, { recursive: true });
});

afterEach(() => {
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
