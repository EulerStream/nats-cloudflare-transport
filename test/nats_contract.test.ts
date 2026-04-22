/**
 * NATS downstream contract tests.
 *
 * Verify that CloudflareTransport satisfies every member of the
 * Transport interface from @nats-io/nats-core.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockCfConnect } from "./mock_socket.js";

vi.mock("cloudflare:sockets", () => ({ connect: mockCfConnect }));

import { CloudflareTransport } from "../src/cloudflare_transport.js";

describe("NATS Transport contract", () => {
  let transport: CloudflareTransport;

  beforeEach(() => {
    transport = new CloudflareTransport();
  });

  it("implements required readonly properties", () => {
    expect(transport).toHaveProperty("version");
    expect(transport).toHaveProperty("lang");
    expect(transport).toHaveProperty("isClosed");
    expect(typeof transport.version).toBe("string");
    expect(typeof transport.lang).toBe("string");
    expect(typeof transport.isClosed).toBe("boolean");
  });

  it("has lang set to nats.cloudflare", () => {
    expect(transport.lang).toBe("nats.cloudflare");
  });

  it("version matches the package version", async () => {
    const { version } = await import("../src/version.js");
    expect(transport.version).toBe(version);
  });

  it("starts in a non-closed state", () => {
    expect(transport.isClosed).toBe(false);
  });

  it("starts unencrypted", () => {
    expect(transport.isEncrypted()).toBe(false);
  });

  it("implements connect method", () => {
    expect(typeof transport.connect).toBe("function");
  });

  it("implements send method", () => {
    expect(typeof transport.send).toBe("function");
  });

  it("implements close method", () => {
    expect(typeof transport.close).toBe("function");
  });

  it("implements disconnect method", () => {
    expect(typeof transport.disconnect).toBe("function");
  });

  it("implements closed method returning a promise", () => {
    const result = transport.closed();
    expect(result).toBeInstanceOf(Promise);
  });

  it("implements discard method without throwing", () => {
    expect(typeof transport.discard).toBe("function");
    transport.discard();
  });

  it("implements isEncrypted method", () => {
    expect(typeof transport.isEncrypted).toBe("function");
  });

  it("implements Symbol.asyncIterator", () => {
    expect(typeof transport[Symbol.asyncIterator]).toBe("function");
  });

  it("closeError is undefined initially", () => {
    expect(transport.closeError).toBeUndefined();
  });
});
