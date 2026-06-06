import { z } from "zod";
import { parseUrlStrict } from "./util";

const ENV_PREFIX = "MCP_FILTER_PROXY_";

export type UpstreamTransport = "stdio" | "sse" | "http";
export type ExposeTransport = "stdio" | "http";

export interface ProxyConfig {
  /** How to connect to the upstream (wrapped) server. For a remote upstream this is the first
   * transport attempted; when {@link autoNegotiateRemote} is set, a failed attempt falls back to
   * the other HTTP variant. */
  transport: UpstreamTransport;
  /** True when the transport was autodetected for a remote upstream, enabling the Streamable
   * HTTP↔SSE fallback probe. False when set explicitly (that choice is used as-is, no fallback). */
  autoNegotiateRemote: boolean;
  /** Extra headers to send to an http/sse upstream, with `${VAR}` already expanded from the env. */
  headers: Record<string, string>;
  /** How to expose the proxy to downstream clients. */
  exposeTransport: ExposeTransport;
  /** Per-kind allow/deny name-glob filters for tools, resources, and prompts. */
  filters: ProxyFilterConfig;
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

export interface ProxyFilterConfig {
  tools: KindFilter;
  resources: KindFilter;
  prompts: KindFilter;
}

/** Allow/deny name globs for one kind. `allowed` and `denied` are mutually exclusive; at most one is
 * non-null. A glob with no wildcards matches a name literally. */
export interface KindFilter {
  allowed: string[] | null; // `null` = no allowlist
  denied: string[] | null; // `null` = no denylist
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

/**
 * A JSON object of header name→value; empty/omitted becomes `{}`. Values may contain `${VAR}`
 * placeholders.
 */
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
        code: "custom",
        message: `${ENV_PREFIX}HEADERS must be a JSON object of string values`,
      });
      return z.NEVER;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      ctx.addIssue({
        code: "custom",
        message: `${ENV_PREFIX}HEADERS must be a JSON object of string values`,
      });
      return z.NEVER;
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") {
        ctx.addIssue({
          code: "custom",
          message: `${ENV_PREFIX}HEADERS value for "${key}" must be a string`,
        });
        return z.NEVER;
      }
      out[key] = value;
    }
    return out;
  });

const CommaSeparatedList = z
  .string()
  .transform((v) => {
    const names = v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return names.length > 0 ? names : null;
  })
  .optional()
  .transform((v) => v ?? null);

