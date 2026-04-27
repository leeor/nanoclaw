import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Stub the OneCLI SDK so docker-args' top-level `new OneCLI({...})` doesn't
// try to talk to a gateway. ensureAgent + applyContainerConfig are no-ops.
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    async ensureAgent() {}
    async applyContainerConfig() {
      return false;
    }
  },
}));

const mockSpawn = vi.fn();
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import { CONTAINER_RUNTIME_BIN } from '../container-runtime.js';
import type { AgentGroup, Session } from '../types.js';

import { dockerBackend } from './docker.js';
import type { SpawnSpec } from './types.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function fakeSpec(overrides?: Partial<SpawnSpec>): SpawnSpec {
  const session: Session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: null,
    created_at: '2026-01-01T00:00:00Z',
  };
  const agentGroup: AgentGroup = {
    id: 'ag-1',
    name: 'Test',
    folder: 'test',
    agent_provider: null,
    created_at: '2026-01-01T00:00:00Z',
  };
  return {
    session,
    agentGroup,
    containerConfig: {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    },
    containerName: 'nanoclaw-v2-test-123',
    agentIdentifier: 'ag-1',
    provider: 'claude',
    providerContribution: {},
    mounts: [
      { hostPath: '/tmp/sess', containerPath: '/workspace', readonly: false },
      { hostPath: '/tmp/ro', containerPath: '/app/CLAUDE.md', readonly: true },
    ],
    ...overrides,
  };
}

describe('dockerBackend.spawn', () => {
  it('invokes child_process.spawn with the docker bin and args ending with the entry command', async () => {
    const fakeProc = { stderr: null, stdout: null, on: vi.fn() };
    mockSpawn.mockReturnValueOnce(fakeProc);

    const spec = fakeSpec();
    const handle = await dockerBackend.spawn(spec);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = mockSpawn.mock.calls[0];
    expect(bin).toBe(CONTAINER_RUNTIME_BIN);
    expect(Array.isArray(args)).toBe(true);

    // Sanity check on the build: starts with `run --rm --name <name>`,
    // includes the RW mount, the RO mount with :ro suffix, and ends with
    // the bun entrypoint.
    expect(args[0]).toBe('run');
    expect(args).toContain('--name');
    expect(args).toContain('nanoclaw-v2-test-123');
    expect(args).toContain('-v');
    expect(args).toContain('/tmp/sess:/workspace');
    expect(args).toContain('/tmp/ro:/app/CLAUDE.md:ro');
    expect(args[args.length - 1]).toBe('exec bun run /app/src/index.ts');

    expect(opts).toEqual({ stdio: ['ignore', 'pipe', 'pipe'] });

    expect(handle.containerName).toBe('nanoclaw-v2-test-123');
    expect(handle.process).toBe(fakeProc);
  });
});

describe('dockerBackend.stop', () => {
  it('calls docker stop on the underlying container name', async () => {
    mockExecSync.mockReturnValueOnce('');
    await dockerBackend.stop({
      process: { kill: vi.fn() } as unknown as import('child_process').ChildProcess,
      containerName: 'nanoclaw-v2-test-456',
    });
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-v2-test-456`,
      { stdio: 'pipe' },
    );
  });

  it('propagates stopContainer errors so the caller can SIGKILL fall back', async () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('container already stopped');
    });
    await expect(
      dockerBackend.stop({
        process: { kill: vi.fn() } as unknown as import('child_process').ChildProcess,
        containerName: 'nanoclaw-v2-test-789',
      }),
    ).rejects.toThrow(/already stopped/);
  });
});
