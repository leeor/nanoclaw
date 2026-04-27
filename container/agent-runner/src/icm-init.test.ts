import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ensureIcmConfig } from './icm-init.js';

describe('ensureIcmConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-init-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates .icm/ directory and config.toml on first call', () => {
    const configPath = ensureIcmConfig(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, '.icm'))).toBe(true);
    expect(fs.existsSync(configPath)).toBe(true);
    expect(configPath).toBe(path.join(tmpDir, '.icm', 'config.toml'));
  });

  it('returns absolute path to config.toml', () => {
    const configPath = ensureIcmConfig(tmpDir);
    expect(path.isAbsolute(configPath)).toBe(true);
  });

  it('writes a config that points memories.db inside .icm/ with embeddings enabled', () => {
    const configPath = ensureIcmConfig(tmpDir);
    const contents = fs.readFileSync(configPath, 'utf8');

    expect(contents).toContain('[store]');
    expect(contents).toContain(`path = "${path.join(tmpDir, '.icm', 'memories.db')}"`);
    expect(contents).toContain('[embeddings]');
    expect(contents).toContain('enabled = true');
    expect(contents).toContain('model = "intfloat/multilingual-e5-base"');
  });

  it('is idempotent — second call does not overwrite existing config', () => {
    const configPath = ensureIcmConfig(tmpDir);
    const customContent = '# user-edited config\n[store]\npath = "/custom"\n';
    fs.writeFileSync(configPath, customContent);

    const secondPath = ensureIcmConfig(tmpDir);

    expect(secondPath).toBe(configPath);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(customContent);
  });

  it('handles existing .icm/ directory without a config.toml', () => {
    fs.mkdirSync(path.join(tmpDir, '.icm'), { recursive: true });
    const configPath = ensureIcmConfig(tmpDir);

    expect(fs.existsSync(configPath)).toBe(true);
  });
});
