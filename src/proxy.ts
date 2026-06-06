import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolRequestSchema,
  type ClientNotification,
  type ClientRequest,
  type ClientResult,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  type Notification,
  ReadResourceRequestSchema,
  ResultSchema,
  type ServerNotification,
  type ServerRequest,
  type ServerResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { filterByKey, isAllowed, type ProxyFilters } from "./filter.js";
import type { ExposeTransport, UpstreamTransport } from "./config.js";
import type { OAuthRuntime } from "./auth/index.js";
import { ResourceNameResolver } from "./resource-resolver.js";
import { exposeViaStdio } from "./server/stdio.js";
import { exposeViaHttp } from "./server/http.js";
import { PROJECT_INFO } from "./util";

const RESOURCE_LIST_CHANGED = "notifications/resources/list_changed";

/**
 * Client capabilities the proxy advertises to the upstream on behalf of the downstream client. We
 * declare a fixed superset rather than mirror each downstream client, because the upstream connects
 * once at startup (and is shared across downstream clients for HTTP) so its `initialize` cannot be
 * re-issued per client. Declaring these makes capability-gated upstream features available: the
 * MCP-UI extension unlocks app/widget resources (e.g. Atlassian's Jira/Confluence widgets), and
 * roots/sampling/elicitation let the upstream issue server→client requests, which the proxy relays
 * to the real downstream client (see `createProxyServer`). If the live downstream client does not
 * support a relayed capability, the relayed request simply errors back to the upstream.
 */
export const UPSTREAM_CLIENT_CAPABILITIES = {
  roots: { listChanged: true },
  sampling: {},
  elicitation: {},
  extensions: {
    "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
  },
};

export interface ProxyOptions {
  /** Builds an upstream transport for a given kind. Called again to reconnect after interactive
   * OAuth completes or when probing http→sse. */
  makeUpstreamTransport: (kind: UpstreamTransport) => Transport;
  /** Transport to attempt first. */
  transport: UpstreamTransport;
  /** When true, a failed Streamable HTTP attempt for a remote upstream falls back to SSE. */
  autoNegotiateRemote: boolean;
  filters: ProxyFilters;
  exposeTransport: ExposeTransport;
  exposePort: number;
  exposeHost: string;
  /** Present when an interactive OAuth flow may be required for the upstream connection. */
  oauth?: OAuthRuntime;
}

type AuthCapableTransport = Transport & {
  finishAuth(authorizationCode: string): Promise<void>;
};

function canFinishAuth(transport: Transport): transport is AuthCapableTransport {
  return typeof (transport as { finishAuth?: unknown }).finishAuth === "function";
}

/**
 * Build a proxy `Server` that forwards everything to the upstream client transparently,
 * applying the allowlist to tools, resources, and prompts.
 */
export function createProxyServer(
  upstream: Client,
  filters: ProxyFilters,
  resolver: ResourceNameResolver = new ResourceNameResolver(upstream),
): Server {
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
      return {
        ...result,
        tools: filterByKey(result.tools, (t) => t.name, filters.tools),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name } = request.params;
      if (!isAllowed(name, filters.tools)) {
        throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
      }
      return await upstream.callTool(request.params, undefined, { signal: extra.signal });
    });
  }

  if (caps?.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      const result = await upstream.listResources(request.params);
      resolver.record(result.resources);
      return {
        ...result,
        resources: filterByKey(result.resources, (r) => r.name, filters.resources),
      };
    });

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
      const result = await upstream.listResourceTemplates(request.params);
      return {
        ...result,
        resourceTemplates: filterByKey(
          result.resourceTemplates,
          (t) => t.name,
          filters.resources,
        ),
      };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      const { uri } = request.params;
      if (filters.resources.mode !== "allow-all") {
        const name = await resolver.nameForUri(uri);
        if (name == undefined || !isAllowed(name, filters.resources)) {
          throw new McpError(ErrorCode.MethodNotFound, `Resource not found: ${uri}`);
        }
      }
      return await upstream.readResource(request.params, { signal: extra.signal });
    });
  }

  if (caps?.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
      const result = await upstream.listPrompts(request.params);
      return {
        ...result,
        prompts: filterByKey(result.prompts, (p) => p.name, filters.prompts),
      };
    });

    server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
      const { name } = request.params;
      if (!isAllowed(name, filters.prompts)) {
        throw new McpError(ErrorCode.MethodNotFound, `Prompt not found: ${name}`);
      }
      return await upstream.getPrompt(request.params, { signal: extra.signal });
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

  // The mirror of the above: relay server-initiated requests from the upstream (sampling,
  // elicitation, roots/list, ...) to the real downstream client, so the capabilities we advertise in
  // UPSTREAM_CLIENT_CAPABILITIES are actually serviceable.
  upstream.fallbackRequestHandler = async (request, extra) => {
    const result = await server.request(
      { method: request.method, params: request.params } as ServerRequest,
      ResultSchema,
      { signal: extra.signal, resetTimeoutOnProgress: true },
    );
    return result as ClientResult;
  };

  const logRelayError = (direction: string) => (err: unknown) => {
    console.error(`Failed to relay ${direction} notification:`, err);
  };

  server.fallbackNotificationHandler = (notification: Notification) =>
    upstream
      .notification(notification as ClientNotification)
      .catch(logRelayError("client→upstream"));

  upstream.fallbackNotificationHandler = (notification: Notification) => {
    // The upstream resource set changed: drop the cached uri->name map so read enforcement re-syncs.
    if (notification.method === RESOURCE_LIST_CHANGED) resolver.invalidate();
    return server
      .notification(notification as ServerNotification)
      .catch(logRelayError("upstream→client"));
  };

  return server;
}

