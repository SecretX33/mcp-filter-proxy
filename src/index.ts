#!/usr/bin/env node
import { spawn } from "child_process";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { loadConfigOrExit, stripProxyEnv, type UpstreamTransport } from "./config.js";
import { createAllowFilter, type ProxyFilters } from "./filter.js";
import { createStdioUpstream } from "./transports/upstream-stdio.js";
import { createSSEUpstream } from "./transports/upstream-sse.js";
import { createHTTPUpstream } from "./transports/upstream-http.js";
import { buildUpstreamAuth } from "./auth";
import { startProxy } from "./proxy.js";
import { PROJECT_INFO } from "./util";

async function main(): Promise<void> {
  console.error(`Starting mcp-filter-proxy version ${PROJECT_INFO.version}...`);

  const config = loadConfigOrExit(process.argv);
  const filters: ProxyFilters = {
    tools: createAllowFilter(config.allowedTools),
    resources: createAllowFilter(config.allowedResources),
    prompts: createAllowFilter(config.allowedPrompts),
  };

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

  // Resolve upstream auth (static bearer, interactive OAuth, or none) for sse/http upstreams.
  const auth = await buildUpstreamAuth(config);

  // Headers sent to an http/sse upstream: the user-configured ones, plus a static Authorization
  // header when a static credential is used (the credential wins on collision).
  const staticAuthHeaders =
    auth.kind === "static" ? (auth.requestInit.headers as Record<string, string>) : {};
  const headers: Record<string, string> = { ...config.headers, ...staticAuthHeaders };

  const transportOptions: {
    authProvider?: OAuthClientProvider;
    requestInit?: RequestInit;
  } = {
    ...(auth.kind === "oauth" ? { authProvider: auth.authProvider } : {}),
    ...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
  };
  const upstreamOptions =
    Object.keys(transportOptions).length > 0 ? transportOptions : undefined;

  // Build the upstream transport on demand. The factory is reused to reconnect with a fresh
  // transport after an interactive OAuth flow completes or when probing http→sse.
  const makeUpstreamTransport = (kind: UpstreamTransport): Transport => {
    switch (kind) {
      case "stdio":
        return createStdioUpstream({ command: config.command!, args: config.args });
      case "sse":
        return createSSEUpstream({ url: config.url!, options: upstreamOptions });
      case "http":
        return createHTTPUpstream({ url: config.url!, options: upstreamOptions });
      default:
        throw new Error(`Invalid transport: ${kind as never}`);
    }
  };

  await startProxy({
    makeUpstreamTransport,
    transport: config.transport,
    autoNegotiateRemote: config.autoNegotiateRemote,
    oauth: auth.kind === "oauth" ? auth.runtime : undefined,
    filters,
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