export const EnvSchema = z
  .object({
    MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: z.enum(["stdio", "sse", "http"]).optional(),
    MCP_FILTER_PROXY_EXPOSE_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
    MCP_FILTER_PROXY_EXPOSE_PORT: z.coerce.number().int().min(1).max(65535).default(8808),
    MCP_FILTER_PROXY_EXPOSE_HOST: z.string().default("127.0.0.1"),
    MCP_FILTER_PROXY_ALLOWED_TOOLS: CommaSeparatedList,
    MCP_FILTER_PROXY_ALLOWED_RESOURCES: CommaSeparatedList,
    MCP_FILTER_PROXY_ALLOWED_PROMPTS: CommaSeparatedList,
    MCP_FILTER_PROXY_DENIED_TOOLS: CommaSeparatedList,
    MCP_FILTER_PROXY_DENIED_RESOURCES: CommaSeparatedList,
    MCP_FILTER_PROXY_DENIED_PROMPTS: CommaSeparatedList,
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
  })
  .superRefine((env, ctx) => {
    const pairs = [
      ["MCP_FILTER_PROXY_ALLOWED_TOOLS", "MCP_FILTER_PROXY_DENIED_TOOLS"],
      ["MCP_FILTER_PROXY_ALLOWED_RESOURCES", "MCP_FILTER_PROXY_DENIED_RESOURCES"],
      ["MCP_FILTER_PROXY_ALLOWED_PROMPTS", "MCP_FILTER_PROXY_DENIED_PROMPTS"],
    ] as const;
    for (const [allow, deny] of pairs) {
      if (env[allow] && env[deny]) {
        ctx.addIssue({
          code: "custom",
          message: `Set either ${allow} or ${deny}, not both`,
          path: [deny],
        });
      }
    }
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
 * Treat the first positional arg as the upstream URL when it carries a `scheme://` prefix, returning
 * the sanitized URL. A bare command (`npx`, `node`) returns null and is spawned over stdio instead.
 * A URL-shaped arg with a bad or unsupported scheme throws via {@link parseUrlStrict}.
 */
function detectUpstreamUrl(arg: string | undefined): string | null {
  if (!arg || !looksLikeUrl(arg)) return null;
  return parseUrlStrict(arg);
}

/**
 * Returns `true` when the `value` carries a `scheme://` prefix.
 */
const looksLikeUrl = (value: string): boolean => /^[a-zA-Z][\w+.-]*:\/\//.test(value);

/** True when the URL path has an `sse` segment (`.../sse`, `.../sse/...`), the conventional
 * Server-Sent Events endpoint; host and query are ignored. `url` is already sanitized, so `new
 * URL` is safe. */
function urlHasSseSegment(url: string): boolean {
  return new URL(url).pathname.split("/").includes("sse");
}

/**
 * Decide which upstream transport to use. An explicit value wins and is used as-is. Otherwise it is
 * inferred: a server URL means a remote upstream (Streamable HTTP first, or SSE first when the path
 * has an `sse` segment, with fallback to the other variant), a spawn command means stdio, and
 * neither is an error.
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
  if (url) {
    const transport = urlHasSseSegment(url) ? "sse" : "http";
    return { transport, autoNegotiateRemote: true };
  }
  if (hasCommand) return { transport: "stdio", autoNegotiateRemote: false };
  throw new Error(
    `Cannot determine the upstream transport. Set ${ENV_PREFIX}UPSTREAM_TRANSPORT explicitly, ` +
      `pass an http(s) URL as the first positional argument (for an http/sse server), ` +
      `or pass a command to spawn as positional arguments (for a stdio server).`,
  );
}

export function parseConfig({ env, argv }: ParseConfigInput): ProxyConfig {
  const parsedEnv = EnvSchema.parse(emptyToUndefined(env));

  const positional = argv.slice(2);
  const url = detectUpstreamUrl(positional[0]);
  const command = (url ? positional[1] : positional[0]) ?? null;
  const args = url ? positional.slice(2) : positional.slice(1);

  const { transport, autoNegotiateRemote } = resolveUpstreamTransport({
    explicit: parsedEnv.MCP_FILTER_PROXY_UPSTREAM_TRANSPORT,
    url,
    hasCommand: command != null,
  });

  if (transport === "stdio" && url) {
    throw new Error(
      "stdio transport does not take a URL; pass the command to spawn as positional arguments",
    );
  }
  if (transport === "stdio" && !command) {
    throw new Error(
      "stdio transport requires a command to spawn the wrapped server " +
        "(pass it as positional CLI arguments after mcp-filter-proxy)",
    );
  }
  if (transport !== "stdio" && !url) {
    throw new Error(
      `${transport} transport requires the upstream server URL as the first positional argument`,
    );
  }

  return {
    transport,
    autoNegotiateRemote,
    headers: expandHeaders(parsedEnv.MCP_FILTER_PROXY_HEADERS, env),
    exposeTransport: parsedEnv.MCP_FILTER_PROXY_EXPOSE_TRANSPORT,
    filters: {
      tools: {
        allowed: parsedEnv.MCP_FILTER_PROXY_ALLOWED_TOOLS,
        denied: parsedEnv.MCP_FILTER_PROXY_DENIED_TOOLS,
      },
      resources: {
        allowed: parsedEnv.MCP_FILTER_PROXY_ALLOWED_RESOURCES,
        denied: parsedEnv.MCP_FILTER_PROXY_DENIED_RESOURCES,
      },
      prompts: {
        allowed: parsedEnv.MCP_FILTER_PROXY_ALLOWED_PROMPTS,
        denied: parsedEnv.MCP_FILTER_PROXY_DENIED_PROMPTS,
      },
    },
    command,
    args,
    url,
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
