import { describe, expect, it } from 'vitest';

import {
  _unregisterContainerBackendForTest,
  getContainerBackend,
  listContainerBackendNames,
  registerContainerBackend,
} from './registry.js';
import type { ContainerBackend } from './types.js';

function fakeBackend(name: string): ContainerBackend {
  return {
    name,
    spawn: async () => {
      throw new Error('not used');
    },
    stop: async () => {
      /* no-op */
    },
  };
}

describe('container-backend registry', () => {
  it('register + get round-trips a backend', () => {
    const name = 'test-roundtrip';
    _unregisterContainerBackendForTest(name);

    const backend = fakeBackend(name);
    registerContainerBackend(backend);

    expect(getContainerBackend(name)).toBe(backend);

    _unregisterContainerBackendForTest(name);
  });

  it('list includes registered names', () => {
    const name = 'test-list';
    _unregisterContainerBackendForTest(name);

    registerContainerBackend(fakeBackend(name));
    expect(listContainerBackendNames()).toContain(name);

    _unregisterContainerBackendForTest(name);
  });

  it('throws on duplicate registration', () => {
    const name = 'test-dup';
    _unregisterContainerBackendForTest(name);

    registerContainerBackend(fakeBackend(name));
    expect(() => registerContainerBackend(fakeBackend(name))).toThrow(
      /Container backend already registered: test-dup/,
    );

    _unregisterContainerBackendForTest(name);
  });

  it('returns undefined for unregistered names', () => {
    expect(getContainerBackend('does-not-exist')).toBeUndefined();
  });
});
