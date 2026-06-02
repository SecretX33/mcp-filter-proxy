---
name: ""
overview: ""
todos: []
isProject: false
---

# MCP Filter Proxy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a generic MCP proxy server in TypeScript that wraps any MCP server (stdio, SSE, or Streamable HTTP), filters which tools are exposed via an allowlist, and optionally bridges between transport types (e.g. expose a stdio server over HTTP, or an HTTP server as stdio).

**Architecture:** The proxy connects to an upstream MCP server using one transport (stdio, SSE, or Streamable HTTP) and exposes itself to downstream clients using a potentially *different* transport. On `tools/list`, it filters the response to only include allowed tools. On `tools/call`, it rejects calls to tools not on the allowlist. Resources and prompts are proxied through unfiltered. All configuration is via environment variables (prefixed `MCP_FILTER_PROXY_`) except the wrapped server command/args which are CLI arguments. When spawning child processes, all env vars are forwarded *except* the `MCP_FILTER_PROXY_`* vars, which are stripped to avoid leaking proxy config to the wrapped server.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` (v1), `@modelcontextprotocol/node`, Express, pnpm, Node.js 18+

---

## File Structure

```
mcp-filter-proxy/
├── package.json
├── tsconfig.json
├── .gitignore
├── src/
│   ├── index.ts                    # Entry point: parse env/args, orchestrate startup
│   ├── config.ts                   # Parse env vars + CLI args into typed config
│   ├── filter.ts                   # Tool filtering logic (allowlist check)
│   ├── proxy.ts                    # Core proxy: wire Server ↔ Client with filtering
│   ├── transports/
│   │   ├── upstream-stdio.ts       # Create StdioClientTransport (connect to upstream)
│   │   ├── upstream-sse.ts         # Create SSEClientTransport (connect to upstream)
│   │   └── upstream-http.ts        # Create StreamableHTTPClientTransport (connect to upstream)
│   ├── server/
│   │   ├── stdio.ts                # Expose proxy via StdioServerTransport
│   │   └── http.ts                 # Expose proxy via Express + StreamableHTTPServerTransport
├── tests/
│   ├── config.test.ts              # Config parsing tests
│   ├── filter.test.ts              # Allowlist filtering tests
│   └── proxy.test.ts               # Integration: proxy with a mock stdio server
```

### Responsibilities


| File                           | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`                    | Single source of truth for all configuration. Reads `MCP_FILTER_PROXY_UPSTREAM_TRANSPORT`, `MCP_FILTER_PROXY_ALLOWED_TOOLS`, `MCP_FILTER_PROXY_SERVER_URL`, `MCP_FILTER_PROXY_EXPOSE_TRANSPORT`, `MCP_FILTER_PROXY_EXPOSE_PORT`, `MCP_FILTER_PROXY_EXPOSE_HOST` from env. Also exports `stripProxyEnv()` to remove all `MCP_FILTER_PROXY_*` vars from a copy of `process.env`. Reads wrapped command + args from `process.argv`. Returns a typed `ProxyConfig` object. |
| `filter.ts`                    | Pure functions: `createToolFilter(allowedTools)` returns a filter object. `filterToolList(tools, filter)` filters an array. `isToolAllowed(name, filter)` checks a single name. No I/O.                                                                                                                                                                                                                                                                       |
| `proxy.ts`                     | Creates a low-level `Server`, connects a `Client` to upstream via a provided transport, wires `tools/list` and `tools/call` handlers with filtering. Proxies `resources/*` and `prompts/*` unfiltered. Accepts the downstream server transport as a parameter (does not decide which transport to use).                                                                                                                                                       |
| `transports/upstream-stdio.ts` | Builds a `StdioClientTransport` that connects to the upstream server. Forwards cleaned env (no `MCP_FILTER_PROXY_*` vars) to the spawned child.                                                                                                                                                                                                                                                                                                               |
| `transports/upstream-sse.ts`   | Builds an `SSEClientTransport` that connects to the upstream server.                                                                                                                                                                                                                                                                                                                                                                                          |
| `transports/upstream-http.ts`  | Builds a `StreamableHTTPClientTransport` that connects to the upstream server.                                                                                                                                                                                                                                                                                                                                                                                |
| `server/stdio.ts`              | Creates a `StdioServerTransport` for exposing the proxy to downstream clients via stdio.                                                                                                                                                                                                                                                                                                                                                                      |
| `server/http.ts`               | Creates an Express app with `NodeStreamableHTTPServerTransport` for exposing the proxy to downstream clients over HTTP.                                                                                                                                                                                                                                                                                                                                       |
| `index.ts`                     | Glue: parse config, optionally spawn a local upstream process (and wait for it), create the upstream transport, create the downstream server transport, start the proxy.                                                                                                                                                                                                                                                                                      |


