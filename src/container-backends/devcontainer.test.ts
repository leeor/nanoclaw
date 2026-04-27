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

// OneCLI stub: applyContainerConfig populates the args array with one
// `-e HTTPS_PROXY=http://proxy:8080` pair so we can assert the env capture.
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    async ensureAgent() {}
    async applyContainerConfig(args: string[]) {
      args.push('-e', 'HTTPS_PROXY=http://proxy:8080');
      args.push('-e', 'NODE_EXTRA_CA_CERTS=/certs/onecli.pem');
      return true;
    }
  },
}));

const mockSpawn = vi.fn();
const mockExecSync = vi.fn();
const fakeProcEvents: Array<{ event: string; cb: (...a: unknown[]) => void }> = [];

function makeFakeProc(): unknown {
  fakeProcEvents.length = 0;
  return {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: (event: string, cb: (...a: unknown[]) => void) => {
      fakeProcEvents.push({ event, cb });
    },
    kill: vi.fn(),
  };
}

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import type { AgentGroup, Session } from '../types.js';

import { devcontainerBackend } from './devcontainer.js';
import type { SpawnSpec } from './types.js';

beforeEach(() => {
  vi.clearAllMocks();
  fakeProcEvents.length = 0;
});

function fakeSpec(overrides?: Partial<SpawnSpec>): SpawnSpec {
  const session: Session = {
    id: 'sess-dc-1',
    agent_group_id: 'ag-dc-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: null,
    created_at: '2026-01-01T00:00:00Z',
  };
  const agentGroup: AgentGroup = {
    id: 'ag-dc-1',
    name: 'Coding',
    folder: 'coding',
    agent_provider: null,
    created_at: '2026-01-01T00:00:00Z',
  };
  const containerConfig = {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all' as const,
    devcontainer: {
      workspaceFolder: '/host/wt/feature-x',
    },
  };
  return {
    session,
    agentGroup,
    containerConfig: containerConfig as unknown as SpawnSpec['containerConfig'],
    containerName: 'devcontainer-coding-feature-x',
    agentIdentifier: 'ag-dc-1',
    provider: 'claude',
    providerContribution: { env: { XDG_DATA_HOME: '/data' } },
    mounts: [],
    ...overrides,
  };
}

describe('devcontainerBackend.spawn', () => {
  it('throws when workspaceFolder is missing', async () => {
    const spec = fakeSpec({
      containerConfig: {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
      },
    });
    await expect(devcontainerBackend.spawn(spec)).rejects.toThrow(/workspaceFolder is required/);
  });

  it('runs `devcontainer up` then `devcontainer exec` with id-labels and remote env', async () => {
    // First call: up — emits close(0).
    const upProc = makeFakeProc();
    // Second call: exec — long-lived; we just capture args.
    const execProc = makeFakeProc();
    mockSpawn.mockImplementationOnce(() => {
      // Schedule close(0) on next microtask so the up promise resolves.
      queueMicrotask(() => {
        for (const ev of fakeProcEvents) {
          if (ev.event === 'close') ev.cb(0);
        }
      });
      return upProc;
    });
    mockSpawn.mockImplementationOnce(() => execProc);

    const spec = fakeSpec();
    const handle = await devcontainerBackend.spawn(spec);

    expect(mockSpawn).toHaveBeenCalledTimes(2);

    const [upBin, upArgs] = mockSpawn.mock.calls[0];
    expect(upBin).toBe('devcontainer');
    expect(upArgs[0]).toBe('up');
    expect(upArgs).toContain('--workspace-folder');
    expect(upArgs).toContain('/host/wt/feature-x');
    expect(upArgs).toContain('--id-label');
    expect(upArgs).toContain('nanoclaw.session=sess-dc-1');
    expect(upArgs).toContain('nanoclaw.agent-group=ag-dc-1');

    const [execBin, execArgs] = mockSpawn.mock.calls[1];
    expect(execBin).toBe('devcontainer');
    expect(execArgs[0]).toBe('exec');
    expect(execArgs).toContain('--workspace-folder');
    expect(execArgs).toContain('/host/wt/feature-x');
    // OneCLI proxy env captured via probe and forwarded as --remote-env.
    expect(execArgs).toContain('--remote-env');
    expect(execArgs).toContain('HTTPS_PROXY=http://proxy:8080');
    expect(execArgs).toContain('NODE_EXTRA_CA_CERTS=/certs/onecli.pem');
    // Provider contribution env forwarded.
    expect(execArgs).toContain('XDG_DATA_HOME=/data');
    // Final command runs the agent-runner.
    expect(execArgs[execArgs.length - 1]).toBe('exec bun run /app/src/index.ts');

    expect(handle.containerName).toBe('devcontainer-coding-feature-x');
    expect(handle.process).toBe(execProc);
    expect((handle.meta as { workspaceFolder: string }).workspaceFolder).toBe('/host/wt/feature-x');
  });

  it('rejects when devcontainer up exits non-zero', async () => {
    const upProc = makeFakeProc();
    mockSpawn.mockImplementationOnce(() => {
      queueMicrotask(() => {
        for (const ev of fakeProcEvents) {
          if (ev.event === 'close') ev.cb(2);
        }
      });
      return upProc;
    });
    await expect(devcontainerBackend.spawn(fakeSpec())).rejects.toThrow(/devcontainer up exited 2/);
  });
});

describe('devcontainerBackend.stop', () => {
  it('issues `devcontainer stop --workspace-folder` for the spawned worktree', async () => {
    mockExecSync.mockReturnValueOnce('');
    await devcontainerBackend.stop({
      process: { kill: vi.fn() } as unknown as import('child_process').ChildProcess,
      containerName: 'devcontainer-coding-feature-x',
      meta: {
        workspaceFolder: '/host/wt/feature-x',
        idLabels: { 'nanoclaw.session': 'sess-dc-1' },
      },
    });
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    const [cmd] = mockExecSync.mock.calls[0];
    expect(cmd).toContain('devcontainer stop --workspace-folder');
    expect(cmd).toContain("'/host/wt/feature-x'");
  });

  it('falls back to docker stop by id-label when devcontainer stop fails', async () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('devcontainer stop failed');
    });
    // docker ps -q returns one id
    mockExecSync.mockReturnValueOnce(Buffer.from('abc123\n'));
    // docker stop -t 1 abc123
    mockExecSync.mockReturnValueOnce('');

    await devcontainerBackend.stop({
      process: { kill: vi.fn() } as unknown as import('child_process').ChildProcess,
      containerName: 'devcontainer-coding-feature-x',
      meta: {
        workspaceFolder: '/host/wt/feature-x',
        idLabels: { 'nanoclaw.session': 'sess-dc-1' },
      },
    });

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync.mock.calls[1][0]).toContain('docker ps -q');
    expect(mockExecSync.mock.calls[1][0]).toContain('--filter label=nanoclaw.session=sess-dc-1');
    expect(mockExecSync.mock.calls[2][0]).toContain('docker stop -t 1 abc123');
  });

  it('no-ops when handle.meta is missing', async () => {
    await devcontainerBackend.stop({
      process: { kill: vi.fn() } as unknown as import('child_process').ChildProcess,
      containerName: 'never-spawned',
    });
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});
