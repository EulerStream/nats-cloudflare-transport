/*
 * Copyright 2024 The NATS Authors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {connect as cfConnect} from "cloudflare:sockets";

import type {ConnectionOptions, Deferred, Server, ServerInfo, Transport,} from "@nats-io/nats-core/internal";
import {
  checkOptions,
  DataBuffer,
  deferred,
  Empty,
  errors,
  extractProtocolMessage,
  INFO,
  render,
} from "@nats-io/nats-core/internal";

import {version} from "./version.js";

const VERSION = version;
const LANG = "nats.cloudflare";

const ReadBufferSize = 1024 * 256;

export class CloudflareTransport implements Transport {
  version: string = VERSION;
  lang: string = LANG;
  closeError?: Error;
  private options!: ConnectionOptions;
  private buf: Uint8Array;
  private encrypted = false;
  private done = false;
  private closedNotification: Deferred<void | Error> = deferred();
  private socket!: Socket;
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private writer!: WritableStreamDefaultWriter<Uint8Array>;
  private frames: Array<Uint8Array>;
  private pendingWrite: Promise<void> | null;

  constructor() {
    this.buf = new Uint8Array(ReadBufferSize);
    this.frames = [];
    this.pendingWrite = null;
  }

  async connect(
    hp: Server,
    options: ConnectionOptions,
  ): Promise<void> {
    this.options = options;

    const { tls } = this.options;
    const { handshakeFirst } = tls || {};

    try {
      if (handshakeFirst === true) {
        // Connect with TLS immediately
        this.socket = cfConnect(
          { hostname: hp.hostname, port: hp.port },
          { secureTransport: "on", allowHalfOpen: false },
        );
        await this.socket.opened;
        this.encrypted = true;
      } else {
        // Connect plain TCP, but allow STARTTLS upgrade later
        this.socket = cfConnect(
          { hostname: hp.hostname, port: hp.port },
          { secureTransport: "starttls", allowHalfOpen: false },
        );
        await this.socket.opened;
      }

      this.reader = this.socket.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
      this.writer = this.socket.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;

      if (this.done) {
        await this.socket.close();
        return;
      }

      const info = await this.peekInfo();
      checkOptions(info, this.options);
      const { tls_required: tlsRequired, tls_available: tlsAvailable } = info;
      const desired = tlsAvailable === true && options.tls !== null;

      if (!handshakeFirst && (tlsRequired || desired)) {
        const tlsn = hp.tlsName ? hp.tlsName : hp.hostname;
        await this.startTLS(tlsn);
      }

      if (this.done) {
        await this.socket.close();
      }
    } catch (err) {
      try {
        await this.socket?.close();
      } catch {
        // ignored
      }
      const _err = err as Error;
      throw new errors.ConnectionError(_err.message.toLowerCase(), {
        cause: err,
      });
    }
  }

  get isClosed(): boolean {
    return this.done;
  }

  async peekInfo(): Promise<ServerInfo> {
    const inbound = new DataBuffer();
    let pm: string;
    while (true) {
      const { value, done } = await this.reader.read();
      if (done || !value) {
        throw new Error("socket closed while expecting INFO");
      }
      const frame = value;
      if (this.options.debug) {
        console.info(`> ${render(frame)}`);
      }
      inbound.fill(frame);
      const raw = inbound.peek();
      pm = extractProtocolMessage(raw);
      if (pm !== "") {
        break;
      }
    }
    // Store the initial data so the async iterator yields it first
    this.buf = new Uint8Array(inbound.drain());
    // Expecting the INFO protocol
    const m = INFO.exec(pm!);
    if (!m) {
      throw new Error("unexpected response from server");
    }
    return JSON.parse(m[1]) as ServerInfo;
  }

  async startTLS(hostname: string): Promise<void> {
    // Release current reader/writer before upgrading
    this.reader.releaseLock();
    this.writer.releaseLock();

    // Upgrade the socket to TLS — returns a new Socket
    this.socket = this.socket.startTls({
      expectedServerHostname: hostname,
    });

    // Get new reader/writer from the upgraded socket
    this.reader = this.socket.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    this.writer = this.socket.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;

    // Write empty to verify TLS handshake (mirrors Deno transport behavior)
    await this.writer.write(Empty);
    this.encrypted = true;
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    let reason: Error | undefined;
    // Yield what we initially read during peekInfo
    yield this.buf;

    while (!this.done) {
      try {
        const { value, done } = await this.reader.read();
        if (done || !value) {
          break;
        }
        const frame = value;
        if (this.options.debug) {
          console.info(`> ${render(frame)}`);
        }
        yield frame;
      } catch (err) {
        reason = err as Error;
        break;
      }
    }
    this._closed(reason).then().catch();
  }

  maybeWriteFrame(): void {
    if (this.pendingWrite) {
      return;
    }

    const frame = this.frames.shift();
    if (!frame) {
      return;
    }

    this.pendingWrite = this.writer.write(frame).then(() => {
      this.pendingWrite = null;
      this.maybeWriteFrame();
    }).then(() => {
      if (this.options.debug) {
        console.info(`< ${render(frame)}`);
      }
    }).catch((err) => {
      if (this.options.debug) {
        console.error(`!!! ${render(frame)}: ${err}`);
      }
    });
  }

  send(frame: Uint8Array): void {
    if (this.done) {
      return;
    }
    this.frames.push(frame);
    this.maybeWriteFrame();
  }

  isEncrypted(): boolean {
    return this.encrypted;
  }

  close(err?: Error): Promise<void> {
    return this._closed(err, false);
  }

  disconnect(): void {
    this._closed(undefined, true).then().catch();
  }

  async _closed(err?: Error, internal = true): Promise<void> {
    if (this.done) {
      try {
        await this.socket?.close();
      } catch {
        // ignored
      }
      return;
    }
    this.done = true;
    this.closeError = err;

    if (!err && internal) {
      try {
        // Flush pending writes before closing
        this.frames.push(Empty);
        this.maybeWriteFrame();
        if (this.pendingWrite) {
          await this.pendingWrite;
        }
      } catch (err) {
        if (this.options.debug) {
          console.log("transport close terminated with an error", err);
        }
      }
    }

    try {
      await this.socket?.close();
    } catch {
      // ignored
    }

    if (internal) {
      this.closedNotification.resolve(err);
    }
  }

  closed(): Promise<void | Error> {
    return this.closedNotification;
  }

  discard(): void {
    // Not required — no throttling in Cloudflare Workers
  }
}
