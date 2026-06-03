// noinspection JSDeprecatedSymbols SSEs are deprecated and that's fine, we still need to wrap them

import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/sse.js";

export interface SSEUpstreamParams {
  url: string;
  options?: SSEClientTransportOptions;
}

export function createSSEUpstream({
  url,
  options,
}: SSEUpstreamParams): SSEClientTransport {
  console.error(`Using sse transport for upstream server: ${url}`);
  return new SSEClientTransport(new URL(url), options);
}
