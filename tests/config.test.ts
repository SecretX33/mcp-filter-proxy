import { describe, it, expect } from "vitest";
import { parseConfig, stripProxyEnv } from "../src/config.js";

describe("parseConfig", () => {
  // --- Upstream transport ---

  it("parses stdio transport with command args", () => {
    const config = parseConfig({
      env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio" },
      argv: ["node", "index.js", "npx", "another-mcp-server", "/tmp"],
    });
    expect(config.transport).toBe("stdio");
    expect(config.command).toBe("npx");
    expect(config.args).toEqual(["another-mcp-server", "/tmp"]);
    expect(config.filters.tools.allowed).toBeNull();
  });

  it("parses http transport with URL and optional command", () => {
    const config = parseConfig({
      env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http" },
      argv: ["node", "index.js", "http://localhost:3001/mcp", "uv", "run", "my-server"],
    });
    expect(config.transport).toBe("http");
    expect(config.url).toBe("http://localhost:3001/mcp");
    expect(config.command).toBe("uv");
    expect(config.args).toEqual(["run", "my-server"]);
  });

  it("parses sse transport with URL only (remote, no spawn)", () => {
    const config = parseConfig({
      env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "sse" },
      argv: ["node", "index.js", "http://remote:4000/sse"],
    });
    expect(config.transport).toBe("sse");
    expect(config.url).toBe("http://remote:4000/sse");
    expect(config.command).toBeNull();
  });

  // --- Positional URL detection ---

  it("recognizes a positional http(s) URL and enables the remote fallback", () => {
    const config = parseConfig({
      env: {},
      argv: ["node", "index.js", "https://remote:4000/mcp"],
    });
    expect(config.transport).toBe("http");
    expect(config.autoNegotiateRemote).toBe(true);
    expect(config.url).toBe("https://remote:4000/mcp");
    expect(config.command).toBeNull();
  });

  it("treats a non-URL first arg as a command to spawn", () => {
    const config = parseConfig({
      env: {},
      argv: ["node", "index.js", "npx", "some-server"],
    });
    expect(config.transport).toBe("stdio");
    expect(config.url).toBeNull();
    expect(config.command).toBe("npx");
    expect(config.args).toEqual(["some-server"]);
  });

  it("throws on a URL-shaped arg with an unsupported scheme", () => {
    expect(() =>
      parseConfig({ env: {}, argv: ["node", "index.js", "ftp://host/x"] }),
    ).toThrow(/Invalid upstream URL/);
  });

  it("throws if stdio transport is given a URL", () => {
    expect(() =>
      parseConfig({
        env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio" },
        argv: ["node", "index.js", "https://remote/mcp"],
      }),
    ).toThrow(/stdio transport does not take a URL/);
  });

  // --- Allowed / denied lists ---

  it("parses allowed tools as a comma-separated glob list", () => {
    const config = parseConfig({
      env: {
        MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio",
        MCP_FILTER_PROXY_ALLOWED_TOOLS: "read_*,write_file",
      },
      argv: ["node", "index.js", "node", "server.js"],
    });
    expect(config.filters.tools.allowed).toEqual(["read_*", "write_file"]);
    expect(config.filters.tools.denied).toBeNull();
  });

  it("parses denied tools as a comma-separated glob list", () => {
    const config = parseConfig({
      env: {
        MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio",
        MCP_FILTER_PROXY_DENIED_TOOLS: "*delete*",
      },
      argv: ["node", "index.js", "node", "server.js"],
    });
    expect(config.filters.tools.allowed).toBeNull();
    expect(config.filters.tools.denied).toEqual(["*delete*"]);
  });

  it("treats empty MCP_FILTER_PROXY_ALLOWED_TOOLS as no allowlist", () => {
    const config = parseConfig({
      env: {
        MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio",
        MCP_FILTER_PROXY_ALLOWED_TOOLS: "",
      },
      argv: ["node", "index.js", "node", "server.js"],
    });
    expect(config.filters.tools.allowed).toBeNull();
  });

  it("treats missing lists as no filter", () => {
    const config = parseConfig({
      env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio" },
      argv: ["node", "index.js", "node", "server.js"],
    });
    expect(config.filters.tools.allowed).toBeNull();
    expect(config.filters.resources.allowed).toBeNull();
    expect(config.filters.prompts.allowed).toBeNull();
    expect(config.filters.tools.denied).toBeNull();
    expect(config.filters.resources.denied).toBeNull();
    expect(config.filters.prompts.denied).toBeNull();
  });

  it("trims whitespace from list entries", () => {
    const config = parseConfig({
      env: {
        MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio",
        MCP_FILTER_PROXY_ALLOWED_TOOLS: " read_file , write_file ",
      },
      argv: ["node", "index.js", "node", "server.js"],
    });
    expect(config.filters.tools.allowed).toEqual(["read_file", "write_file"]);
  });

  it("parses allowed resources and prompts", () => {
    const config = parseConfig({
      env: {
        MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio",
        MCP_FILTER_PROXY_ALLOWED_RESOURCES: "alpha, beta",
        MCP_FILTER_PROXY_ALLOWED_PROMPTS: "greet",
      },
      argv: ["node", "index.js", "node", "server.js"],
    });
    expect(config.filters.resources.allowed).toEqual(["alpha", "beta"]);
    expect(config.filters.prompts.allowed).toEqual(["greet"]);
  });

  it.each([
    ["tools", "MCP_FILTER_PROXY_ALLOWED_TOOLS", "MCP_FILTER_PROXY_DENIED_TOOLS"],
    [
      "resources",
      "MCP_FILTER_PROXY_ALLOWED_RESOURCES",
      "MCP_FILTER_PROXY_DENIED_RESOURCES",
    ],
    ["prompts", "MCP_FILTER_PROXY_ALLOWED_PROMPTS", "MCP_FILTER_PROXY_DENIED_PROMPTS"],
  ])("rejects setting both allow and deny for %s", (_kind, allow, deny) => {
    expect(() =>
      parseConfig({
        env: {
          MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio",
          [allow]: "a",
          [deny]: "b",
        },
        argv: ["node", "index.js", "node", "server.js"],
      }),
    ).toThrow(new RegExp(`Set either ${allow} or ${deny}, not both`));
  });

  // --- Expose transport ---

  it("defaults expose transport to stdio", () => {
    const config = parseConfig({
      env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio" },
      argv: ["node", "index.js", "node", "server.js"],
    });
    expect(config.exposeTransport).toBe("stdio");
  });

  it("parses http expose transport with port and host", () => {
    const config = parseConfig({
      env: {
        MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio",
        MCP_FILTER_PROXY_EXPOSE_TRANSPORT: "http",
        MCP_FILTER_PROXY_EXPOSE_PORT: "9000",
        MCP_FILTER_PROXY_EXPOSE_HOST: "0.0.0.0",
      },
      argv: ["node", "index.js", "node", "server.js"],
    });
    expect(config.exposeTransport).toBe("http");
    expect(config.exposePort).toBe(9000);
    expect(config.exposeHost).toBe("0.0.0.0");
  });

  it("defaults expose port to 8808 and host to 127.0.0.1", () => {
    const config = parseConfig({
      env: {
        MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio",
        MCP_FILTER_PROXY_EXPOSE_TRANSPORT: "http",
      },
      argv: ["node", "index.js", "node", "server.js"],
    });
    expect(config.exposePort).toBe(8808);
    expect(config.exposeHost).toBe("127.0.0.1");
  });

  // --- Upstream auth ---

  it("defaults the static auth scheme to bearer and callback port to 8661", () => {
    const config = parseConfig({
      env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http" },
      argv: ["node", "index.js", "http://localhost:3001/mcp"],
    });
    expect(config.auth.mode).toBe("auto");
    expect(config.auth.token).toBeNull();
    expect(config.auth.tokenScheme).toBe("bearer");
    expect(config.auth.callbackPort).toBe(8661);
  });

  it("parses the basic auth scheme and a static token", () => {
    const config = parseConfig({
      env: {
        MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http",
        MCP_FILTER_PROXY_AUTH_TOKEN: "dXNlcjpwYXNz",
        MCP_FILTER_PROXY_AUTH_SCHEME: "basic",
      },
      argv: ["node", "index.js", "http://localhost:3001/mcp"],
    });
    expect(config.auth.token).toBe("dXNlcjpwYXNz");
    expect(config.auth.tokenScheme).toBe("basic");
  });

  it("throws if MCP_FILTER_PROXY_AUTH_SCHEME is invalid", () => {
    expect(() =>
      parseConfig({
        env: {
          MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http",
          MCP_FILTER_PROXY_AUTH_SCHEME: "digest",
        },
        argv: ["node", "index.js", "http://localhost:3001/mcp"],
      }),
    ).toThrow("MCP_FILTER_PROXY_AUTH_SCHEME");
  });

  // --- Transport autodetection (when MCP_FILTER_PROXY_UPSTREAM_TRANSPORT is unset) ---

  it("autodetects http (with fallback) from a positional URL", () => {
    const config = parseConfig({
      env: {},
      argv: ["node", "index.js", "http://remote:4000/mcp"],
    });
    expect(config.transport).toBe("http");
    expect(config.autoNegotiateRemote).toBe(true);
  });

  it("autodetects an SSE-style URL as sse first", () => {
    const config = parseConfig({
      env: {},
      argv: ["node", "index.js", "http://remote:4000/sse"],
    });
    expect(config.transport).toBe("sse");
    expect(config.autoNegotiateRemote).toBe(true);
  });

  it("autodetects sse first when /sse is a non-final path segment", () => {
    const config = parseConfig({
      env: {},
      argv: ["node", "index.js", "http://remote:4000/mcp/sse"],
    });
    expect(config.transport).toBe("sse");
    expect(config.autoNegotiateRemote).toBe(true);
  });

  it("matches /sse on the path only, not the host", () => {
    const config = parseConfig({
      env: {},
      argv: ["node", "index.js", "http://sse.example.com/mcp"],
    });
    expect(config.transport).toBe("http");
    expect(config.autoNegotiateRemote).toBe(true);
  });

  it("autodetects stdio from a command when no URL is given", () => {
    const config = parseConfig({
      env: {},
      argv: ["node", "index.js", "npx", "some-server"],
    });
    expect(config.transport).toBe("stdio");
    expect(config.autoNegotiateRemote).toBe(false);
    expect(config.command).toBe("npx");
  });

  it("honors an explicit transport and does not enable fallback", () => {
    const config = parseConfig({
      env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http" },
      argv: ["node", "index.js", "http://remote:4000/mcp"],
    });
    expect(config.transport).toBe("http");
    expect(config.autoNegotiateRemote).toBe(false);
  });

  it("throws a clear error when transport cannot be determined", () => {
    expect(() => parseConfig({ env: {}, argv: ["node", "index.js"] })).toThrow(
      /Cannot determine the upstream transport/,
    );
  });

  // --- Default scope, custom headers, and OAuth resource ---

  it("defaults the OAuth scope to openid email profile", () => {
    const config = parseConfig({
      env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http" },
      argv: ["node", "index.js", "http://localhost:3001/mcp"],
    });
    expect(config.auth.scope).toBe("openid email profile");
  });

  it("overrides the default scope when MCP_FILTER_PROXY_OAUTH_SCOPE is set", () => {
    const config = parseConfig({
      env: {
        MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http",
        MCP_FILTER_PROXY_OAUTH_SCOPE: "read:jira",
      },
      argv: ["node", "index.js", "http://localhost:3001/mcp"],
    });
    expect(config.auth.scope).toBe("read:jira");
  });

  it("parses the OAuth resource, defaulting to null", () => {
    const env = { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http" };
    const argv = ["node", "i", "http://localhost:3001/mcp"];
    expect(parseConfig({ env, argv }).auth.resource).toBeNull();
    expect(
      parseConfig({
        env: { ...env, MCP_FILTER_PROXY_OAUTH_RESOURCE: "https://api/v1" },
        argv,
      }).auth.resource,
    ).toBe("https://api/v1");
  });

  it("parses MCP_FILTER_PROXY_HEADERS and expands ${VAR} from the env", () => {
    const config = parseConfig({
      env: {
        MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http",
        MCP_FILTER_PROXY_HEADERS: '{"X-Api-Key":"${MY_KEY}","X-Tenant":"acme"}',
        MY_KEY: "secret-123",
      },
      argv: ["node", "index.js", "http://localhost:3001/mcp"],
    });
    expect(config.headers).toEqual({ "X-Api-Key": "secret-123", "X-Tenant": "acme" });
  });

  it("defaults headers to an empty object and substitutes empty for missing env vars", () => {
    const env = { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http" };
    const argv = ["node", "i", "http://localhost:3001/mcp"];
    expect(parseConfig({ env, argv }).headers).toEqual({});
    expect(
      parseConfig({
        env: { ...env, MCP_FILTER_PROXY_HEADERS: '{"X-Key":"${ABSENT}"}' },
        argv,
      }).headers,
    ).toEqual({ "X-Key": "" });
  });

  it("throws if MCP_FILTER_PROXY_HEADERS is not a JSON object of strings", () => {
    expect(() =>
      parseConfig({
        env: {
          MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http",
          MCP_FILTER_PROXY_HEADERS: '{"X-Num":5}',
        },
        argv: ["node", "index.js", "http://localhost:3001/mcp"],
      }),
    ).toThrow("MCP_FILTER_PROXY_HEADERS");
  });

  // --- Validation ---

  it("throws if MCP_FILTER_PROXY_UPSTREAM_TRANSPORT is invalid", () => {
    expect(() =>
      parseConfig({
        env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "websocket" },
        argv: ["node", "index.js"],
      }),
    ).toThrow("MCP_FILTER_PROXY_UPSTREAM_TRANSPORT");
  });

  it("throws if stdio transport has no command", () => {
    expect(() =>
      parseConfig({
        env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio" },
        argv: ["node", "index.js"],
      }),
    ).toThrow("command");
  });

  it("throws if http/sse transport has no URL", () => {
    expect(() =>
      parseConfig({
        env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http" },
        argv: ["node", "index.js"],
      }),
    ).toThrow(/requires the upstream server URL/);
  });

  it("throws if MCP_FILTER_PROXY_EXPOSE_TRANSPORT is invalid", () => {
    expect(() =>
      parseConfig({
        env: {
          MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio",
          MCP_FILTER_PROXY_EXPOSE_TRANSPORT: "sse",
        },
        argv: ["node", "index.js", "node", "server.js"],
      }),
    ).toThrow("MCP_FILTER_PROXY_EXPOSE_TRANSPORT");
  });

  it("throws if MCP_FILTER_PROXY_EXPOSE_PORT is not a number", () => {
    expect(() =>
      parseConfig({
        env: {
          MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio",
          MCP_FILTER_PROXY_EXPOSE_TRANSPORT: "http",
          MCP_FILTER_PROXY_EXPOSE_PORT: "abc",
        },
        argv: ["node", "index.js", "node", "server.js"],
      }),
    ).toThrow("MCP_FILTER_PROXY_EXPOSE_PORT");
  });
});

describe("stripProxyEnv", () => {
  it("removes all MCP_FILTER_PROXY_ prefixed vars", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio",
      MCP_FILTER_PROXY_ALLOWED_TOOLS: "read_file",
      SOME_API_KEY: "secret123",
    };
    const cleaned = stripProxyEnv(env);
    expect(cleaned.PATH).toBe("/usr/bin");
    expect(cleaned.HOME).toBe("/home/user");
    expect(cleaned.SOME_API_KEY).toBe("secret123");
    expect(cleaned.MCP_FILTER_PROXY_UPSTREAM_TRANSPORT).toBeUndefined();
    expect(cleaned.MCP_FILTER_PROXY_ALLOWED_TOOLS).toBeUndefined();
  });

  it("returns a new object (does not mutate input)", () => {
    const env = { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio", FOO: "bar" };
    const cleaned = stripProxyEnv(env);
    expect(env.MCP_FILTER_PROXY_UPSTREAM_TRANSPORT).toBe("stdio");
    expect(cleaned).not.toBe(env);
  });
});