---

## Environment Variables

All proxy env vars are prefixed with `MCP_FILTER_PROXY_` to avoid collisions. These vars are **stripped** from the environment before forwarding to the wrapped server.


| Variable                            | Required          | Default       | Description                                                       |
| ----------------------------------- | ----------------- | ------------- | ----------------------------------------------------------------- |
| `MCP_FILTER_PROXY_UPSTREAM_TRANSPORT`        | Yes               | —             | Upstream transport: `stdio`, `sse`, or `http`                     |
| `MCP_FILTER_PROXY_ALLOWED_TOOLS`    | No                | *(allow all)* | Comma-separated tool names. Empty or missing = allow everything.  |
| `MCP_FILTER_PROXY_SERVER_URL`       | For `sse`/`http`  | —             | URL of the upstream MCP server (e.g. `http://localhost:3001/mcp`) |
| `MCP_FILTER_PROXY_EXPOSE_TRANSPORT` | No                | `stdio`       | How to expose the proxy to downstream clients: `stdio` or `http`  |
| `MCP_FILTER_PROXY_EXPOSE_PORT`      | For `http` expose | `8808`        | Port for the exposed HTTP server                                  |
| `MCP_FILTER_PROXY_EXPOSE_HOST`      | No                | `127.0.0.1`   | Host/bind address for the exposed HTTP server                     |


### CLI Arguments

The wrapped server command and args are positional CLI arguments (everything after `node dist/index.js`):

```bash
# stdio upstream, stdio expose (default)
MCP_FILTER_PROXY_UPSTREAM_TRANSPORT=stdio MCP_FILTER_PROXY_ALLOWED_TOOLS=read_file,list_files \
  node dist/index.js npx another-mcp-server /home/user

# stdio upstream, http expose (bridge: stdio → http)
MCP_FILTER_PROXY_UPSTREAM_TRANSPORT=stdio MCP_FILTER_PROXY_EXPOSE_TRANSPORT=http MCP_FILTER_PROXY_EXPOSE_PORT=9000 \
  node dist/index.js npx another-mcp-server /home/user

# http upstream, stdio expose (bridge: http → stdio)
MCP_FILTER_PROXY_UPSTREAM_TRANSPORT=http MCP_FILTER_PROXY_SERVER_URL=http://remote:3001/mcp MCP_FILTER_PROXY_ALLOWED_TOOLS=query \
  node dist/index.js

# http upstream with locally spawned server
MCP_FILTER_PROXY_UPSTREAM_TRANSPORT=http MCP_FILTER_PROXY_SERVER_URL=http://localhost:3001/mcp \
  node dist/index.js uv run my-mcp-server --port 3001
```

If no CLI arguments are provided for `sse`/`http` upstream, it connects to `MCP_FILTER_PROXY_SERVER_URL` directly (remote server, no spawn).

### Example AI Tool Configurations

```jsonc
// Filter tools from a stdio server (most common use case)
{
  "mcpServers": {
    "filtered-filesystem": {
      "command": "node",
      "args": ["/path/to/mcp-filter-proxy/dist/index.js", "npx", "another-mcp-server", "/home/user"],
      "env": {
        "MCP_FILTER_PROXY_UPSTREAM_TRANSPORT": "stdio",
        "MCP_FILTER_PROXY_ALLOWED_TOOLS": "read_file,list_directory,search_files"
      }
    }
  }
}
```

```jsonc
// Bridge: expose a stdio server over HTTP
{
  "mcpServers": {
    "filesystem-http": {
      "command": "node",
      "args": ["/path/to/mcp-filter-proxy/dist/index.js", "npx", "another-mcp-server", "/home/user"],
      "env": {
        "MCP_FILTER_PROXY_UPSTREAM_TRANSPORT": "stdio",
        "MCP_FILTER_PROXY_EXPOSE_TRANSPORT": "http",
        "MCP_FILTER_PROXY_EXPOSE_PORT": "9000"
      }
    }
  }
}
```

### Transport Bridging Matrix


