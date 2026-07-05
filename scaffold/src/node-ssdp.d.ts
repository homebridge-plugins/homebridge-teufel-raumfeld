/**
 * Minimal ambient types for `node-ssdp` (the package ships none).
 * Only the surface this plugin uses is declared.
 */
declare module 'node-ssdp' {
  import type { EventEmitter } from 'node:events';

  export interface RemoteInfo {
    address: string;
    port: number;
  }

  export class Client extends EventEmitter {
    constructor(options?: Record<string, unknown>);
    search(serviceType: string): void;
    stop(): void;
    on(
      event: 'response',
      listener: (headers: Record<string, string>, statusCode: number, rinfo: RemoteInfo) => void,
    ): this;
  }

  export class Server extends EventEmitter {
    constructor(options?: Record<string, unknown>);
    start(): void;
    stop(): void;
  }

  const _default: { Client: typeof Client; Server: typeof Server };
  export default _default;
}
