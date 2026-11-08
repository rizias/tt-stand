declare module '@mongodb-js/socksv5' {
  import { EventEmitter } from 'node:events';
  import { type AddressInfo, type Server, type Socket } from 'node:net';

  export interface SocksRequest {
    srcAddr: string;
    srcPort: number;
    dstAddr: string;
    dstPort: number;
  }

  export interface SocksServer extends EventEmitter {
    readonly _srv: Server;
    listen(port: number, host: string, callback: () => void): this;
    close(callback: (error?: Error) => void): this;
    address(): AddressInfo | string | null;
    useAuth(auth: unknown): this;
  }

  export function createServer(
    listener: (request: SocksRequest, accept: (intercept: true) => Socket | undefined, deny: () => void) => void,
  ): SocksServer;

  export const auth: {
    UserPassword(
      validate: (username: string, password: string, complete: (accepted: boolean) => void) => void,
    ): unknown;
  };

  const socks: { createServer: typeof createServer; auth: typeof auth };
  export default socks;
}
