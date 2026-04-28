import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

describe('TOOL_ALLOWLIST surface', () => {
  it('includes mcp__linear__* so Linear hosted MCP tools are reachable', () => {
    const src = readFileSync(join(here, 'claude.ts'), 'utf8');
    expect(src).toContain("'mcp__linear__*'");
  });
});
