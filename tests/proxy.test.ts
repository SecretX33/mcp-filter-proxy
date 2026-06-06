import { afterEach, describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  createProxyServer,
  connectUpstream,
  UPSTREAM_CLIENT_CAPABILITIES,
} from "../src/proxy.js";
import { createFilterRule, type FilterRule, type ProxyFilters } from "../src/filter.js";

const TOOL_NAMES = ["read_file", "write_file", "delete_file"];
const RESOURCES = [
  { name: "alpha", uri: "test://alpha" },
  { name: "beta", uri: "test://beta" },
  { name: "gamma", uri: "test://gamma" },
];
const PROMPT_NAMES = ["greet", "farewell"];
const TEMPLATE_NAME = "file-template";

function buildUpstreamServer(): McpServer {
  const server = new McpServer({ name: "upstream", version: "1.0.0" });

  for (const name of TOOL_NAMES) {
    server.registerTool(name, { description: `Tool ${name}` }, async () => ({
      content: [{ type: "text", text: `called ${name}` }],
    }));
  }

  for (const { name, uri } of RESOURCES) {
    server.registerResource(
      name,
      uri,
      { description: `Resource ${name}` },
      async (u) => ({
        contents: [{ uri: u.href, text: `contents of ${name}` }],
      }),
    );
  }

  server.registerResource(
    TEMPLATE_NAME,
    new ResourceTemplate("file:///{path}", { list: undefined }),
    { description: "A templated resource" },
    async (u) => ({ contents: [{ uri: u.href, text: "templated" }] }),
  );

  for (const name of PROMPT_NAMES) {
    server.registerPrompt(name, { description: `Prompt ${name}` }, async () => ({
      messages: [{ role: "user", content: { type: "text", text: `prompt ${name}` } }],
    }));
  }

  return server;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

/**
 * Wire a real upstream MCP server -> upstream Client -> proxy Server -> downstream Client, all over
 * in-memory transports, and return the downstream client to drive assertions through. Missing
 * filter kinds default to allow-all. `strict` makes the downstream client enforce capabilities,
 * so resources/prompts only work if the proxy actually advertises those capabilities.
 */
async function setupProxy(
  filters: Partial<ProxyFilters> = {},
  strict = false,
): Promise<Client> {
  const [upstreamServerSide, upstreamClientSide] = InMemoryTransport.createLinkedPair();
  const upstreamServer = buildUpstreamServer();
  const upstreamClient = new Client({ name: "proxy-upstream-client", version: "1.0.0" });
  await Promise.all([
    upstreamServer.connect(upstreamServerSide),
    upstreamClient.connect(upstreamClientSide),
  ]);

  const full: ProxyFilters = {
    tools: filters.tools ?? createFilterRule(null, null),
    resources: filters.resources ?? createFilterRule(null, null),
    prompts: filters.prompts ?? createFilterRule(null, null),
  };
  const proxyServer = createProxyServer(upstreamClient, full);

  const [proxyServerSide, downstreamSide] = InMemoryTransport.createLinkedPair();
  const downstreamClient = new Client(
    { name: "downstream", version: "1.0.0" },
    strict ? { enforceStrictCapabilities: true } : undefined,
  );
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

const allow = (...names: string[]): FilterRule => createFilterRule(names, null);

describe("createProxyServer — tools", () => {
  it("lists only the allowed tools with a selective filter", async () => {
    const client = await setupProxy({ tools: allow("read_file") });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["read_file"]);
  });

  it("lists all upstream tools with an allow-all filter", async () => {
    const client = await setupProxy();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("forwards a call to an allowed tool and returns the upstream result", async () => {
    const client = await setupProxy({ tools: allow("read_file") });
    const result = await client.callTool({ name: "read_file" });
    expect(result.content).toEqual([{ type: "text", text: "called read_file" }]);
  });

  it("rejects a call to a disallowed tool", async () => {
    const client = await setupProxy({ tools: allow("read_file") });
    await expect(client.callTool({ name: "delete_file" })).rejects.toThrow(
      /Tool not found/,
    );
  });
});

describe("createProxyServer — resources", () => {
  it("lists all resources with an allow-all filter", async () => {
    const client = await setupProxy();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.name).sort()).toEqual(
      RESOURCES.map((r) => r.name).sort(),
    );
  });

  it("lists only allowed resources (by name) with a selective filter", async () => {
    const client = await setupProxy({ resources: allow("alpha") });
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.name)).toEqual(["alpha"]);
  });

  it("reads an allowed resource and returns upstream contents", async () => {
    const client = await setupProxy({ resources: allow("alpha") });
    const result = await client.readResource({ uri: "test://alpha" });
    expect(result.contents[0]).toMatchObject({ text: "contents of alpha" });
  });

  it("reads an allowed resource without a prior list (resolver loads on demand)", async () => {
    const client = await setupProxy({ resources: allow("gamma") });
    // No listResources() call first — read enforcement must resolve uri->name itself.
    const result = await client.readResource({ uri: "test://gamma" });
    expect(result.contents[0]).toMatchObject({ text: "contents of gamma" });
  });

  it("rejects reading a resource whose name is not allowed", async () => {
    const client = await setupProxy({ resources: allow("alpha") });
    await expect(client.readResource({ uri: "test://beta" })).rejects.toThrow(
      /Resource not found/,
    );
  });

  it("rejects reading an unknown uri under a selective filter", async () => {
    const client = await setupProxy({ resources: allow("alpha") });
    await expect(client.readResource({ uri: "test://nope" })).rejects.toThrow(
      /Resource not found/,
    );
  });

  it("filters resource templates by name", async () => {
    const allowed = await setupProxy({ resources: allow(TEMPLATE_NAME) });
    expect(
      (await allowed.listResourceTemplates()).resourceTemplates.map((t) => t.name),
    ).toEqual([TEMPLATE_NAME]);

    const blocked = await setupProxy({ resources: allow("alpha") });
    expect((await blocked.listResourceTemplates()).resourceTemplates).toHaveLength(0);
  });
});