| Upstream (`MCP_FILTER_PROXY_UPSTREAM_TRANSPORT`) | Expose (`MCP_FILTER_PROXY_EXPOSE_TRANSPORT`) | Use Case                                            |
| --------------------------------------- | -------------------------------------------- | --------------------------------------------------- |
| `stdio`                                 | `stdio` (default)                            | Filter tools, same transport                        |
| `stdio`                                 | `http`                                       | Expose a local stdio server over HTTP               |
| `sse`                                   | `stdio`                                      | Make an SSE server usable by stdio-only clients     |
| `http`                                  | `stdio`                                      | Make an HTTP server usable by stdio-only clients    |
| `sse`                                   | `http`                                       | Bridge + filter between HTTP variants               |
| `http`                                  | `http`                                       | Filter tools on an HTTP server, re-expose over HTTP |


---

## Task 1: Project Scaffolding

**Files:**

- Create: `mcp-filter-proxy/package.json`
- Create: `mcp-filter-proxy/tsconfig.json`
- Create: `mcp-filter-proxy/.gitignore`
- **Step 1: Create project directory and initialize with pnpm**

```bash
mkdir mcp-filter-proxy && cd mcp-filter-proxy
pnpm init
```

- **Step 2: Install dependencies**

```bash
pnpm add @modelcontextprotocol/sdk @modelcontextprotocol/node express zod
pnpm add -D typescript @types/node @types/express vitest
```

- **Step 3: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- **Step 4: Add scripts to package.json**

Add `"type": "module"` and these scripts:

