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
    expect(config.allowedTools).toBeNull();
  });

  it("parses http transport with URL and optional command", () => {
    const config = parseConfig({
      env: {
        MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http",
        MCP_FILTER_PROXY_SERVER_URL: "http://localhost:3001/mcp",
      },
      argv: ["node", "index.js", "uv", "run", "my-server"],
    });
    expect(config.transport).toBe("http");
    expect(config.url).toBe("http://localhost:3001/mcp");
    expect(config.command).toBe("uv");
    expect(config.args).toEqual(["run", "my-server"]);
  });

  it("parses sse transport with URL only (remote, no spawn)", () => {
    const config = parseConfig({
      env: {
        MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "sse",
        MCP_FILTER_PROXY_SERVER_URL: "http://remote:4000/sse",
      },
      argv: ["node", "index.js"],
    });
    expect(config.transport).toBe("sse");
    expect(config.url).toBe("http://remote:4000/sse");
    expect(config.command).toBeNull();
  });

  // --- Allowed tools ---

  it("parses allowed tools as comma-separated list", () => {
    const config = parseConfig({
      env: {
        MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio",
        MCP_FILTER_PROXY_ALLOWED_TOOLS: "read_file,write_file",
      },
      argv: ["node", "index.js", "node", "server.js"],
    });
    expect(config.allowedTools).toEqual(new Set(["read_file", "write_file"]));
  });

  it("treats empty MCP_FILTER_PROXY_ALLOWED_TOOLS as allow-all", () => {
    const config = parseConfig({
      env: {
        MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio",
        MCP_FILTER_PROXY_ALLOWED_TOOLS: "",
      },
      argv: ["node", "index.js", "node", "server.js"],
    });
    expect(config.allowedTools).toBeNull();
  });

  it("treats missing MCP_FILTER_PROXY_ALLOWED_TOOLS as allow-all", () => {
    const config = parseConfig({
      env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio" },
      argv: ["node", "index.js", "node", "server.js"],
    });
    expect(config.allowedTools).toBeNull();
  });

  it("trims whitespace from allowed tool names", () => {
    const config = parseConfig({
      env: {
        MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio",
        MCP_FILTER_PROXY_ALLOWED_TOOLS: " read_file , write_file ",
      },
      argv: ["node", "index.js", "node", "server.js"],
    });
    expect(config.allowedTools).toEqual(new Set(["read_file", "write_file"]));
  });

  it("parses allowed resources and prompts as comma-separated lists", () => {
    const config = parseConfig({
      env: {
        MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio",
        MCP_FILTER_PROXY_ALLOWED_RESOURCES: "alpha, beta",
        MCP_FILTER_PROXY_ALLOWED_PROMPTS: "greet",
      },
      argv: ["node", "index.js", "node", "server.js"],
    });
    expect(config.allowedResources).toEqual(new Set(["alpha", "beta"]));
    expect(config.allowedPrompts).toEqual(new Set(["greet"]));
  });

  it("treats missing resource/prompt allowlists as allow-all (null)", () => {
    const config = parseConfig({
      env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio" },
      argv: ["node", "index.js", "node", "server.js"],
    });
    expect(config.allowedResources).toBeNull();
    expect(config.allowedPrompts).toBeNull();
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
      env: {
        MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http",
        MCP_FILTER_PROXY_SERVER_URL: "http://localhost:3001/mcp",
      },
      argv: ["node", "index.js"],
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
        MCP_FILTER_PROXY_SERVER_URL: "http://localhost:3001/mcp",
        MCP_FILTER_PROXY_AUTH_TOKEN: "dXNlcjpwYXNz",
        MCP_FILTER_PROXY_AUTH_SCHEME: "basic",
      },
      argv: ["node", "index.js"],
    });
    expect(config.auth.token).toBe("dXNlcjpwYXNz");
    expect(config.auth.tokenScheme).toBe("basic");
  });

  it("throws if MCP_FILTER_PROXY_AUTH_SCHEME is invalid", () => {
    expect(() =>
      parseConfig({
        env: {
          MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http",
          MCP_FILTER_PROXY_SERVER_URL: "http://localhost:3001/mcp",
          MCP_FILTER_PROXY_AUTH_SCHEME: "digest",
        },
        argv: ["node", "index.js"],
      }),
    ).toThrow("MCP_FILTER_PROXY_AUTH_SCHEME");
  });

  // --- Transport autodetection (when MCP_FILTER_PROXY_UPSTREAM_TRANSPORT is unset) ---

  it("autodetects http (with fallback) from a server URL", () => {
    const config = parseConfig({
      env: { MCP_FILTER_PROXY_SERVER_URL: "http://remote:4000/mcp" },
      argv: ["node", "index.js"],
    });
    expect(config.transport).toBe("http");
    expect(config.autoNegotiateRemote).toBe(true);
  });

  it("autodetects an SSE-style URL as http first too (fallback handles the rest)", () => {
    const config = parseConfig({
      env: { MCP_FILTER_PROXY_SERVER_URL: "http://remote:4000/sse" },
      argv: ["node", "index.js"],
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
      env: {
        MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http",
        MCP_FILTER_PROXY_SERVER_URL: "http://remote:4000/mcp",
      },
      argv: ["node", "index.js"],
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
      env: {
        MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http",
        MCP_FILTER_PROXY_SERVER_URL: "http://localhost:3001/mcp",
      },
      argv: ["node", "index.js"],
    });
    expect(config.auth.scope).toBe("openid email profile");
  });

  it("overrides the default scope when MCP_FILTER_PROXY_OAUTH_SCOPE is set", () => {
    const config = parseConfig({
      env: {
        MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http",
        MCP_FILTER_PROXY_SERVER_URL: "http://localhost:3001/mcp",
        MCP_FILTER_PROXY_OAUTH_SCOPE: "read:jira",
      },
      argv: ["node", "index.js"],
    });
    expect(config.auth.scope).toBe("read:jira");
  });

  it("parses the OAuth resource, defaulting to null", () => {
    const base = {
      MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http",
      MCP_FILTER_PROXY_SERVER_URL: "http://localhost:3001/mcp",
    };
    expect(parseConfig({ env: base, argv: ["node", "i"] }).auth.resource).toBeNull();
    expect(
      parseConfig({
        env: { ...base, MCP_FILTER_PROXY_OAUTH_RESOURCE: "https://api/v1" },
        argv: ["node", "i"],
      }).auth.resource,
    ).toBe("https://api/v1");
  });

  it("parses MCP_FILTER_PROXY_HEADERS and expands ${VAR} from the env", () => {
    const config = parseConfig({
      env: {
        MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http",
        MCP_FILTER_PROXY_SERVER_URL: "http://localhost:3001/mcp",
        MCP_FILTER_PROXY_HEADERS: '{"X-Api-Key":"${MY_KEY}","X-Tenant":"acme"}',
        MY_KEY: "secret-123",
      },
      argv: ["node", "index.js"],
    });
    expect(config.headers).toEqual({ "X-Api-Key": "secret-123", "X-Tenant": "acme" });
  });

  it("defaults headers to an empty object and substitutes empty for missing env vars", () => {
    const base = {
      MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http",
      MCP_FILTER_PROXY_SERVER_URL: "http://localhost:3001/mcp",
    };
    expect(parseConfig({ env: base, argv: ["node", "i"] }).headers).toEqual({});
    expect(
      parseConfig({
        env: { ...base, MCP_FILTER_PROXY_HEADERS: '{"X-Key":"${ABSENT}"}' },
        argv: ["node", "i"],
      }).headers,
    ).toEqual({ "X-Key": "" });
  });

  it("throws if MCP_FILTER_PROXY_HEADERS is not a JSON object of strings", () => {
    expect(() =>
      parseConfig({
        env: {
          MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http",
          MCP_FILTER_PROXY_SERVER_URL: "http://localhost:3001/mcp",
          MCP_FILTER_PROXY_HEADERS: '{"X-Num":5}',
        },
        argv: ["node", "index.js"],
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

  it("throws if http/sse transport has no MCP_FILTER_PROXY_SERVER_URL", () => {
    expect(() =>
      parseConfig({
        env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http" },
        argv: ["node", "index.js"],
      }),
    ).toThrow("MCP_FILTER_PROXY_SERVER_URL");
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
      MCP_FILTER_PROXY_SERVER_URL: "http://localhost:3001",
      SOME_API_KEY: "secret123",
    };
    const cleaned = stripProxyEnv(env);
    expect(cleaned.PATH).toBe("/usr/bin");
    expect(cleaned.HOME).toBe("/home/user");
    expect(cleaned.SOME_API_KEY).toBe("secret123");
    expect(cleaned.MCP_FILTER_PROXY_UPSTREAM_TRANSPORT).toBeUndefined();
    expect(cleaned.MCP_FILTER_PROXY_ALLOWED_TOOLS).toBeUndefined();
    expect(cleaned.MCP_FILTER_PROXY_SERVER_URL).toBeUndefined();
  });

  it("returns a new object (does not mutate input)", () => {
    const env = { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio", FOO: "bar" };
    const cleaned = stripProxyEnv(env);
    expect(env.MCP_FILTER_PROXY_UPSTREAM_TRANSPORT).toBe("stdio");
    expect(cleaned).not.toBe(env);
  });
});
