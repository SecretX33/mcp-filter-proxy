import { afterEach, describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createProxyServer } from "../src/proxy.js";
import { createToolFilter, type ToolFilter } from "../src/filter.js";

const TOOL_NAMES = ["read_file", "write_file", "delete_file"];

function buildUpstreamServer(): McpServer {
  const server = new McpServer({ name: "upstream", version: "1.0.0" });
  for (const name of TOOL_NAMES) {
    server.registerTool(name, { description: `Tool ${name}` }, async () => ({
      content: [{ type: "text", text: `called ${name}` }],
    }));
  }
  server.registerResource(
    "greeting",
    "test://greeting",
    { description: "A greeting" },
    async (uri) => ({ contents: [{ uri: uri.href, text: "hello" }] }),
  );
  return server;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

/**
 * Wire a real upstream MCP server -> upstream Client -> proxy Server ->
 * downstream Client, all over in-memory transports, and return the downstream
 * client to drive assertions through.
 */
async function setupProxy(filter: ToolFilter): Promise<Client> {
  // Upstream server <-> the Client that the proxy forwards to.
  const [upstreamServerSide, upstreamClientSide] = InMemoryTransport.createLinkedPair();
  const upstreamServer = buildUpstreamServer();
  const upstreamClient = new Client({
    name: "proxy-upstream-client",
    version: "1.0.0",
  });
  await Promise.all([
    upstreamServer.connect(upstreamServerSide),
    upstreamClient.connect(upstreamClientSide),
  ]);

  // The upstream Client must be connected first: createProxyServer reads its
  // capabilities to decide whether to register the tool handlers.
  const proxyServer = createProxyServer(upstreamClient, filter);

  // Proxy server <-> downstream client.
  const [proxyServerSide, downstreamSide] = InMemoryTransport.createLinkedPair();
  const downstreamClient = new Client({ name: "downstream", version: "1.0.0" });
  await Promise.all([
    proxyServer.connect(proxyServerSide),
    downstreamClient.connect(downstreamSide),
  ]);

  cleanups.push(async () => {
    await downstreamClient.close();
    await proxyServer.close();
    await upstreamClient.close();
    await upstreamServer.close();
  });

  return downstreamClient;
}

describe("createProxyServer", () => {
  it("lists only the allowed tools with a selective filter", async () => {
    const client = await setupProxy(createToolFilter(new Set(["read_file"])));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["read_file"]);
  });

  it("lists all upstream tools with an allow-all filter", async () => {
    const client = await setupProxy(createToolFilter(null));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("forwards a call to an allowed tool and returns the upstream result", async () => {
    const client = await setupProxy(createToolFilter(new Set(["read_file"])));
    const result = await client.callTool({ name: "read_file" });
    expect(result.content).toEqual([{ type: "text", text: "called read_file" }]);
  });

  it("rejects a call to a disallowed tool", async () => {
    const client = await setupProxy(createToolFilter(new Set(["read_file"])));
    await expect(client.callTool({ name: "delete_file" })).rejects.toThrow(
      /Tool not found/,
    );
  });

  it("passes non-tool requests through to the upstream server", async () => {
    const client = await setupProxy(createToolFilter(new Set(["read_file"])));
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain("test://greeting");
  });
});
