import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type Socket } from 'node:net';
import socks, { type SocksServer } from '@mongodb-js/socksv5';
import { Client, type ClientChannel } from 'ssh2';
import { ToolError } from '../errors.ts';
import { type MongoAccess } from '../profile.ts';
import { abortable } from './cancellation.ts';
import { knownHostVerifier } from './knownHosts.ts';

const { auth, createServer } = socks;

export interface SshTunnel {
  readonly proxyHost: string;
  readonly proxyPort: number;
  readonly proxyUsername: string;
  readonly proxyPassword: string;
  readonly signal: AbortSignal;
  close(): Promise<void>;
}

async function sshFile(path: string, field: string, signal: AbortSignal): Promise<Buffer> {
  try {
    signal.throwIfAborted();
    const contents = readFile(path, { signal }).then((buffer) => {
      if (signal.aborted) {
        buffer.fill(0);
        signal.throwIfAborted();
      }
      return buffer;
    });
    return await abortable(contents, signal);
  } catch {
    signal.throwIfAborted();
    throw new ToolError(
      'config_invalid',
      `Не удалось прочитать файл SSH в поле ${field}. Проверьте путь и доступ к файлу.`,
    );
  }
}

function connectionError(cause: unknown, hostRejected: boolean): ToolError {
  if (hostRejected) return new ToolError('ssh_host_key_invalid', 'SSH-сервер не прошёл проверку known_hosts.');
  const level = cause instanceof Error && 'level' in cause ? cause.level : undefined;
  if (level === 'client-authentication') return new ToolError('ssh_auth_failed', 'SSH-сервер отклонил аутентификацию.');
  return new ToolError('ssh_connection_failed', 'Не удалось установить или сохранить SSH-подключение.');
}

async function connectSsh(
  client: Client,
  target: MongoAccess,
  passphrase: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  const prefix = `servers.${target.sshServerName}`;
  const knownHosts = await sshFile(target.ssh.knownHostsPath, `${prefix}.knownHostsPath`, signal);
  const verify = knownHostVerifier(knownHosts.toString('utf8'), target.ssh.host, target.ssh.port);
  const key = await sshFile(target.ssh.privateKeyPath, `${prefix}.privateKeyPath`, signal);
  let hostRejected = false;
  try {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        client.destroy();
        reject(signal.reason);
      };
      const ready = (): void => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const failed = (cause: unknown): void => {
        signal.removeEventListener('abort', abort);
        reject(connectionError(cause, hostRejected));
      };
      client.once('ready', ready);
      client.once('error', failed);
      client.once('close', () => failed(undefined));
      signal.addEventListener('abort', abort, { once: true });
      try {
        client.connect({
          host: target.ssh.host,
          port: target.ssh.port,
          username: target.ssh.username,
          privateKey: key,
          passphrase,
          readyTimeout: target.ssh.timeoutSeconds * 1000,
          keepaliveInterval: 10000,
          keepaliveCountMax: 3,
          hostVerifier: (hostKey: Buffer) => {
            const accepted = verify(hostKey);
            hostRejected = !accepted;
            return accepted;
          },
        });
      } catch {
        failed(undefined);
      }
    });
  } finally {
    key.fill(0);
  }
}

interface TunnelResources {
  readonly sockets: Set<Socket>;
  readonly channels: Set<ClientChannel>;
  readonly failure: AbortController;
  closing: Promise<void> | undefined;
}

function bridge(client: Client, resources: TunnelResources): SocksServer {
  const server = createServer((request, accept, deny) => {
    if (resources.closing) {
      deny();
      return;
    }
    try {
      client.forwardOut(request.srcAddr, request.srcPort, request.dstAddr, request.dstPort, (error, channel) => {
        if (error) {
          deny();
          return;
        }
        const socket = resources.closing ? undefined : accept(true);
        if (!socket) {
          channel.destroy();
          deny();
          return;
        }
        resources.channels.add(channel);
        const dispose = (): void => {
          socket.destroy();
          channel.destroy();
          resources.channels.delete(channel);
        };
        socket.once('error', dispose);
        socket.once('close', dispose);
        channel.once('error', dispose);
        channel.once('close', dispose);
        socket.pipe(channel).pipe(socket);
      });
    } catch {
      deny();
      resources.failure.abort(connectionError(undefined, false));
    }
  });
  server._srv.on('connection', (socket) => {
    if (resources.closing) {
      socket.destroy();
      return;
    }
    resources.sockets.add(socket);
    socket.once('close', () => resources.sockets.delete(socket));
  });
  return server;
}

export async function openSshTunnel(
  target: MongoAccess,
  passphrase: string | undefined,
  signal: AbortSignal,
): Promise<SshTunnel> {
  const client = new Client();
  const resources: TunnelResources = {
    sockets: new Set<Socket>(),
    channels: new Set<ClientChannel>(),
    failure: new AbortController(),
    closing: undefined,
  };
  const { failure } = resources;
  let server: SocksServer | undefined;
  const close = (): Promise<void> => {
    resources.closing ??= (async () => {
      for (const socket of resources.sockets) socket.destroy();
      for (const channel of resources.channels) channel.destroy();
      client.destroy();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    })();
    return resources.closing;
  };
  try {
    await connectSsh(client, target, passphrase, signal);
    client.on('error', () => failure.abort(connectionError(undefined, false)));
    client.on('close', () => {
      if (!resources.closing) failure.abort(connectionError(undefined, false));
    });
    server = bridge(client, resources);
    const proxyUsername = randomBytes(24).toString('hex');
    const proxyPassword = randomBytes(24).toString('hex');
    server.useAuth(
      auth.UserPassword((username, password, complete) =>
        complete(username === proxyUsername && password === proxyPassword),
      ),
    );
    server.on('error', () => failure.abort(connectionError(undefined, false)));
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw connectionError(undefined, false);
    signal.throwIfAborted();
    return {
      proxyHost: '127.0.0.1',
      proxyPort: address.port,
      proxyUsername,
      proxyPassword,
      signal: failure.signal,
      close,
    };
  } catch (cause) {
    await close();
    throw cause;
  }
}