```json
{
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- **Step 5: Write .gitignore**

```
node_modules/
dist/
*.tsbuildinfo
```

- **Step 6: Create directory structure**

```bash
mkdir -p src/transports src/server tests
```

- **Step 7: Commit**

```bash
git init
git add package.json tsconfig.json .gitignore pnpm-lock.yaml
git commit -m "chore: scaffold mcp-filter-proxy project"
```

---

## Task 2: Config Parsing

**Files:**

- Create: `src/config.ts`
- Create: `tests/config.test.ts`
- **Step 1: Write the failing tests for config parsing**

```typescript
// tests/config.test.ts
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
      env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http", MCP_FILTER_PROXY_SERVER_URL: "http://localhost:3001/mcp" },
      argv: ["node", "index.js", "uv", "run", "my-server"],
    });
    expect(config.transport).toBe("http");
    expect(config.url).toBe("http://localhost:3001/mcp");
    expect(config.command).toBe("uv");
    expect(config.args).toEqual(["run", "my-server"]);
  });

  it("parses sse transport with URL only (remote, no spawn)", () => {
    const config = parseConfig({
      env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "sse", MCP_FILTER_PROXY_SERVER_URL: "http://remote:4000/sse" },
      argv: ["node", "index.js"],
    });
    expect(config.transport).toBe("sse");
    expect(config.url).toBe("http://remote:4000/sse");
    expect(config.command).toBeNull();
  });

  // --- Allowed tools ---

  it("parses allowed tools as comma-separated list", () => {
    const config = parseConfig({
      env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio", MCP_FILTER_PROXY_ALLOWED_TOOLS: "read_file,write_file" },
      argv: ["node", "index.js", "node", "server.js"],
    });
    expect(config.allowedTools).toEqual(new Set(["read_file", "write_file"]));
  });

  it("treats empty MCP_FILTER_PROXY_ALLOWED_TOOLS as allow-all", () => {
    const config = parseConfig({
      env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio", MCP_FILTER_PROXY_ALLOWED_TOOLS: "" },
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
      env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio", MCP_FILTER_PROXY_ALLOWED_TOOLS: " read_file , write_file " },
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
      env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio", MCP_FILTER_PROXY_EXPOSE_TRANSPORT: "http" },
      argv: ["node", "index.js", "node", "server.js"],
    });
    expect(config.exposePort).toBe(8808);
    expect(config.exposeHost).toBe("127.0.0.1");
  });

  // --- Validation ---

  it("throws if MCP_FILTER_PROXY_UPSTREAM_TRANSPORT is missing", () => {
    expect(() => parseConfig({ env: {}, argv: ["node", "index.js", "node", "s.js"] }))
      .toThrow("MCP_FILTER_PROXY_UPSTREAM_TRANSPORT");
  });

  it("throws if MCP_FILTER_PROXY_UPSTREAM_TRANSPORT is invalid", () => {
    expect(() => parseConfig({ env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "websocket" }, argv: ["node", "index.js"] }))
      .toThrow("MCP_FILTER_PROXY_UPSTREAM_TRANSPORT");
  });

  it("throws if stdio transport has no command", () => {
    expect(() => parseConfig({ env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio" }, argv: ["node", "index.js"] }))
      .toThrow("command");
  });

  it("throws if http/sse transport has no MCP_FILTER_PROXY_SERVER_URL", () => {
    expect(() => parseConfig({ env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "http" }, argv: ["node", "index.js"] }))
      .toThrow("MCP_FILTER_PROXY_SERVER_URL");
  });

  it("throws if MCP_FILTER_PROXY_EXPOSE_TRANSPORT is invalid", () => {
    expect(() => parseConfig({
      env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio", MCP_FILTER_PROXY_EXPOSE_TRANSPORT: "sse" },
      argv: ["node", "index.js", "node", "server.js"],
    })).toThrow("MCP_FILTER_PROXY_EXPOSE_TRANSPORT");
  });

  it("throws if MCP_FILTER_PROXY_EXPOSE_PORT is not a number", () => {
    expect(() => parseConfig({
      env: { MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio", MCP_FILTER_PROXY_EXPOSE_TRANSPORT: "http", MCP_FILTER_PROXY_EXPOSE_PORT: "abc" },
      argv: ["node", "index.js", "node", "server.js"],
    })).toThrow("MCP_FILTER_PROXY_EXPOSE_PORT");
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
```

- **Step 2: Run tests to verify they fail**

```bash
cd mcp-filter-proxy && pnpm test
```

Expected: FAIL — `parseConfig` does not exist yet.

- **Step 3: Implement config.ts**

```typescript
// src/config.ts

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

const VALID_UPSTREAM_TRANSPORTS = new Set<string>(["stdio", "sse", "http"]);
const VALID_EXPOSE_TRANSPORTS = new Set<string>(["stdio", "http"]);

/**
 * Returns a copy of the given env object with all MCP_FILTER_PROXY_* keys removed.
 * Use this when forwarding env to spawned child processes.
 */
export function stripProxyEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(ENV_PREFIX) && value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

export function parseConfig(input: { env: Record<string, string | undefined>; argv: string[] }): ProxyConfig {
  const { env, argv } = input;

  // Upstream transport
  const transport = env.MCP_FILTER_PROXY_UPSTREAM_TRANSPORT;
  if (!transport) {
    throw new Error("MCP_FILTER_PROXY_UPSTREAM_TRANSPORT environment variable is required (stdio | sse | http)");
  }
  if (!VALID_UPSTREAM_TRANSPORTS.has(transport)) {
    throw new Error(`MCP_FILTER_PROXY_UPSTREAM_TRANSPORT must be one of: stdio, sse, http. Got: "${transport}"`);
  }

  // Expose transport
  const exposeTransport = env.MCP_FILTER_PROXY_EXPOSE_TRANSPORT ?? "stdio";
  if (!VALID_EXPOSE_TRANSPORTS.has(exposeTransport)) {
    throw new Error(`MCP_FILTER_PROXY_EXPOSE_TRANSPORT must be one of: stdio, http. Got: "${exposeTransport}"`);
  }

  // Expose port
  let exposePort = 8808;
  if (env.MCP_FILTER_PROXY_EXPOSE_PORT !== undefined) {
    exposePort = parseInt(env.MCP_FILTER_PROXY_EXPOSE_PORT, 10);
    if (isNaN(exposePort)) {
      throw new Error(`MCP_FILTER_PROXY_EXPOSE_PORT must be a valid number. Got: "${env.MCP_FILTER_PROXY_EXPOSE_PORT}"`);
    }
  }

  // Expose host
  const exposeHost = env.MCP_FILTER_PROXY_EXPOSE_HOST ?? "127.0.0.1";

  // Allowed tools
  const rawAllowed = env.MCP_FILTER_PROXY_ALLOWED_TOOLS;
  let allowedTools: Set<string> | null = null;
  if (rawAllowed !== undefined && rawAllowed.trim() !== "") {
    const names = rawAllowed.split(",").map(s => s.trim()).filter(Boolean);
    if (names.length > 0) {
      allowedTools = new Set(names);
    }
  }

  // Command + args from CLI (everything after "node index.js")
  const cliArgs = argv.slice(2);
  const command = cliArgs.length > 0 ? cliArgs[0] : null;
  const args = cliArgs.slice(1);

  // URL for sse/http
  const url = env.MCP_FILTER_PROXY_SERVER_URL ?? null;

  // Validation
  if (transport === "stdio" && !command) {
    throw new Error("stdio transport requires a command as CLI argument (e.g. node server.js)");
  }
  if ((transport === "sse" || transport === "http") && !url) {
    throw new Error("MCP_FILTER_PROXY_SERVER_URL environment variable is required for sse/http transports");
  }

  return {
    transport: transport as UpstreamTransport,
    exposeTransport: exposeTransport as ExposeTransport,
    allowedTools,
    command,
    args,
    url,
    exposePort,
    exposeHost,
  };
}
```

- **Step 4: Run tests to verify they pass**

```bash
pnpm test
```

Expected: All tests PASS.

- **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add config parsing with upstream and expose transport options"
```

---

## Task 3: Tool Filtering Logic

**Files:**

- Create: `src/filter.ts`
- Create: `tests/filter.test.ts`
- **Step 1: Write the failing tests**

```typescript
// tests/filter.test.ts
import { describe, it, expect } from "vitest";
import { createToolFilter, filterToolList, isToolAllowed } from "../src/filter.js";

describe("createToolFilter", () => {
  it("returns allow-all filter when allowedTools is null", () => {
    const filter = createToolFilter(null);
    expect(isToolAllowed("anything", filter)).toBe(true);
  });

  it("returns selective filter when allowedTools is a set", () => {
    const filter = createToolFilter(new Set(["read_file", "list_dir"]));
    expect(isToolAllowed("read_file", filter)).toBe(true);
    expect(isToolAllowed("list_dir", filter)).toBe(true);
    expect(isToolAllowed("delete_file", filter)).toBe(false);
  });
});

describe("filterToolList", () => {
  const tools = [
    { name: "read_file", description: "Read", inputSchema: { type: "object" as const } },
    { name: "write_file", description: "Write", inputSchema: { type: "object" as const } },
    { name: "delete_file", description: "Delete", inputSchema: { type: "object" as const } },
  ];

  it("returns all tools when filter allows everything", () => {
    const filter = createToolFilter(null);
    expect(filterToolList(tools, filter)).toHaveLength(3);
  });

  it("returns only allowed tools", () => {
    const filter = createToolFilter(new Set(["read_file"]));
    const result = filterToolList(tools, filter);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("read_file");
  });

  it("returns empty array when no tools match", () => {
    const filter = createToolFilter(new Set(["nonexistent"]));
    expect(filterToolList(tools, filter)).toHaveLength(0);
  });
});
```

- **Step 2: Run tests to verify they fail**

```bash
pnpm test
```

Expected: FAIL — module does not exist.

- **Step 3: Implement filter.ts**

```typescript
// src/filter.ts

export interface ToolFilter {
  allowAll: boolean;
  allowed: Set<string>;
}

export function createToolFilter(allowedTools: Set<string> | null): ToolFilter {
  if (allowedTools === null) {
    return { allowAll: true, allowed: new Set() };
  }
  return { allowAll: false, allowed: allowedTools };
}

export function isToolAllowed(name: string, filter: ToolFilter): boolean {
  return filter.allowAll || filter.allowed.has(name);
}

export function filterToolList<T extends { name: string }>(tools: T[], filter: ToolFilter): T[] {
  if (filter.allowAll) return tools;
  return tools.filter(t => filter.allowed.has(t.name));
}
```

- **Step 4: Run tests to verify they pass**

```bash
pnpm test
```

Expected: All tests PASS.

- **Step 5: Commit**

```bash
git add src/filter.ts tests/filter.test.ts
git commit -m "feat: add tool allowlist filtering logic"
```

---

## Task 4: Upstream Transport Adapters

**Files:**

- Create: `src/transports/upstream-stdio.ts`
- Create: `src/transports/upstream-sse.ts`
- Create: `src/transports/upstream-http.ts`
- **Step 1: Implement stdio upstream transport**

Note: `StdioClientTransport` accepts an `env` option. We use `stripProxyEnv()` to forward all environment variables *except* the `MCP_FILTER_PROXY_`* ones to the spawned child process.

```typescript
// src/transports/upstream-stdio.ts
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { stripProxyEnv } from "../config.js";

export function createStdioUpstream(command: string, args: string[]): StdioClientTransport {
  return new StdioClientTransport({
    command,
    args,
    env: stripProxyEnv(process.env),
  });
}
```

- **Step 2: Implement SSE upstream transport**

```typescript
// src/transports/upstream-sse.ts
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

export function createSSEUpstream(url: string): SSEClientTransport {
  return new SSEClientTransport(new URL(url));
}
```

- **Step 3: Implement Streamable HTTP upstream transport**

```typescript
// src/transports/upstream-http.ts
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export function createHTTPUpstream(url: string): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(url));
}
```

- **Step 4: Compile to check for type errors**

```bash
pnpm build
```

Expected: Compiles without errors.

- **Step 5: Commit**

```bash
git add src/transports/
git commit -m "feat: add upstream transport adapters for stdio, sse, and http"
```

---

## Task 5: Downstream Server Transports

**Files:**

- Create: `src/server/stdio.ts`
- Create: `src/server/http.ts`
- **Step 1: Implement stdio server transport (simple wrapper)**

```typescript
// src/server/stdio.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export async function exposeViaStdio(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

- **Step 2: Implement HTTP server transport**

This creates an Express app with `NodeStreamableHTTPServerTransport` for each session. The proxy `Server` instance is connected per-request in stateless mode.

```typescript
// src/server/http.ts
import express from "express";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";

export interface HttpExposeOptions {
  port: number;
  host: string;
  createServer: () => McpServer;
}

export function exposeViaHttp(options: HttpExposeOptions): Promise<void> {
  const { port, host, createServer } = options;
  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    const server = createServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({ error: "Method not allowed" });
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).json({ error: "Method not allowed" });
  });

  return new Promise((resolve) => {
    app.listen(port, host, () => {
      console.error(`MCP filter proxy HTTP server listening on http://${host}:${port}/mcp`);
      resolve();
    });
  });
}
```

- **Step 3: Compile to check for type errors**

```bash
pnpm build
```

Expected: Compiles without errors. If `@modelcontextprotocol/node` import path needs adjustment (e.g. a subpath like `@modelcontextprotocol/node/server`), fix based on the installed package's exports.

- **Step 4: Commit**

```bash
git add src/server/
git commit -m "feat: add downstream server transports for stdio and http"
```

---

## Task 6: Core Proxy Server

**Files:**

- Create: `src/proxy.ts`
- **Step 1: Implement the proxy**

The proxy creates a low-level `Server`, wires it to the upstream `Client`, and returns the `Server` so the caller can connect it to any downstream transport. For HTTP expose mode (stateless, one `Server` per request), a factory function is provided instead.

```typescript
// src/proxy.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type ToolFilter, filterToolList, isToolAllowed } from "./filter.js";
import type { ExposeTransport } from "./config.js";
import { exposeViaStdio } from "./server/stdio.js";
import { exposeViaHttp } from "./server/http.js";

export interface ProxyOptions {
  upstreamTransport: Transport;
  toolFilter: ToolFilter;
  exposeTransport: ExposeTransport;
  exposePort: number;
  exposeHost: string;
}

function wireProxyHandlers(
  proxy: Server,
  upstream: Client,
  toolFilter: ToolFilter,
): void {
  const caps = upstream.getServerCapabilities();

  if (caps?.tools) {
    proxy.setRequestHandler(ListToolsRequestSchema, async (request) => {
      const result = await upstream.listTools(request.params);
      return {
        tools: filterToolList(result.tools, toolFilter),
        nextCursor: result.nextCursor,
      };
    });

    proxy.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name } = request.params;
      if (!isToolAllowed(name, toolFilter)) {
        throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
      }
      return await upstream.callTool(request.params);
    });
  }

  if (caps?.resources) {
    proxy.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      return await upstream.listResources(request.params);
    });

    proxy.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return await upstream.readResource(request.params);
    });
  }

  if (caps?.prompts) {
    proxy.setRequestHandler(ListPromptsRequestSchema, async (request) => {
      return await upstream.listPrompts(request.params);
    });

    proxy.setRequestHandler(GetPromptRequestSchema, async (request) => {
      return await upstream.getPrompt(request.params);
    });
  }
}

