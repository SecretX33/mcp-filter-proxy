import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  ResultSchema,
  type ClientNotification,
  type ClientRequest,
  type Notification,
  type ServerNotification,
  type ServerResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { filterToolList, isToolAllowed, type ToolFilter } from "./filter.js";
import type { ExposeTransport } from "./config.js";
import { exposeViaStdio } from "./server/stdio.js";
import { exposeViaHttp } from "./server/http.js";
import { PROJECT_INFO } from "./util";

export interface ProxyOptions {
  upstreamTransport: Transport;
  toolFilter: ToolFilter;
  exposeTransport: ExposeTransport;
  exposePort: number;
  exposeHost: string;
}

/**
 * Build a proxy `Server` that forwards everything to the upstream client transparently
 * (except for `tools/list` and `tools/call` that are intercepted to apply the allowlist).
 */
export function createProxyServer(upstream: Client, toolFilter: ToolFilter): Server {
  const server = new Server(
    upstream.getServerVersion() ?? {
      name: PROJECT_INFO.name,
      version: PROJECT_INFO.version,
    },
    {
      capabilities: upstream.getServerCapabilities() ?? {},
      instructions: upstream.getInstructions(),
    },
  );

  const caps = upstream.getServerCapabilities();

  if (caps?.tools) {
    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      const result = await upstream.listTools(request.params);
      return { ...result, tools: filterToolList(result.tools, toolFilter) };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name } = request.params;
      if (!isToolAllowed(name, toolFilter)) {
        throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
      }
      return await upstream.callTool(request.params, undefined, { signal: extra.signal });
    });
  }

  server.fallbackRequestHandler = async (request, extra) => {
    const result = await upstream.request(
      { method: request.method, params: request.params } as ClientRequest,
      ResultSchema,
      { signal: extra.signal, resetTimeoutOnProgress: true },
    );
    return result as ServerResult;
  };

  const logRelayError = (direction: string) => (err: unknown) => {
    console.error(`Failed to relay ${direction} notification:`, err);
  };

  server.fallbackNotificationHandler = (notification: Notification) =>
    upstream
      .notification(notification as ClientNotification)
      .catch(logRelayError("client→upstream"));

  upstream.fallbackNotificationHandler = (notification: Notification) =>
    server
      .notification(notification as ServerNotification)
      .catch(logRelayError("upstream→client"));

  return server;
}

export async function startProxy({
  upstreamTransport,
  toolFilter,
  exposeTransport,
  exposePort,
  exposeHost,
}: ProxyOptions): Promise<void> {
  console.error(`Starting MCP filter proxy with:`, {
    transport: upstreamTransport.constructor.name,
    exposeTransport,
    exposePort,
  });

  // Collect stderr from StdioClientTransport for diagnostics (only available when stderr: 'pipe')
  const stderrChunks: Buffer[] = [];
  const stderrStream =
    (upstreamTransport as { stderr?: NodeJS.ReadableStream | null }).stderr ?? null;
  if (stderrStream) {
    stderrStream.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      process.stderr.write(chunk);
    });
  }

  // Connect to upstream server as a client
  const upstream = new Client({ name: PROJECT_INFO.name, version: PROJECT_INFO.version });
  try {
    await upstream.connect(upstreamTransport);
  } catch (err) {
    const upstreamStderr =
      stderrChunks.length > 0
        ? `\n\n[Upstream Error] ${Buffer.concat(stderrChunks).toString().trim()}`
        : "";
    throw new Error(`Failed to connect to upstream server: ${err}${upstreamStderr}`);
  }
  console.error("Connected to upstream server:", upstream.getServerCapabilities());

  let proxy: Server | undefined;
  if (exposeTransport === "stdio") {
    proxy = createProxyServer(upstream, toolFilter);
    await exposeViaStdio(proxy);
  } else {
    // HTTP: stateless, create a new Server per request, all sharing the same upstream Client
    await exposeViaHttp({
      port: exposePort,
      host: exposeHost,
      createServer: () => createProxyServer(upstream, toolFilter),
    });
  }

  console.error(`mcp-filter-proxy version ${PROJECT_INFO.version} ready`);

  const cleanup = async () => {
    console.error("Shutting down...");
    await upstream.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}
