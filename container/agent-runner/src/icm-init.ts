/**
 * ICM (Infinite Context Memory) per-group config initializer.
 *
 * Wired in `index.ts` only when the agent group opts in via
 * `mcpServers.icm` in its `container.json`. The agent-runner auto-fills
 * `ICM_CONFIG` so operator config stays minimal.
 *
 * Lives under the per-group folder so memories persist across container
 * restarts via the /workspace/agent bind mount. Embeddings on by default
 * for semantic recall.
 */
import fs from 'fs';
import path from 'path';

/**
 * Initialize per-group ICM config under `<groupDir>/.icm` if missing.
 * Returns the absolute path to `config.toml` — pass this to the icm MCP
 * server's `ICM_CONFIG` env var.
 *
 * Idempotent — only writes paths that don't already exist.
 */
export function ensureIcmConfig(groupDir: string): string {
  const icmDir = path.join(groupDir, '.icm');
  const configPath = path.join(icmDir, 'config.toml');
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(icmDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      `[store]\npath = "${path.join(icmDir, 'memories.db')}"\n\n[embeddings]\nenabled = true\nmodel = "intfloat/multilingual-e5-base"\n`,
    );
  }
  return configPath;
}
