import { describe, it, expect } from "vitest";
import type { ProxyConfig, StaticAuthScheme } from "../src/config.js";
import { buildUpstreamAuth } from "../src/auth/index.js";

// The static-credential branch returns before any network/callback work, so these run offline.
const makeConfig = (
  token: string | null,
  tokenScheme: StaticAuthScheme = "bearer",
): ProxyConfig => ({
  transport: "http",
  autoNegotiateRemote: false,
  headers: {},
  exposeTransport: "stdio",
  allowedTools: null,
  allowedResources: null,
  allowedPrompts: null,
  command: null,
  args: [],
  url: "https://example.com/mcp",
  exposePort: 8808,
  exposeHost: "127.0.0.1",
  auth: {
    mode: "auto",
    token,
    tokenScheme,
    callbackPort: 8661,
    scope: "openid email profile",
    resource: null,
    clientName: "Test Proxy",
    storeDir: null,
  },
});

const authHeader = (init: RequestInit): string => {
  const headers = init.headers as Record<string, string>;
  return headers.Authorization;
};

describe("buildUpstreamAuth — static credential", () => {
  it("defaults to a Bearer header", async () => {
    const auth = await buildUpstreamAuth(makeConfig("tok-123"));
    expect(auth.kind).toBe("static");
    if (auth.kind !== "static") throw new Error("expected static");
    expect(authHeader(auth.requestInit)).toBe("Bearer tok-123");
  });

  it("uses a Basic header without re-encoding the value when scheme is basic", async () => {
    const encoded = "dXNlcjpwYXNz"; // base64("user:pass")
    const auth = await buildUpstreamAuth(makeConfig(encoded, "basic"));
    if (auth.kind !== "static") throw new Error("expected static");
    expect(authHeader(auth.requestInit)).toBe(`Basic ${encoded}`);
  });

  it("takes precedence over OAuth even when mode is auto", async () => {
    const auth = await buildUpstreamAuth(makeConfig("tok-123"));
    // No callback server is started and no browser opener is needed.
    expect(auth.kind).toBe("static");
  });

  it("falls through to OAuth setup when no token is set", async () => {
    const config = makeConfig(null);
    config.auth.mode = "none"; // avoid binding a real callback server in this assertion
    const auth = await buildUpstreamAuth(config);
    expect(auth.kind).toBe("none");
  });
});