describe("createProxyServer — prompts", () => {
  it("lists all prompts with an allow-all filter", async () => {
    const client = await setupProxy();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual([...PROMPT_NAMES].sort());
  });

  it("lists only allowed prompts with a selective filter", async () => {
    const client = await setupProxy({ prompts: allow("greet") });
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(["greet"]);
  });

  it("forwards a get for an allowed prompt", async () => {
    const client = await setupProxy({ prompts: allow("greet") });
    const result = await client.getPrompt({ name: "greet" });
    expect(result.messages[0].content).toEqual({ type: "text", text: "prompt greet" });
  });

  it("rejects a get for a disallowed prompt", async () => {
    const client = await setupProxy({ prompts: allow("greet") });
    await expect(client.getPrompt({ name: "farewell" })).rejects.toThrow(
      /Prompt not found/,
    );
  });
});

/** A transport that starts fine but rejects the initialize request the way a Streamable HTTP server
 * does when it only speaks the legacy SSE transport (HTTP 405), mirroring the real failure point. */
function mismatchTransport(): Transport {
  const t: { onclose?: () => void } & Record<string, unknown> = {
    async start() {},
    async send() {
      throw new StreamableHTTPError(405, "Method Not Allowed");
    },
    async close() {
      t.onclose?.();
    },
  };
  return t as unknown as Transport;
}

describe("connectUpstream — transport autodetection fallback", () => {
  it("falls back from http to sse on a transport mismatch and connects", async () => {
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const upstreamServer = buildUpstreamServer();
    await upstreamServer.connect(serverSide);
    cleanups.push(async () => {
      await upstreamServer.close();
    });

    const client = new Client({ name: "c", version: "1.0.0" });
    let httpAttempts = 0;
    let sseAttempts = 0;
    const make = (kind: "stdio" | "sse" | "http"): Transport => {
      if (kind === "http") {
        httpAttempts++;
        return mismatchTransport();
      }
      sseAttempts++;
      return clientSide;
    };

    await connectUpstream(client, make, { transport: "http", autoNegotiateRemote: true });

    expect(httpAttempts).toBe(1);
    expect(sseAttempts).toBe(1);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
  });

  it("does not fall back when the transport was set explicitly", async () => {
    const client = new Client({ name: "c", version: "1.0.0" });
    await expect(
      connectUpstream(client, () => mismatchTransport(), {
        transport: "http",
        autoNegotiateRemote: false,
      }),
    ).rejects.toThrow(/Failed to connect to upstream/);
  });
});

const allowAllFilters = (): ProxyFilters => ({
  tools: createFilterRule(null, null),
  resources: createFilterRule(null, null),
  prompts: createFilterRule(null, null),
});

