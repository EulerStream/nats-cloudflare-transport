/**
 * Cloudflare-side contract tests.
 *
 * Verify that CloudflareTransport calls the Cloudflare Socket API
 * (cloudflare:sockets) with the correct arguments and lifecycle.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MockSocket,
  connectCalls,
  resetMock,
  setNextSocket,
  mockCfConnect,
} from "./mock_socket.js";

vi.mock("cloudflare:sockets", () => ({ connect: mockCfConnect }));

import { CloudflareTransport } from "../src/cloudflare_transport.js";

// Minimal NATS INFO payload the server would send
function makeInfoFrame(overrides: Record<string, unknown> = {}): Uint8Array {
  const info = {
    server_id: "test",
    server_name: "test",
    version: "2.10.0",
    proto: 1,
    go: "go1.21",
    host: "127.0.0.1",
    port: 4222,
    max_payload: 1048576,
    tls_required: false,
    tls_available: false,
    ...overrides,
  };
  const msg = `INFO ${JSON.stringify(info)}\r\n`;
  return new TextEncoder().encode(msg);
}

function makeServer() {
  return {
    hostname: "nats.example.com",
    port: 4222,
    tlsName: "",
    listen: "nats.example.com:4222",
    src: "nats.example.com:4222",
    resolve: async () => [] as any[],
  };
}

describe("Cloudflare Socket contract", () => {
  beforeEach(() => {
    resetMock();
  });

  it("calls cfConnect with correct address and starttls by default", async () => {
    const mock = new MockSocket({ secureTransport: "starttls" });
    setNextSocket(mock);

    const transport = new CloudflareTransport();
    const server = makeServer();

    setTimeout(() => mock.enqueueData(makeInfoFrame()), 10);

    await transport.connect(server, { servers: "nats.example.com:4222" });

    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0].address).toEqual({ hostname: "nats.example.com", port: 4222 });
    expect(connectCalls[0].options).toEqual({
      secureTransport: "starttls",
      allowHalfOpen: false,
    });
  });

  it("calls cfConnect with secureTransport 'on' when handshakeFirst is true", async () => {
    const mock = new MockSocket({ secureTransport: "on" });
    setNextSocket(mock);

    const transport = new CloudflareTransport();
    const server = makeServer();

    setTimeout(() => mock.enqueueData(makeInfoFrame({ tls_required: true, tls_available: true })), 10);

    await transport.connect(server, {
      servers: "nats.example.com:4222",
      tls: { handshakeFirst: true },
    });

    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0].options).toEqual({
      secureTransport: "on",
      allowHalfOpen: false,
    });
    expect(transport.isEncrypted()).toBe(true);
  });

  it("upgrades to TLS via socket.startTls when server requires it", async () => {
    const mock = new MockSocket({ secureTransport: "starttls" });
    setNextSocket(mock);

    const transport = new CloudflareTransport();
    const server = makeServer();
    server.hostname = "secure.nats.io";

    setTimeout(() => mock.enqueueData(makeInfoFrame({ tls_required: true })), 10);

    await transport.connect(server, { servers: "secure.nats.io:4222" });

    expect(mock.startTlsCalled).toBe(true);
    const tlsCall = mock.calls.find((c) => c.method === "startTls")!;
    expect(tlsCall.args[0]).toEqual({ expectedServerHostname: "secure.nats.io" });
    expect(transport.isEncrypted()).toBe(true);
  });

  it("uses tlsName for startTls hostname when provided", async () => {
    const mock = new MockSocket({ secureTransport: "starttls" });
    setNextSocket(mock);

    const transport = new CloudflareTransport();
    const server = makeServer();
    server.hostname = "10.0.0.1";
    server.tlsName = "nats.internal.io";

    setTimeout(() => mock.enqueueData(makeInfoFrame({ tls_required: true })), 10);

    await transport.connect(server, { servers: "10.0.0.1:4222" });

    const tlsCall = mock.calls.find((c) => c.method === "startTls")!;
    expect(tlsCall.args[0]).toEqual({ expectedServerHostname: "nats.internal.io" });
  });

  it("writes frames through the writable stream", async () => {
    const mock = new MockSocket({ secureTransport: "starttls" });
    setNextSocket(mock);

    const transport = new CloudflareTransport();
    const server = makeServer();

    setTimeout(() => mock.enqueueData(makeInfoFrame()), 10);
    await transport.connect(server, { servers: "nats.example.com:4222" });

    const frame = new TextEncoder().encode("PUB test 5\r\nhello\r\n");
    transport.send(frame);

    // Wait for async write to flush
    await new Promise((r) => setTimeout(r, 50));

    expect(mock.writtenFrames.length).toBeGreaterThanOrEqual(1);
    const written = new TextDecoder().decode(mock.writtenFrames[0]);
    expect(written).toContain("PUB test");
  });

  it("reads data via async iterator", async () => {
    const mock = new MockSocket({ secureTransport: "starttls" });
    setNextSocket(mock);

    const transport = new CloudflareTransport();
    const server = makeServer();

    const infoFrame = makeInfoFrame();
    setTimeout(() => mock.enqueueData(infoFrame), 10);
    await transport.connect(server, { servers: "nats.example.com:4222" });

    const testData = new TextEncoder().encode("MSG test 1 5\r\nhello\r\n");

    setTimeout(() => {
      mock.enqueueData(testData);
      setTimeout(() => mock.closeReadable(), 10);
    }, 10);

    const frames: Uint8Array[] = [];
    for await (const frame of transport) {
      frames.push(frame);
    }

    // First frame is the buffered INFO, subsequent frames are the MSG
    expect(frames.length).toBeGreaterThanOrEqual(1);
  });

  it("calls socket.close on transport close", async () => {
    const mock = new MockSocket({ secureTransport: "starttls" });
    setNextSocket(mock);

    const transport = new CloudflareTransport();
    const server = makeServer();

    setTimeout(() => mock.enqueueData(makeInfoFrame()), 10);
    await transport.connect(server, { servers: "nats.example.com:4222" });

    await transport.close();

    expect(mock.calls.some((c) => c.method === "close")).toBe(true);
    expect(transport.isClosed).toBe(true);
  });

  it("does not send frames after close", async () => {
    const mock = new MockSocket({ secureTransport: "starttls" });
    setNextSocket(mock);

    const transport = new CloudflareTransport();
    const server = makeServer();

    setTimeout(() => mock.enqueueData(makeInfoFrame()), 10);
    await transport.connect(server, { servers: "nats.example.com:4222" });

    await transport.close();

    const before = mock.writtenFrames.length;
    transport.send(new TextEncoder().encode("PING\r\n"));
    await new Promise((r) => setTimeout(r, 50));

    expect(mock.writtenFrames.length).toBe(before);
  });

  it("resolves closed() promise on disconnect", async () => {
    const mock = new MockSocket({ secureTransport: "starttls" });
    setNextSocket(mock);

    const transport = new CloudflareTransport();
    const server = makeServer();

    setTimeout(() => mock.enqueueData(makeInfoFrame()), 10);
    await transport.connect(server, { servers: "nats.example.com:4222" });

    const closedPromise = transport.closed();
    transport.disconnect();

    const result = await closedPromise;
    expect(result).toBeUndefined();
  });
});
