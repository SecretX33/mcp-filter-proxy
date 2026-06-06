import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ProxyConfig } from "../src/config.js";
import { buildUpstreamAuth } from "../src/auth/index.js";
import { connectUpstream } from "../src/proxy.js";
import { createHTTPUpstream } from "../src/transports/upstream-http.js";

const s256 = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

interface MockServer {
  base: string;
  close: () => Promise<void>;
  stats: {
    authorizeHits: number;
    tokenRefreshHits: number;
    expireAccessTokens: () => void;
  };
}

/** A minimal but spec-shaped OAuth-protected MCP server (RFC 9728 + DCR + PKCE). */
async function startMockServer(): Promise<MockServer> {
  const app = express();

  const validAccess = new Set<string>();
  const validRefresh = new Set<string>();
  const codeChallenges = new Map<string, string>();
  const stats = { authorizeHits: 0, tokenRefreshHits: 0 };
  let base = "";

  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({ resource: `${base}/mcp`, authorization_servers: [base] });
  });

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  });

  app.post("/register", express.json(), (req, res) => {
    res.status(201).json({
      client_id: `client-${randomUUID()}`,
      redirect_uris: req.body.redirect_uris ?? [],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  app.get("/authorize", (req, res) => {
    stats.authorizeHits++;
    const redirectUri = String(req.query.redirect_uri);
    const code = randomUUID();
    codeChallenges.set(code, String(req.query.code_challenge));
    const location = new URL(redirectUri);
    location.searchParams.set("code", code);
    if (req.query.state) location.searchParams.set("state", String(req.query.state));
    res.redirect(302, location.toString());
  });

  app.post("/token", express.urlencoded({ extended: false }), (req, res) => {
    const grant = req.body.grant_type;
    if (grant === "authorization_code") {
      const challenge = codeChallenges.get(req.body.code);
      if (!challenge || s256(req.body.code_verifier) !== challenge) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      codeChallenges.delete(req.body.code);
      const access = randomUUID();
      const refresh = randomUUID();
      validAccess.add(access);
      validRefresh.add(refresh);
      res.json({
        access_token: access,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: refresh,
        scope: "mcp",
      });
      return;
    }
    if (grant === "refresh_token") {
      stats.tokenRefreshHits++;
      if (!validRefresh.has(req.body.refresh_token)) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      const access = randomUUID();
      validAccess.add(access);
      res.json({
        access_token: access,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: req.body.refresh_token,
        scope: "mcp",
      });
      return;
    }
    res.status(400).json({ error: "unsupported_grant_type" });
  });

  const makeMcpServer = (): Server => {
    const server = new Server(
      { name: "mock-upstream", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    return server;
  };

  app.post("/mcp", express.json(), async (req, res) => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token || !validAccess.has(token)) {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource"`,
      );
      res.status(401).json({
        error: "invalid_token",
        error_description: "Missing or invalid access token",
      });
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server = makeMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.all("/mcp", (_req, res) => res.status(405).json({ error: "Method not allowed" }));

  const httpServer = await new Promise<import("node:http").Server>((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
  });
  const { port } = httpServer.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;

  return {
    base,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
    stats: {
      get authorizeHits() {
        return stats.authorizeHits;
      },
      get tokenRefreshHits() {
        return stats.tokenRefreshHits;
      },
      expireAccessTokens: () => validAccess.clear(),
    },
  };
}

describe("interactive upstream OAuth flow", () => {
  let mock: MockServer;
  let storeDir: string;
  let callbackPort: number;

  beforeEach(async () => {
    mock = await startMockServer();
    storeDir = mkdtempSync(join(tmpdir(), "mcp-oauth-flow-"));
    callbackPort = 19000 + Math.floor((Date.now() % 1000) + Math.random() * 4000);
  });

  afterEach(async () => {
    await mock.close();
    rmSync(storeDir, { recursive: true, force: true });
  });

  const makeConfig = (): ProxyConfig => ({
    transport: "http",
    autoNegotiateRemote: false,
    headers: {},
    exposeTransport: "stdio",
    filters: {
      tools: { allowed: null, denied: null },
      resources: { allowed: null, denied: null },
      prompts: { allowed: null, denied: null },
    },
    command: null,
    args: [],
    url: `${mock.base}/mcp`,
    exposePort: 8808,
    exposeHost: "127.0.0.1",
    auth: {
      mode: "auto",
      token: null,
      tokenScheme: "bearer",
      callbackPort,
      scope: "openid email profile",
      resource: null,
      clientName: "Test Proxy",
      storeDir: storeDir,
    },
  });

  // A fake browser: following the authorize redirect lands on the loopback callback,
  // which captures the authorization code — exactly what a real browser would cause.
  const makeOpener = () => {
    const calls: string[] = [];
    const open = async (url: string) => {
      calls.push(url);
      await fetch(url);
    };
    return { open, calls };
  };

  const connect = async (openBrowser: (url: string) => Promise<void>) => {
    const auth = await buildUpstreamAuth(makeConfig(), openBrowser);
    if (auth.kind !== "oauth") throw new Error(`expected oauth, got ${auth.kind}`);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await connectUpstream(
      client,
      () =>
        createHTTPUpstream({
          url: `${mock.base}/mcp`,
          options: { authProvider: auth.authProvider },
        }),
      { transport: "http", autoNegotiateRemote: false, oauth: auth.runtime },
    );
    return client;
  };

  it("authenticates via the browser and connects, then lists upstream tools", async () => {
    const opener = makeOpener();
    const client = await connect(opener.open);

    expect(opener.calls).toHaveLength(1);
    expect(opener.calls[0]).toContain("/authorize");
    expect(mock.stats.authorizeHits).toBe(1);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("ping");
    await client.close();
  });

  it("reuses cached tokens on a second run without opening the browser", async () => {
    await (await connect(makeOpener().open)).close();
    const authorizeAfterFirst = mock.stats.authorizeHits;

    const opener = makeOpener();
    const client = await connect(opener.open);

    expect(opener.calls).toHaveLength(0);
    expect(mock.stats.authorizeHits).toBe(authorizeAfterFirst);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("ping");
    await client.close();
  });

  it("refreshes an expired access token without re-authorizing", async () => {
    await (await connect(makeOpener().open)).close();
    const authorizeAfterFirst = mock.stats.authorizeHits;

    // Simulate the access token expiring; the refresh token is still valid.
    mock.stats.expireAccessTokens();

    const opener = makeOpener();
    const client = await connect(opener.open);

    expect(opener.calls).toHaveLength(0);
    expect(mock.stats.tokenRefreshHits).toBeGreaterThanOrEqual(1);
    expect(mock.stats.authorizeHits).toBe(authorizeAfterFirst);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("ping");
    await client.close();
  });
});