function buildCapabilities(upstream: Client): Record<string, Record<string, never>> {
  const caps: Record<string, Record<string, never>> = {};
  const upCaps = upstream.getServerCapabilities();
  if (upCaps?.tools) caps.tools = {};
  if (upCaps?.resources) caps.resources = {};
  if (upCaps?.prompts) caps.prompts = {};
  return caps;
}

export async function startProxy(options: ProxyOptions): Promise<void> {
  const { upstreamTransport, toolFilter, exposeTransport, exposePort, exposeHost } = options;

  // Connect to upstream server as a client
  const upstream = new Client({ name: PROJECT_INFO.name, version: PROJECT_INFO.version });
  await upstream.connect(upstreamTransport);

  if (exposeTransport === "stdio") {
    // Single persistent connection: one Server, one Client
    const proxy = new Server(
      { name: PROJECT_INFO.name, version: PROJECT_INFO.version },
      { capabilities: buildCapabilities(upstream) },
    );
    wireProxyHandlers(proxy, upstream, toolFilter);
    await exposeViaStdio(proxy);

    process.on("SIGINT", async () => {
      await upstream.close();
      await proxy.close();
      process.exit(0);
    });
  } else {
    // HTTP: stateless, create a new Server per request, all sharing the same upstream Client
    await exposeViaHttp({
      port: exposePort,
      host: exposeHost,
      createServer: () => {
        const proxy = new Server(
          { name: PROJECT_INFO.name, version: PROJECT_INFO.version },
          { capabilities: buildCapabilities(upstream) },
        );
        wireProxyHandlers(proxy, upstream, toolFilter);
        return proxy;
      },
    });

    process.on("SIGINT", async () => {
      await upstream.close();
      process.exit(0);
    });
  }
}
```

- **Step 2: Compile to check for type errors**

```bash
pnpm build
```

Expected: Compiles without errors. Some import paths or types may need adjustment based on the exact SDK version — fix any type errors that arise.

- **Step 3: Commit**

```bash
git add src/proxy.ts
git commit -m "feat: add core proxy with tool filtering and transport bridging"
```

---

## Task 7: Entry Point

**Files:**

- Create: `src/index.ts`
- **Step 1: Implement the entry point**

All spawned processes receive a cleaned env (no `MCP_FILTER_PROXY_`* vars) — both the `StdioClientTransport` (via `stripProxyEnv` in `upstream-stdio.ts`) and manually spawned HTTP/SSE server processes (via `stripProxyEnv` in `spawn()`).

```typescript
#!/usr/bin/env node
// src/index.ts
import { spawn } from "child_process";
import { parseConfig, stripProxyEnv } from "./config.js";
import { createToolFilter } from "./filter.js";
import { createStdioUpstream } from "./transports/upstream-stdio.js";
import { createSSEUpstream } from "./transports/upstream-sse.js";
import { createHTTPUpstream } from "./transports/upstream-http.js";
import { startProxy } from "./proxy.js";

