import { afterEach, expect, test, vi } from 'vitest';
import { openSshTunnel } from '../src/mongo/tunnel.ts';
import { type MongoAccess } from '../src/profile.ts';

const state = vi.hoisted(() => ({
  read: vi.fn<(path: string, options?: unknown) => Promise<Buffer>>(),
  destroy: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({ readFile: state.read }));
vi.mock('../src/mongo/knownHosts.ts', () => ({ knownHostVerifier: () => () => true }));
vi.mock('ssh2', () => ({
  Client: class {
    destroy = state.destroy;
  },
}));

const target: MongoAccess = {
  profileName: 'fixture',
  serverName: 'mongodb',
  database: 'fixture',
  uri: 'mongodb://example.invalid',
  credentialsFile: 'unused',
  sshServerName: 'ssh',
  timeoutSeconds: 1,
  ssh: {
    host: 'example.invalid',
    port: 22,
    username: 'fixture',
    privateKeyPath: 'fixture-key',
    knownHostsPath: 'fixture-hosts',
    timeoutSeconds: 1,
  },
};

afterEach(() => vi.clearAllMocks());

test.each(['fixture-key', 'fixture-hosts'])('отмена завершает ожидание чтения %s', async (blockedPath) => {
  let releaseRead: (value: Buffer) => void = () => undefined;
  const pending = new Promise<Buffer>((resolve) => {
    releaseRead = resolve;
  });
  const delayedContents = Buffer.from('synthetic-file');
  state.read.mockImplementation(async (path) => (path === blockedPath ? pending : Buffer.from('synthetic-file')));
  const cancellation = new AbortController();
  const request = openSshTunnel(target, undefined, cancellation.signal);
  try {
    await expect.poll(() => state.read.mock.calls.some(([path]) => path === blockedPath)).toBe(true);
    cancellation.abort();
    const outcome = await Promise.race([
      request.then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 50)),
    ]);
    expect(outcome).toBe('rejected');
    expect(state.destroy).toHaveBeenCalledOnce();
  } finally {
    cancellation.abort();
    releaseRead(delayedContents);
    await request.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(delayedContents.every((byte) => byte === 0)).toBe(true);
});
