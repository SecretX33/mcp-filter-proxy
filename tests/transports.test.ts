import { describe, it, expect } from "vitest";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createSSEUpstream } from "../src/transports/upstream-sse.js";
import { createHTTPUpstream } from "../src/transports/upstream-http.js";
import { createStdioUpstream } from "../src/transports/upstream-stdio.js";

describe("createSSEUpstream", () => {
  it("creates an SSE transport from a valid url", () => {
    expect(createSSEUpstream({ url: "http://localhost:3000/sse" })).toBeInstanceOf(
      SSEClientTransport,
    );
  });

  it("throws on a malformed url", () => {
    expect(() => createSSEUpstream({ url: "not a url" })).toThrow();
  });
});

describe("createHTTPUpstream", () => {
  it("creates a streamable HTTP transport from a valid url", () => {
    expect(createHTTPUpstream({ url: "http://localhost:3000/mcp" })).toBeInstanceOf(
      StreamableHTTPClientTransport,
    );
  });

  it("throws on a malformed url", () => {
    expect(() => createHTTPUpstream({ url: "not a url" })).toThrow();
  });
});

describe("createStdioUpstream", () => {
  it("creates a stdio transport for a valid command", () => {
    expect(createStdioUpstream({ command: "node", args: ["--version"] })).toBeInstanceOf(
      StdioClientTransport,
    );
  });
});