async function main(): Promise<void> {
  const config = parseConfig({ env: process.env, argv: process.argv });
  const toolFilter = createToolFilter(config.allowedTools);

  // For sse/http upstream with a command: spawn the server process, wait for it
  if (config.transport !== "stdio" && config.command) {
    const child = spawn(config.command, config.args, {
      stdio: ["ignore", "inherit", "inherit"],
      env: stripProxyEnv(process.env),
    });
    child.on("error", (err) => {
      console.error(`Failed to spawn server: ${err.message}`);
      process.exit(1);
    });
    child.on("exit", (code) => {
      console.error(`Wrapped server exited with code ${code}`);
      process.exit(code ?? 1);
    });

    await waitForServer(config.url!, 15_000);
  }

  // Create the appropriate upstream transport
  let upstreamTransport;
  switch (config.transport) {
    case "stdio":
      upstreamTransport = createStdioUpstream(config.command!, config.args);
      break;
    case "sse":
      upstreamTransport = createSSEUpstream(config.url!);
      break;
    case "http":
      upstreamTransport = createHTTPUpstream(config.url!);
      break;
  }

  await startProxy({
    upstreamTransport,
    toolFilter,
    exposeTransport: config.exposeTransport,
    exposePort: config.exposePort,
    exposeHost: config.exposeHost,
  });
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(1000) });
      if (res.ok || res.status < 500) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server at ${url} did not become reachable within ${timeoutMs}ms`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- **Step 2: Compile the full project**

```bash
pnpm build
```

Expected: Compiles without errors.

- **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add entry point with env forwarding and server spawning"
```