/** A connection failure that means "wrong transport": the server speaks the other HTTP variant.
 * Streamable HTTP servers reject the legacy SSE handshake (and vice versa) with 404/405. */
function isTransportMismatch(err: unknown): boolean {
  if (err instanceof StreamableHTTPError && (err.code === 404 || err.code === 405)) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /\b40[45]\b/.test(message) || /method not allowed|not found/i.test(message);
}

/**
 * Connects an MCP {@link Client} to the upstream, transparently handling two recoverable failures,
 * in either order and at most once each:
 *
 * - **Interactive OAuth.** On a 401 with an OAuth provider attached, the transport opens the browser
 *   and throws {@link UnauthorizedError}; we wait for the redirect to deliver the authorization
 *   code, finish auth, and reconnect with a fresh transport carrying the new tokens.
 * - **Transport fallback.** When the transport was autodetected (`autoNegotiateRemote`) and the
 *   Streamable HTTP attempt fails with a transport mismatch, we reconnect over SSE.
 */
export async function connectUpstream(
  upstream: Client,
  makeUpstreamTransport: (kind: UpstreamTransport) => Transport,
  {
    transport,
    autoNegotiateRemote,
    oauth,
  }: {
    transport: UpstreamTransport;
    autoNegotiateRemote: boolean;
    oauth?: OAuthRuntime;
  },
): Promise<Transport> {
  // Collect stderr from StdioClientTransport for diagnostics (only available when stderr: 'pipe')
  const stderrChunks: Buffer[] = [];
  const attachStderr = (t: Transport): void => {
    const stderrStream = (t as { stderr?: NodeJS.ReadableStream | null }).stderr ?? null;
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

  let kind = transport;
  let attemptedAuth = false;
  let attemptedFallback = false;

  try {
    while (true) {
      const upstreamTransport = makeUpstreamTransport(kind);
      attachStderr(upstreamTransport);
      try {
        await upstream.connect(upstreamTransport);
        return upstreamTransport;
      } catch (err) {
        const willRetryAuth =
          !!oauth &&
          err instanceof UnauthorizedError &&
          canFinishAuth(upstreamTransport) &&
          !attemptedAuth;
        const willFallback =
          autoNegotiateRemote &&
          kind === "http" &&
          !attemptedFallback &&
          isTransportMismatch(err);

        if (!willRetryAuth && !willFallback) throw wrapConnectError(err);

        await upstream.close().catch(() => {});

        if (willRetryAuth) {
          attemptedAuth = true;
          console.error(
            "Authorization required; complete the sign-in in your browser to continue...",
          );
          const code = await oauth!.waitForCode();
          await upstreamTransport.finishAuth(code);
          continue;
        }

        attemptedFallback = true;
        console.error(
          "Upstream did not accept Streamable HTTP; falling back to the SSE transport...",
        );
        kind = "sse";
      }
    }
  } finally {
    oauth?.close();
  }
}

export async function startProxy({
  makeUpstreamTransport,
  transport,
  autoNegotiateRemote,
  filters,
  exposeTransport,
  exposePort,
  exposeHost,
  oauth,
}: ProxyOptions): Promise<void> {
  console.error(`Starting MCP filter proxy with:`, { exposeTransport, exposePort });

  const upstream = new Client(
    { name: PROJECT_INFO.name, version: PROJECT_INFO.version },
    { capabilities: UPSTREAM_CLIENT_CAPABILITIES },
  );
  await connectUpstream(upstream, makeUpstreamTransport, {
    transport,
    autoNegotiateRemote,
    oauth,
  });
  console.error("Connected to upstream server:", upstream.getServerCapabilities());

  const resolver = new ResourceNameResolver(upstream);

  let proxy: Server | undefined;
  if (exposeTransport === "stdio") {
    proxy = createProxyServer(upstream, filters, resolver);
    await exposeViaStdio(proxy);
  } else {
    // HTTP: stateless, create a new Server per request, all sharing the same upstream Client
    await exposeViaHttp({
      port: exposePort,
      host: exposeHost,
      createServer: () => createProxyServer(upstream, filters, resolver),
    });
  }

  console.error(`mcp-filter-proxy version ${PROJECT_INFO.version} ready`);

  const cleanup = async () => {
    console.error("Shutting down...");
    await Promise.allSettled(
      [upstream.close(), proxy?.close()].filter((it) => it != null),
    );
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}
