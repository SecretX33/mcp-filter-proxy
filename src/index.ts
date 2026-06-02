#!/usr/bin/env node
import { spawn } from "child_process";
import { loadConfigOrExit, stripProxyEnv } from "./config.js";
import { createToolFilter } from "./filter.js";
import { createStdioUpstream } from "./transports/upstream-stdio.js";
import { createSSEUpstream } from "./transports/upstream-sse.js";
import { createHTTPUpstream } from "./transports/upstream-http.js";
import { startProxy } from "./proxy.js";
import { PROJECT_INFO } from "./util";

async function main(): Promise<void> {
  console.error(`Starting mcp-filter-proxy version ${PROJECT_INFO.version}...`);

  const config = loadConfigOrExit(process.argv);
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
    default:
      throw new Error(`Invalid transport: ${config.transport as never}`);
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
  console.error(err ?? "Unknown error");
  process.exit(1);
});
