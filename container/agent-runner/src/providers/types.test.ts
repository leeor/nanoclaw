import { describe, expect, it } from 'bun:test';
import type { McpServerConfig } from './types.js';

describe('McpServerConfig discriminated union', () => {
  it('accepts a stdio entry without an explicit type', () => {
    const cfg: McpServerConfig = {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      env: { FOO: 'bar' },
    };
    expect(cfg.command).toBe('npx');
  });

  it('accepts a stdio entry with explicit type', () => {
    const cfg: McpServerConfig = {
      type: 'stdio',
      command: 'npx',
      args: [],
    };
    if (cfg.type === 'stdio' || cfg.type === undefined) {
      expect(cfg.command).toBe('npx');
    }
  });

  it('accepts an http entry with headers', () => {
    const cfg: McpServerConfig = {
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      headers: { Authorization: 'Bearer onecli-managed' },
    };
    if (cfg.type === 'http') {
      expect(cfg.url).toBe('https://mcp.linear.app/mcp');
      expect(cfg.headers?.Authorization).toContain('Bearer');
    }
  });

  it('accepts an sse entry', () => {
    const cfg: McpServerConfig = {
      type: 'sse',
      url: 'https://example.com/mcp/sse',
    };
    if (cfg.type === 'sse') {
      expect(cfg.url).toContain('sse');
    }
  });

  it('preserves an instructions field across variants', () => {
    const stdioWithInstructions: McpServerConfig = {
      command: 'foo',
      instructions: 'use this for X',
    };
    const httpWithInstructions: McpServerConfig = {
      type: 'http',
      url: 'https://x',
      instructions: 'use this for X',
    };
    expect(stdioWithInstructions.instructions).toBe('use this for X');
    expect(httpWithInstructions.instructions).toBe('use this for X');
  });
});
