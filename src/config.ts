import { z } from "zod";

const ENV_PREFIX = "MCP_FILTER_PROXY_";

export type UpstreamTransport = "stdio" | "sse" | "http";
export type ExposeTransport = "stdio" | "http";

export interface ProxyConfig {
  /** How to connect to the upstream (wrapped) server. */
  transport: UpstreamTransport;
  /** How to expose the proxy to downstream clients. */
  exposeTransport: ExposeTransport;
  /** Allowed tool names. null = allow everything. */
  allowedTools: Set<string> | null;
  /** Command to spawn the wrapped server (required for stdio, optional for sse/http). */
  command: string | null;
  /** Arguments for the spawned command. */
  args: string[];
  /** URL for sse/http upstream transports. */
  url: string | null;
  /** Port for HTTP expose transport. */
  exposePort: number;
  /** Host/bind address for HTTP expose transport. */
  exposeHost: string;
}

const AllowedTools = z
  .string()
  .transform((v) => {
    const names = v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return names.length > 0 ? new Set(names) : null;
  })
  .optional()
  .transform((v) => v ?? null);

export const EnvSchema = z.object({
  MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: z.enum(["stdio", "sse", "http"]),
  MCP_FILTER_PROXY_EXPOSE_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
  MCP_FILTER_PROXY_EXPOSE_PORT: z.coerce.number().int().min(1).max(65535).default(8808),
  MCP_FILTER_PROXY_EXPOSE_HOST: z.string().default("127.0.0.1"),
  MCP_FILTER_PROXY_ALLOWED_TOOLS: AllowedTools,
  MCP_FILTER_PROXY_SERVER_URL: z
    .string()
    .optional()
    .transform((v) => v ?? null),
});

export interface ParseConfigInput {
  env: Record<string, string | undefined>;
  argv: string[];
}

function emptyToUndefined(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, value === "" ? undefined : value]),
  );
}

export function parseConfig({ env, argv }: ParseConfigInput): ProxyConfig {
  const parsedEnv = EnvSchema.parse(emptyToUndefined(env));

  const positional = argv.slice(2);
  const command = positional.length > 0 ? positional[0] : null;
  const args = positional.slice(1);

  if (parsedEnv.MCP_FILTER_PROXY_UPSTREAM_TRANSPORT === "stdio" && !command) {
    throw new Error(
      "stdio transport requires a command to spawn the wrapped server " +
        "(pass it as positional CLI arguments after mcp-filter-proxy)",
    );
  }
  if (
    parsedEnv.MCP_FILTER_PROXY_UPSTREAM_TRANSPORT !== "stdio" &&
    !parsedEnv.MCP_FILTER_PROXY_SERVER_URL
  ) {
    throw new Error(
      `${ENV_PREFIX}SERVER_URL is required for ${parsedEnv.MCP_FILTER_PROXY_UPSTREAM_TRANSPORT} transport`,
    );
  }

  return {
    transport: parsedEnv.MCP_FILTER_PROXY_UPSTREAM_TRANSPORT,
    exposeTransport: parsedEnv.MCP_FILTER_PROXY_EXPOSE_TRANSPORT,
    allowedTools: parsedEnv.MCP_FILTER_PROXY_ALLOWED_TOOLS,
    command,
    args,
    url: parsedEnv.MCP_FILTER_PROXY_SERVER_URL,
    exposePort: parsedEnv.MCP_FILTER_PROXY_EXPOSE_PORT,
    exposeHost: parsedEnv.MCP_FILTER_PROXY_EXPOSE_HOST,
  };
}

export function loadConfigOrExit(argv: string[]): ProxyConfig {
  try {
    return parseConfig({ env: process.env, argv });
  } catch (err) {
    console.error("Invalid configuration:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

/**
 * Returns a copy of the given env object with all `MCP_FILTER_PROXY_*` keys removed.
 * Use this when forwarding env to spawned child processes.
 */
export function stripProxyEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(ENV_PREFIX) && value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
