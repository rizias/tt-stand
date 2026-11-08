import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Server, utils, type Connection, type ParsedKey } from 'ssh2';
import { type MongoAccess } from '../../src/profile.ts';

const username = 'fixture-reader-with-write-access';
const password = 'fixture-mongodb-password';

function generateKey(): { privateKey: string; parsed: ParsedKey } {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const parsed = utils.parseKey(pair.privateKey);
  if (parsed instanceof Error) throw parsed;
  return { privateKey: pair.privateKey, parsed };
}

export interface MongoFixture {
  readonly directory: string;
  readonly target: MongoAccess;
  readonly control: MongoClient;
  readonly forwarded: Array<{ host: string; port: number }>;
  readonly connections: Set<Connection>;
  connectionsOpened(): number;
  close(): Promise<void>;
}

export async function createMongoFixture(): Promise<MongoFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'tt-stand-mongo-fixture-'));
  const mongo = await MongoMemoryReplSet.create({
    replSet: {
      count: 2,
      auth: { enable: true, customRootName: username, customRootPwd: password },
      args: ['--setParameter', 'enableTestCommands=1'],
    },
  });
  const control = new MongoClient(mongo.getUri('admin'), {
    auth: { username, password },
    appName: 'tt-stand-fixture-control',
  });
  await control.connect();
  const hostKey = generateKey();
  const clientKey = generateKey();
  const connections = new Set<Connection>();
  const sockets = new Set<Socket>();
  const forwarded: Array<{ host: string; port: number }> = [];
  let opened = 0;
  const server = new Server({ hostKeys: [hostKey.privateKey] }, (connection) => {
    opened += 1;
    connections.add(connection);
    connection.on('error', () => undefined);
    connection.once('close', () => connections.delete(connection));
    connection.on('authentication', (context) => {
      if (context.method !== 'publickey' || !context.key.data.equals(clientKey.parsed.getPublicSSH())) {
        context.reject();
        return;
      }
      if (
        context.signature &&
        (!context.blob || !clientKey.parsed.verify(context.blob, context.signature, context.hashAlgo))
      ) {
        context.reject();
        return;
      }
      context.accept();
    });
    connection.on('tcpip', (accept, reject, info) => {
      forwarded.push({ host: info.destIP, port: info.destPort });
      const socket = connect({
        host: info.destIP === 'mongo.example.invalid' ? '127.0.0.1' : info.destIP,
        port: info.destPort,
      });
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.once('error', () => {
        reject();
        socket.destroy();
      });
      socket.once('connect', () => {
        const channel = accept();
        channel.on('error', () => socket.destroy());
        channel.once('close', () => socket.destroy());
        socket.once('close', () => channel.destroy());
        channel.pipe(socket).pipe(channel);
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('Нет адреса тестового SSH-сервера');
  const privateKeyPath = join(directory, 'client-key.pem');
  const knownHostsPath = join(directory, 'known_hosts');
  const credentialsFile = join(directory, 'credentials.json');
  await writeFile(privateKeyPath, clientKey.privateKey);
  await writeFile(
    knownHostsPath,
    `[127.0.0.1]:${address.port} ${hostKey.parsed.type} ${hostKey.parsed.getPublicSSH().toString('base64')}\n`,
  );
  await writeFile(credentialsFile, JSON.stringify({ ssh: {}, mongodb: { username, password } }));
  const seedPort = mongo.servers[0]!.instanceInfo!.port;
  const target: MongoAccess = {
    profileName: 'fixture',
    serverName: 'mongodb',
    sshServerName: 'ssh',
    database: 'investigation',
    uri: `mongodb://mongo.example.invalid:${seedPort}/admin?replicaSet=${mongo.replSetOpts.name}`,
    credentialsFile,
    timeoutSeconds: 15,
    ssh: {
      host: '127.0.0.1',
      port: address.port,
      username: 'fixture-ssh-user',
      privateKeyPath,
      knownHostsPath,
      timeoutSeconds: 10,
    },
  };
  return {
    directory,
    target,
    control,
    forwarded,
    connections,
    connectionsOpened: () => opened,
    close: async () => {
      for (const connection of connections) connection.end();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await control.close();
      await mongo.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
