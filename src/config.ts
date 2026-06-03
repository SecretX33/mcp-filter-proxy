import { z } from "zod";

const ENV_PREFIX = "MCP_FILTER_PROXY_";

export type UpstreamTransport = "stdio" | "sse" | "http";
export type ExposeTransport = "stdio" | "http";

export interface ProxyConfig {
  /** How to connect to the upstream (wrapped) server. For a remote upstream this is the first
   * transport attempted; when {@link autoNegotiateRemote} is set, a failed Streamable HTTP attempt
   * falls back to SSE. */
  transport: UpstreamTransport;
  /** True when the transport was autodetected for a remote upstream, enabling the http→sse probe.
   * False when the transport was set explicitly (that choice is used as-is, no fallback). */
  autoNegotiateRemote: boolean;
  /** Extra headers to send to an http/sse upstream, with `${VAR}` already expanded from the env. */
  headers: Record<string, string>;
  /** How to expose the proxy to downstream clients. */
  exposeTransport: ExposeTransport;
  /** Allowed tool names. null = allow everything. */
  allowedTools: Set<string> | null;
  /** Allowed resource names. null = allow everything. */
  allowedResources: Set<string> | null;
  /** Allowed prompt names. null = allow everything. */
  allowedPrompts: Set<string> | null;
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
  /** Upstream authentication settings. */
  auth: UpstreamAuthConfig;
}

export type UpstreamAuthMode = "auto" | "none";
export type StaticAuthScheme = "bearer" | "basic";

export interface UpstreamAuthConfig {
  /**
   * Strategy for the upstream connection. `auto` (default) attaches an interactive OAuth
   * provider that only activates when the upstream replies 401; `none` disables it.
   * A static `token` always takes precedence over both.
   */
  mode: UpstreamAuthMode;
  /** Pre-obtained credential sent as `Authorization: <scheme> <token>` to the upstream. */
  token: string | null;
  /**
   * HTTP auth scheme for `token`. The value is sent verbatim after the scheme word, so for
   * `basic` the token must already be the base64 encoding of `username:password`.
   */
  tokenScheme: StaticAuthScheme;
  /** Loopback port the OAuth redirect callback server listens on. */
  callbackPort: number;
  /** OAuth scope to request. Server-advertised scopes take precedence; this is the fallback. */
  scope: string;
  /** RFC 8707 resource/audience to bind the token to, or null to omit (unless the server's
   * Protected Resource Metadata supplies one). */
  resource: string | null;
  /** `client_name` advertised during dynamic client registration. */
  clientName: string;
  /** Directory where OAuth tokens/registration are cached, or null for the default. */
  storeDir: string | null;
}

/** A JSON object of header name→value; empty/omitted becomes `{}`. Values may contain `${VAR}`
 * placeholders, expanded later against the process env in {@link parseConfig}. */
