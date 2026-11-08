export type ServerKind = 'ssh' | 'mongodb';
type Scalar = string | number | null;

export interface FieldValue {
  value: Scalar | readonly string[];
  source: 'file' | 'default';
}

export interface FieldSchema {
  type: 'string' | 'number';
  default: Scalar;
  path?: boolean;
  positive?: boolean;
  port?: boolean;
  uri?: boolean;
}

interface ServerSchema {
  fields: Readonly<Record<string, FieldSchema>>;
  secrets: readonly string[];
}

const optionalString: FieldSchema = { type: 'string', default: null };
const timeout: FieldSchema = { type: 'number', default: 30, positive: true };

export const SERVER_SCHEMAS: Readonly<Record<ServerKind, ServerSchema>> = {
  ssh: {
    fields: {
      host: optionalString,
      port: { type: 'number', default: 22, port: true },
      username: optionalString,
      privateKeyPath: { ...optionalString, path: true },
      knownHostsPath: { type: 'string', default: '~/.ssh/known_hosts', path: true },
      timeoutSeconds: timeout,
    },
    secrets: ['passphrase'],
  },
  mongodb: {
    fields: {
      uri: { ...optionalString, uri: true },
      sshServer: optionalString,
      defaultDatabase: optionalString,
      timeoutSeconds: timeout,
    },
    secrets: ['username', 'password'],
  },
};

export interface SshServer {
  kind: 'ssh';
  host: string | null;
  port: number;
  username: string | null;
  privateKeyPath: string | null;
  knownHostsPath: string;
  timeoutSeconds: number;
}

export interface MongoServer {
  kind: 'mongodb';
  uri: string | null;
  sshServer: string | null;
  defaultDatabase: string | null;
  timeoutSeconds: number;
}

export type Server = SshServer | MongoServer;
