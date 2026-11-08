import dns from 'node:dns';
import net from 'node:net';
import { afterEach, expect, test, vi } from 'vitest';
import { MongoClient } from 'mongodb';
import { executeMongoRead } from '../src/mongo/execute.ts';
import { prepareMongoRead } from '../src/mongo/prepare.ts';
import { type MongoAccess } from '../src/profile.ts';

const state = vi.hoisted(() => ({ tunnelClosed: vi.fn(async () => undefined) }));

vi.mock('../src/credentials.ts', () => ({ readServerCredentials: () => ({}) }));
vi.mock('../src/mongo/tunnel.ts', () => ({
  openSshTunnel: async () => ({
    proxyHost: '127.0.0.1',
    proxyPort: 1,
    proxyUsername: 'fixture',
    proxyPassword: 'fixture',
    signal: new AbortController().signal,
    close: state.tunnelClosed,
  }),
}));

const target: MongoAccess = {
  profileName: 'fixture',
  serverName: 'mongodb',
  database: 'fixture',
  uri: 'mongodb+srv://cluster.example.invalid/?tls=false',
  credentialsFile: 'unused',
  sshServerName: 'ssh',
  timeoutSeconds: 1,
  ssh: {
    host: 'example.invalid',
    port: 22,
    username: 'fixture',
    privateKeyPath: 'unused',
    knownHostsPath: 'unused',
    timeoutSeconds: 1,
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

test.each(['cancel', 'timeout'])('поздний SRV после %s закрывается до создания сетевых соединений', async (mode) => {
  let releaseDns: (records: dns.SrvRecord[]) => void = () => undefined;
  const delayedDns = new Promise<dns.SrvRecord[]>((resolve) => {
    releaseDns = resolve;
  });
  const resolver = vi.spyOn(dns.promises, 'resolve').mockImplementation(async (_hostname, kind) => {
    if (kind === 'TXT') return [['']];
    if (kind === 'SRV') return delayedDns;
    throw new Error('Неожиданный тип DNS в фикстуре');
  });
  const tcp = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(() => {
    throw new Error('Сетевое соединение запрещено в фикстуре');
  });
  const originalConnect = MongoClient.prototype.connect;
  const clients: MongoClient[] = [];
  let connecting: Promise<MongoClient> | undefined;
  const serverOpened = vi.fn();
  const topologyClosed = vi.fn();
  vi.spyOn(MongoClient.prototype, 'connect').mockImplementation(function (this: MongoClient) {
    clients.push(this);
    this.on('serverOpening', serverOpened);
    this.on('topologyClosed', topologyClosed);
    connecting = originalConnect.call(this);
    return connecting;
  });
  const cancellation = new AbortController();
  const current = mode === 'timeout' ? { ...target, timeoutSeconds: 0.02 } : target;
  const request = executeMongoRead(current, prepareMongoRead('{"find":"orders"}'), {
    signal: cancellation.signal,
  }).catch((cause: unknown) => cause);
  try {
    await expect.poll(() => resolver.mock.calls.length).toBe(2);
    if (mode === 'cancel') cancellation.abort();
    expect(await request).toMatchObject({ errorClass: mode === 'cancel' ? 'stream_aborted' : 'timeout_client' });
    expect(state.tunnelClosed).toHaveBeenCalledOnce();
    releaseDns([{ name: 'node.example.invalid', port: 27017, priority: 0, weight: 0 }]);
    await connecting?.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(tcp).not.toHaveBeenCalled();
    expect(serverOpened).not.toHaveBeenCalled();
    expect(topologyClosed).toHaveBeenCalledOnce();
    expect(clients).toHaveLength(1);
    expect(Reflect.get(clients[0]!, 'topology')).toBeUndefined();
  } finally {
    cancellation.abort();
    releaseDns([{ name: 'node.example.invalid', port: 27017, priority: 0, weight: 0 }]);
    await request.catch(() => undefined);
    await connecting?.catch(() => undefined);
    for (const client of clients) await client.close();
  }
});