describe("createProxyServer — client capabilities & server→client relay", () => {
  it("declares the MCP-UI extension and core client capabilities to the upstream", async () => {
    const upstreamServer = new McpServer({ name: "up", version: "1.0.0" });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const upstreamClient = new Client(
      { name: "proxy-up", version: "1.0.0" },
      { capabilities: UPSTREAM_CLIENT_CAPABILITIES },
    );
    await Promise.all([
      upstreamServer.connect(serverSide),
      upstreamClient.connect(clientSide),
    ]);
    cleanups.push(async () => {
      await upstreamClient.close();
      await upstreamServer.close();
    });

    const caps = upstreamServer.server.getClientCapabilities();
    expect(caps?.extensions?.["io.modelcontextprotocol/ui"]).toBeDefined();
    expect(caps?.roots).toBeDefined();
    expect(caps?.sampling).toBeDefined();
    expect(caps?.elicitation).toBeDefined();
  });

  it("relays a server-initiated roots/list request through to the downstream client", async () => {
    // Upstream server with a tool that asks ITS client (the proxy) for the roots list.
    const upstreamServer = new McpServer({ name: "up", version: "1.0.0" });
    upstreamServer.registerTool("list_roots", { description: "echo roots" }, async () => {
      const { roots } = await upstreamServer.server.listRoots();
      return { content: [{ type: "text", text: roots.map((r) => r.uri).join(",") }] };
    });

    const [upServerSide, upClientSide] = InMemoryTransport.createLinkedPair();
    const upstreamClient = new Client(
      { name: "proxy-up", version: "1.0.0" },
      { capabilities: UPSTREAM_CLIENT_CAPABILITIES },
    );
    await Promise.all([
      upstreamServer.connect(upServerSide),
      upstreamClient.connect(upClientSide),
    ]);

    const proxyServer = createProxyServer(upstreamClient, allowAllFilters());

    const [proxySide, downSide] = InMemoryTransport.createLinkedPair();
    const downstreamClient = new Client(
      { name: "down", version: "1.0.0" },
      { capabilities: { roots: {} } },
    );
    downstreamClient.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: "file:///workspace", name: "workspace" }],
    }));
    await Promise.all([
      proxyServer.connect(proxySide),
      downstreamClient.connect(downSide),
    ]);
    cleanups.push(async () => {
      await downstreamClient.close();
      await proxyServer.close();
      await upstreamClient.close();
      await upstreamServer.close();
    });

    const result = await downstreamClient.callTool({ name: "list_roots" });
    expect((result.content as Array<{ text: string }>)[0].text).toBe("file:///workspace");
  });

  it("subjects MCP-UI widget resources to the resource allowlist", async () => {
    const upstreamServer = new McpServer({ name: "up", version: "1.0.0" });
    upstreamServer.registerResource(
      "jira-widget-openai",
      "ui://widget/jira",
      { mimeType: "text/html;profile=mcp-app" },
      async (u) => ({ contents: [{ uri: u.href, text: "<html>jira</html>" }] }),
    );
    upstreamServer.registerResource(
      "confluence-widget-openai",
      "ui://widget/confluence",
      { mimeType: "text/html;profile=mcp-app" },
      async (u) => ({ contents: [{ uri: u.href, text: "<html>conf</html>" }] }),
    );

    const [upServerSide, upClientSide] = InMemoryTransport.createLinkedPair();
    const upstreamClient = new Client({ name: "proxy-up", version: "1.0.0" });
    await Promise.all([
      upstreamServer.connect(upServerSide),
      upstreamClient.connect(upClientSide),
    ]);

    const proxyServer = createProxyServer(upstreamClient, {
      tools: createFilterRule(null, null),
      resources: createFilterRule(["jira-widget-openai"], null),
      prompts: createFilterRule(null, null),
    });

    const [proxySide, downSide] = InMemoryTransport.createLinkedPair();
    const downstreamClient = new Client({ name: "down", version: "1.0.0" });
    await Promise.all([
      proxyServer.connect(proxySide),
      downstreamClient.connect(downSide),
    ]);
    cleanups.push(async () => {
      await downstreamClient.close();
      await proxyServer.close();
      await upstreamClient.close();
      await upstreamServer.close();
    });

    const { resources } = await downstreamClient.listResources();
    expect(resources.map((r) => r.name)).toEqual(["jira-widget-openai"]);
    await expect(
      downstreamClient.readResource({ uri: "ui://widget/confluence" }),
    ).rejects.toThrow(/Resource not found/);
  });
});

describe("createProxyServer — capability forwarding (regression guard)", () => {
  it("advertises resources and prompts capabilities to the downstream client", async () => {
    const client = await setupProxy();
    const caps = client.getServerCapabilities();
    expect(caps?.resources).toBeDefined();
    expect(caps?.prompts).toBeDefined();
    expect(caps?.tools).toBeDefined();
  });

  it("lets a capability-strict client list resources and prompts through the proxy", async () => {
    // With enforceStrictCapabilities, these calls throw unless the proxy advertised the
    // capability AND has a handler — this is the guard against the forwarding regression.
    const client = await setupProxy({}, true);
    expect((await client.listResources()).resources).not.toHaveLength(0);
    expect((await client.listPrompts()).prompts).not.toHaveLength(0);
  });
});