const HeaderMap = z
  .string()
  .optional()
  .transform((v, ctx): Record<string, string> => {
    if (!v) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(v);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${ENV_PREFIX}HEADERS must be a JSON object of string values`,
      });
      return z.NEVER;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${ENV_PREFIX}HEADERS must be a JSON object of string values`,
      });
      return z.NEVER;
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${ENV_PREFIX}HEADERS value for "${key}" must be a string`,
        });
        return z.NEVER;
      }
      out[key] = value;
    }
    return out;
  });

/** Comma-separated allowlist of names; empty/omitted becomes `null` (allow all). */
const CommaSeparatedSet = z
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
  MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: z.enum(["stdio", "sse", "http"]).optional(),
  MCP_FILTER_PROXY_EXPOSE_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
  MCP_FILTER_PROXY_EXPOSE_PORT: z.coerce.number().int().min(1).max(65535).default(8808),
  MCP_FILTER_PROXY_EXPOSE_HOST: z.string().default("127.0.0.1"),
  MCP_FILTER_PROXY_ALLOWED_TOOLS: CommaSeparatedSet,
  MCP_FILTER_PROXY_ALLOWED_RESOURCES: CommaSeparatedSet,
  MCP_FILTER_PROXY_ALLOWED_PROMPTS: CommaSeparatedSet,
  MCP_FILTER_PROXY_SERVER_URL: z
    .string()
    .optional()
    .transform((v) => v ?? null),
  MCP_FILTER_PROXY_UPSTREAM_AUTH: z.enum(["auto", "none"]).default("auto"),
  MCP_FILTER_PROXY_AUTH_TOKEN: z
    .string()
    .optional()
    .transform((v) => v ?? null),
  MCP_FILTER_PROXY_AUTH_SCHEME: z.enum(["bearer", "basic"]).default("bearer"),
  MCP_FILTER_PROXY_OAUTH_CALLBACK_PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(8661),
  MCP_FILTER_PROXY_OAUTH_SCOPE: z.string().default("openid email profile"),
  MCP_FILTER_PROXY_OAUTH_RESOURCE: z
    .string()
    .optional()
    .transform((v) => v ?? null),
  MCP_FILTER_PROXY_OAUTH_CLIENT_NAME: z.string().default("MCP Filter Proxy"),
  MCP_FILTER_PROXY_OAUTH_STORE_DIR: z
    .string()
    .optional()
    .transform((v) => v ?? null),
  MCP_FILTER_PROXY_HEADERS: HeaderMap,
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

/** Replace `${VAR}` placeholders in a header value with the corresponding env var. */
function expandEnvVars(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) {
      console.error(
        `Warning: ${ENV_PREFIX}HEADERS references environment variable ${name}, ` +
          `which is not set; substituting an empty string`,
      );
      return "";
    }
    return resolved;
  });
}

function expandHeaders(
  headers: Record<string, string>,
  env: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, expandEnvVars(value, env)]),
  );
}

/**
 * Decide which upstream transport to use. An explicit value wins and is used as-is. Otherwise it is
 * inferred: a server URL means a remote upstream (try Streamable HTTP first, fall back to SSE), a
 * spawn command means stdio, and neither is an error.
 */
function resolveUpstreamTransport({
  explicit,
  url,
  hasCommand,
}: {
  explicit: UpstreamTransport | undefined;
  url: string | null;
  hasCommand: boolean;
}): { transport: UpstreamTransport; autoNegotiateRemote: boolean } {
  if (explicit) return { transport: explicit, autoNegotiateRemote: false };
  if (url) return { transport: "http", autoNegotiateRemote: true };
  if (hasCommand) return { transport: "stdio", autoNegotiateRemote: false };
  throw new Error(
    `Cannot determine the upstream transport. Set ${ENV_PREFIX}UPSTREAM_TRANSPORT explicitly, ` +
      `or provide ${ENV_PREFIX}SERVER_URL (for an http/sse server), ` +
      `or pass a command to spawn as positional arguments (for a stdio server).`,
  );
}

export function parseConfig({ env, argv }: ParseConfigInput): ProxyConfig {
  const parsedEnv = EnvSchema.parse(emptyToUndefined(env));

  const positional = argv.slice(2);
  const command = positional.length > 0 ? positional[0] : null;
  const args = positional.slice(1);
  const url = parsedEnv.MCP_FILTER_PROXY_SERVER_URL;

  const { transport, autoNegotiateRemote } = resolveUpstreamTransport({
    explicit: parsedEnv.MCP_FILTER_PROXY_UPSTREAM_TRANSPORT,
    url,
    hasCommand: command != null,
  });

  if (transport === "stdio" && !command) {
    throw new Error(
      "stdio transport requires a command to spawn the wrapped server " +
        "(pass it as positional CLI arguments after mcp-filter-proxy)",
    );
  }
  if (transport !== "stdio" && !url) {
    throw new Error(`${ENV_PREFIX}SERVER_URL is required for ${transport} transport`);
  }

  return {
    transport,
    autoNegotiateRemote,
    headers: expandHeaders(parsedEnv.MCP_FILTER_PROXY_HEADERS, env),
    exposeTransport: parsedEnv.MCP_FILTER_PROXY_EXPOSE_TRANSPORT,
    allowedTools: parsedEnv.MCP_FILTER_PROXY_ALLOWED_TOOLS,
    allowedResources: parsedEnv.MCP_FILTER_PROXY_ALLOWED_RESOURCES,
    allowedPrompts: parsedEnv.MCP_FILTER_PROXY_ALLOWED_PROMPTS,
    command,
    args,
    url: parsedEnv.MCP_FILTER_PROXY_SERVER_URL,
    exposePort: parsedEnv.MCP_FILTER_PROXY_EXPOSE_PORT,
    exposeHost: parsedEnv.MCP_FILTER_PROXY_EXPOSE_HOST,
    auth: {
      mode: parsedEnv.MCP_FILTER_PROXY_UPSTREAM_AUTH,
      token: parsedEnv.MCP_FILTER_PROXY_AUTH_TOKEN,
      tokenScheme: parsedEnv.MCP_FILTER_PROXY_AUTH_SCHEME,
      callbackPort: parsedEnv.MCP_FILTER_PROXY_OAUTH_CALLBACK_PORT,
      scope: parsedEnv.MCP_FILTER_PROXY_OAUTH_SCOPE,
      resource: parsedEnv.MCP_FILTER_PROXY_OAUTH_RESOURCE,
      clientName: parsedEnv.MCP_FILTER_PROXY_OAUTH_CLIENT_NAME,
      storeDir: parsedEnv.MCP_FILTER_PROXY_OAUTH_STORE_DIR,
    },
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
