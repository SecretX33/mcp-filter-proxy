// noinspection JSDeprecatedSymbols SSEs are deprecated and that's fine, we still need to wrap them

import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

export function createSSEUpstream(url: string): SSEClientTransport {
  console.error(`Using sse transport for upstream server: ${url}`);
  return new SSEClientTransport(new URL(url));
}
