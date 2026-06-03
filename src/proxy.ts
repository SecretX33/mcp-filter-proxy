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
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { filterToolList, isToolAllowed, type ToolFilter } from "./filter.js";
import type { ExposeTransport } from "./config.js";
import type { OAuthRuntime } from "./auth/index.js";
import { exposeViaStdio } from "./server/stdio.js";
import { exposeViaHttp } from "./server/http.js";
import { PROJECT_INFO } from "./util";

export interface ProxyOptions {
  /** Builds an upstream transport. Called again to reconnect after interactive OAuth. */
  makeUpstreamTransport: () => Transport;
  toolFilter: ToolFilter;
  exposeTransport: ExposeTransport;
  exposePort: number;
  exposeHost: string;
  /** Present when an interactive OAuth flow may be required for the upstream connection. */
  oauth?: OAuthRuntime;
}

/** Transports that support completing an interactive OAuth flow (http/sse). */
type AuthCapableTransport = Transport & {
  finishAuth(authorizationCode: string): Promise<void>;
};

function canFinishAuth(transport: Transport): transport is AuthCapableTransport {
  return typeof (transport as { finishAuth?: unknown }).finishAuth === "function";
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

/**
 * Connects an MCP {@link Client} to the upstream, transparently driving an interactive OAuth flow
 * when the upstream demands it. On the first 401 with an OAuth provider attached, the transport
 * opens the browser and throws {@link UnauthorizedError}; we wait for the redirect to deliver the
 * authorization code, finish auth, and reconnect with a fresh transport carrying the new tokens.
 */
export async function connectUpstream(
  upstream: Client,
  makeUpstreamTransport: () => Transport,
  oauth?: OAuthRuntime,
): Promise<Transport> {
  // Collect stderr from StdioClientTransport for diagnostics (only available when stderr: 'pipe')
  const stderrChunks: Buffer[] = [];
  const attachStderr = (transport: Transport): void => {
    const stderrStream =
      (transport as { stderr?: NodeJS.ReadableStream | null }).stderr ?? null;
    stderrStream?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      process.stderr.write(chunk);
    });
  };
  const wrapConnectError = (err: unknown): Error => {
    const upstreamStderr =
      stderrChunks.length > 0
        ? `\n\n[Upstream Error] ${Buffer.concat(stderrChunks).toString().trim()}`
        : "";
    return new Error(`Failed to connect to upstream server: ${err}${upstreamStderr}`);
  };

  let upstreamTransport = makeUpstreamTransport();
  attachStderr(upstreamTransport);

  try {
    await upstream.connect(upstreamTransport);
  } catch (err) {
    if (oauth && err instanceof UnauthorizedError && canFinishAuth(upstreamTransport)) {
      console.error(
        "Authorization required; complete the sign-in in your browser to continue...",
      );
      const code = await oauth.waitForCode();
      await upstreamTransport.finishAuth(code);
      upstreamTransport = makeUpstreamTransport();
      attachStderr(upstreamTransport);
      try {
        await upstream.connect(upstreamTransport);
      } catch (retryErr) {
        throw wrapConnectError(retryErr);
      }
    } else {
      throw wrapConnectError(err);
    }
  } finally {
    oauth?.close();
  }
  return upstreamTransport;
}

export async function startProxy({
  makeUpstreamTransport,
  toolFilter,
  exposeTransport,
  exposePort,
  exposeHost,
  oauth,
}: ProxyOptions): Promise<void> {
  console.error(`Starting MCP filter proxy with:`, { exposeTransport, exposePort });

  const upstream = new Client({ name: PROJECT_INFO.name, version: PROJECT_INFO.version });
  await connectUpstream(upstream, makeUpstreamTransport, oauth);
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
