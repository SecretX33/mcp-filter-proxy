import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export function createHTTPUpstream(url: string): StreamableHTTPClientTransport {
  console.error(`Using http transport for upstream server: ${url}`);
  return new StreamableHTTPClientTransport(new URL(url));
}
