/**
 * Mock implementation of Cloudflare's Socket and the `cloudflare:sockets` module.
 * Validates that CloudflareTransport uses the CF Socket API correctly.
 */

export interface MockSocketCall {
  method: string;
  args: unknown[];
}

export class MockSocket {
  readonly calls: MockSocketCall[] = [];

  private _readable: ReadableStream<Uint8Array>;
  private _writable: WritableStream<Uint8Array>;
  private _readController!: ReadableStreamDefaultController<Uint8Array>;
  private _closed: Promise<void>;
  private _resolveClosed!: () => void;
  private _opened: Promise<{ remoteAddress: string; localAddress: string }>;
  writtenFrames: Uint8Array[] = [];
  secureTransport: "on" | "off" | "starttls";
  upgraded = false;
  startTlsCalled = false;

  constructor(opts?: { secureTransport?: string }) {
    this.secureTransport = (opts?.secureTransport ?? "off") as "on" | "off" | "starttls";

    this._readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this._readController = controller;
      },
    });

    this._writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.writtenFrames.push(chunk);
      },
    });

    this._opened = Promise.resolve({ remoteAddress: "127.0.0.1:4222", localAddress: "127.0.0.1:9999" });
    this._closed = new Promise<void>((resolve) => {
      this._resolveClosed = resolve;
    });
  }

  get readable(): ReadableStream<Uint8Array> {
    return this._readable;
  }

  get writable(): WritableStream<Uint8Array> {
    return this._writable;
  }

  get opened(): Promise<{ remoteAddress: string; localAddress: string }> {
    return this._opened;
  }

  get closed(): Promise<void> {
    return this._closed;
  }

  async close(): Promise<void> {
    this.calls.push({ method: "close", args: [] });
    try {
      this._readController.close();
    } catch {
      // already closed
    }
    this._resolveClosed();
  }

  startTls(options?: { expectedServerHostname?: string }): MockSocket {
    this.calls.push({ method: "startTls", args: [options] });
    this.startTlsCalled = true;
    const upgraded = new MockSocket({ secureTransport: "on" });
    upgraded.upgraded = true;
    return upgraded;
  }

  /** Push data into the readable stream as if received from the server */
  enqueueData(data: Uint8Array): void {
    this._readController.enqueue(data);
  }

  /** Signal EOF on the readable stream */
  closeReadable(): void {
    try {
      this._readController.close();
    } catch {
      // already closed
    }
  }
}

// Shared state for tracking cfConnect calls
export const connectCalls: Array<{ address: unknown; options: unknown }> = [];
let nextSocket: MockSocket | null = null;

export function setNextSocket(socket: MockSocket): void {
  nextSocket = socket;
}

export function resetMock(): void {
  connectCalls.length = 0;
  nextSocket = null;
}

export function mockCfConnect(
  address: string | { hostname: string; port: number },
  options?: { secureTransport?: string; allowHalfOpen?: boolean },
): MockSocket {
  connectCalls.push({ address, options });
  if (nextSocket) {
    const s = nextSocket;
    nextSocket = null;
    return s;
  }
  return new MockSocket(options);
}
