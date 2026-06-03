import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface HTTPUpstreamParams {
  url: string;
  options?: StreamableHTTPClientTransportOptions;
}

export function createHTTPUpstream({
  url,
  options,
}: HTTPUpstreamParams): StreamableHTTPClientTransport {
  console.error(`Using http transport for upstream server: ${url}`);
  return new StreamableHTTPClientTransport(new URL(url), options);
}