---

## Task 8: Integration Tests

**Files:**

- Create: `tests/proxy.test.ts`
- **Step 1: Write integration tests using a mock stdio MCP server**

```typescript
// tests/proxy.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, unlinkSync } from "fs";
import { resolve } from "path";

// Write a tiny inline MCP server that exposes 3 tools
const MOCK_SERVER_PATH = resolve("tests/_mock_server.mjs");

const MOCK_SERVER_CODE = `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "mock", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "safe_tool", description: "Safe", inputSchema: { type: "object" } },
    { name: "dangerous_tool", description: "Danger", inputSchema: { type: "object" } },
    { name: "another_tool", description: "Another", inputSchema: { type: "object" } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: "text", text: "called:" + req.params.name }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
`;

beforeAll(() => {
  writeFileSync(MOCK_SERVER_PATH, MOCK_SERVER_CODE);
});

afterAll(() => {
  try { unlinkSync(MOCK_SERVER_PATH); } catch {}
});

describe("proxy integration (stdio → stdio)", () => {
  it("filters tools when MCP_ALLOWED_TOOLS is set", async () => {
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: "node",
      args: ["dist/index.js", "node", MOCK_SERVER_PATH],
      env: {
        ...process.env,
        MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio",
        MCP_FILTER_PROXY_ALLOWED_TOOLS: "safe_tool,another_tool",
      },
    });

    await client.connect(transport);

    // tools/list should only return allowed tools
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("safe_tool");
    expect(names).toContain("another_tool");
    expect(names).not.toContain("dangerous_tool");
    expect(tools).toHaveLength(2);

    // tools/call for an allowed tool should work
    const result = await client.callTool({ name: "safe_tool", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "called:safe_tool" }]);

    // tools/call for a blocked tool should fail
    await expect(client.callTool({ name: "dangerous_tool", arguments: {} }))
      .rejects.toThrow();

    await client.close();
  }, 15_000);

  it("allows all tools when MCP_ALLOWED_TOOLS is not set", async () => {
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: "node",
      args: ["dist/index.js", "node", MOCK_SERVER_PATH],
      env: {
        ...process.env,
        MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio",
      },
    });

    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(3);

    await client.close();
  }, 15_000);

  it("forwards environment variables to the spawned server", async () => {
    // Use a mock server that reads an env var and exposes it as a tool name
    const envServerPath = resolve("tests/_mock_env_server.mjs");
    const envServerCode = `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "env-mock", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: process.env.TEST_TOOL_NAME || "fallback", description: "env test", inputSchema: { type: "object" } },
  ],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
