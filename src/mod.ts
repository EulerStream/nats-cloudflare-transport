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

import {
  NatsConnectionImpl,
  setTransportFactory,
} from "@nats-io/nats-core/internal";

import type {
  ConnectionOptions,
  NatsConnection,
} from "@nats-io/nats-core/internal";

import { CloudflareTransport } from "./cloudflare_transport.js";

export { CloudflareTransport } from "./cloudflare_transport.js";
export { version } from "./version.js";

export type {
  ConnectionOptions,
  NatsConnection,
} from "@nats-io/nats-core/internal";

// Re-export commonly used utilities so users don't need a separate import
export {
  deferred,
  nuid,
  Empty,
  headers,
  errors,
} from "@nats-io/nats-core/internal";

/**
 * Connect to a NATS server from a Cloudflare Worker using TCP sockets.
 *
 * @param opts - Connection options (servers, auth, tls, etc.)
 * @returns A promise that resolves to a NatsConnection
 *
 * @example
 * ```typescript
 * import { connect } from "nats-cloudflare";
 *
 * export default {
 *   async fetch(request: Request): Promise<Response> {
 *     const nc = await connect({ servers: "nats.example.com:4222" });
 *     nc.publish("hello", "world");
 *     await nc.drain();
 *     return new Response("OK");
 *   },
 * };
 * ```
 */
export async function connect(
  opts: ConnectionOptions = {},
): Promise<NatsConnection> {
  setTransportFactory({
    defaultPort: 4222,
    factory: () => new CloudflareTransport(),
  });
  return NatsConnectionImpl.connect(opts);
}
