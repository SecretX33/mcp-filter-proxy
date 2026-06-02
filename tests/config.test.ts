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

  // --- Validation ---

  it("throws if MCP_FILTER_PROXY_UPSTREAM_TRANSPORT is missing", () => {
    expect(() =>
      parseConfig({ env: {}, argv: ["node", "index.js", "node", "s.js"] }),
    ).toThrow("MCP_FILTER_PROXY_UPSTREAM_TRANSPORT");
  });

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