`;
    writeFileSync(envServerPath, envServerCode);

    try {
      const client = new Client({ name: "test-client", version: "1.0.0" });
      const transport = new StdioClientTransport({
        command: "node",
        args: ["dist/index.js", "node", envServerPath],
        env: {
          ...process.env,
          MCP_FILTER_PROXY_UPSTREAM_TRANSPORT: "stdio",
          TEST_TOOL_NAME: "env_forwarded_tool",
        },
      });

      await client.connect(transport);

      const { tools } = await client.listTools();
      expect(tools[0].name).toBe("env_forwarded_tool");

      await client.close();
    } finally {
      try { unlinkSync(envServerPath); } catch {}
    }
  }, 15_000);
});
```

- **Step 2: Build the project first (integration tests use compiled dist/)**

```bash
pnpm build
```

- **Step 3: Run the integration tests**

```bash
pnpm test
```

Expected: All tests PASS. The proxy filters tools, blocks disallowed calls, and forwards env vars.

- **Step 4: Commit**

```bash
git add tests/proxy.test.ts
git commit -m "test: add integration tests for proxy filtering and env forwarding"
```

---

## Task 9: Final Polish

**Files:**

- Modify: `package.json` (add `bin` field)
- **Step 1: Add bin entry to package.json**

Add to `package.json`:

```json
{
  "bin": {
    "mcp-filter-proxy": "dist/index.js"
  }
}
```

- **Step 2: Build and run full test suite**

```bash
pnpm build && pnpm test
```

Expected: All tests PASS.

- **Step 3: Manual smoke test with a real MCP server**

```bash
# stdio → stdio with filtering:
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | MCP_FILTER_PROXY_UPSTREAM_TRANSPORT=stdio MCP_FILTER_PROXY_ALLOWED_TOOLS=read_file node dist/index.js npx another-mcp-server /tmp
```

Verify it starts and responds to the initialize handshake.

- **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: add bin entry for CLI usage"
```

---

## Notes

- **Env forwarding:** All spawned child processes receive a cleaned copy of `process.env` with all `MCP_FILTER_PROXY_`* vars stripped (via `stripProxyEnv()` in both `upstream-stdio.ts` and `index.ts`). This ensures that env vars set by the AI tool's MCP configuration (API keys, paths, etc.) reach the wrapped server, but the proxy's own configuration does not leak through.
- **Transport bridging:** The proxy can connect to upstream via any of 3 transports and expose downstream via stdio or HTTP, enabling any combination (6 possible bridges). SSE is supported as an upstream transport for backwards compatibility but not as an expose transport since it is deprecated.
- **Stateless HTTP expose:** When exposing over HTTP, each incoming request gets its own `Server` instance (stateless mode), but they all share a single upstream `Client`. This keeps the design simple without session management.
- **Resources and prompts** are proxied through without filtering. The same `filter.ts` pattern can be extended if resource/prompt filtering is needed later.
- The `waitForServer` function in `index.ts` only applies when spawning a local HTTP/SSE server process. For remote servers it connects directly.
- Some SDK import paths or types may need minor adjustment depending on the exact package versions installed. The compilation step in each task will catch these.

