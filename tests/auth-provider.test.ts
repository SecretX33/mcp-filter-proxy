import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAuthStore } from "../src/auth/store.js";
import { ProxyOAuthClientProvider } from "../src/auth/oauth-provider.js";

describe("ProxyOAuthClientProvider", () => {
  let baseDir: string;
  let store: FileAuthStore;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "mcp-auth-"));
    store = new FileAuthStore("https://example.com/mcp", baseDir);
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  const makeProvider = (
    overrides: { openedUrls?: string[]; scope?: string; resource?: string | null } = {},
  ) =>
    new ProxyOAuthClientProvider({
      store,
      redirectUrl: "http://127.0.0.1:8909/oauth/callback",
      state: "state-xyz",
      clientName: "Test Proxy",
      scope: overrides.scope ?? "openid email profile",
      resource: overrides.resource ?? null,
      openBrowser: async (url) => {
        overrides.openedUrls?.push(url);
      },
    });

  it("advertises the loopback redirect_uri and PKCE-friendly client metadata", () => {
    const meta = makeProvider().clientMetadata;
    expect(meta.redirect_uris).toEqual(["http://127.0.0.1:8909/oauth/callback"]);
    expect(meta.grant_types).toContain("authorization_code");
    expect(meta.grant_types).toContain("refresh_token");
    expect(meta.response_types).toEqual(["code"]);
    expect(meta.token_endpoint_auth_method).toBe("none");
    expect(meta.client_name).toBe("Test Proxy");
    expect(meta.scope).toBe("openid email profile");
  });

  it("includes the configured scope in client metadata", () => {
    expect(makeProvider({ scope: "read:jira" }).clientMetadata.scope).toBe("read:jira");
  });

  it("sends the configured resource as the OAuth audience", async () => {
    const provider = makeProvider({ resource: "https://mcp.example.com/v1/mcp" });
    const resolved = await provider.validateResourceURL("https://mcp.example.com/v1/mcp");
    expect(resolved?.toString()).toBe("https://mcp.example.com/v1/mcp");
  });

  it("falls back to the server-advertised resource, and omits it when neither is set", async () => {
    const provider = makeProvider();
    expect(
      (
        await provider.validateResourceURL("https://srv/mcp", "https://srv/resource")
      )?.toString(),
    ).toBe("https://srv/resource");
    expect(await provider.validateResourceURL("https://srv/mcp")).toBeUndefined();
  });

  it("exposes redirectUrl and state", () => {
    const provider = makeProvider();
    expect(provider.redirectUrl).toBe("http://127.0.0.1:8909/oauth/callback");
    expect(provider.state()).toBe("state-xyz");
  });

  it("opens the browser on redirectToAuthorization", async () => {
    const openedUrls: string[] = [];
    const provider = makeProvider({ openedUrls });
    await provider.redirectToAuthorization(
      new URL("https://auth.example.com/authorize?x=1"),
    );
    expect(openedUrls).toEqual(["https://auth.example.com/authorize?x=1"]);
  });

  it("runs onBeforeRedirect before opening the browser", async () => {
    const events: string[] = [];
    const provider = new ProxyOAuthClientProvider({
      store,
      redirectUrl: "http://127.0.0.1:8909/oauth/callback",
      state: "s",
      clientName: "Test Proxy",
      scope: "openid email profile",
      resource: null,
      onBeforeRedirect: async () => {
        events.push("before");
      },
      openBrowser: async () => {
        events.push("open");
      },
    });
    await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
    expect(events).toEqual(["before", "open"]);
  });

  it("persists tokens and client information through the store", async () => {
    const provider = makeProvider();
    await provider.saveTokens({ access_token: "tok", token_type: "Bearer" });
    await provider.saveClientInformation({
      client_id: "cid",
      redirect_uris: ["http://x"],
    });

    expect(await provider.tokens()).toMatchObject({ access_token: "tok" });
    expect(await provider.clientInformation()).toMatchObject({ client_id: "cid" });
    // Visible to a fresh provider backed by the same store directory.
    expect(await makeProvider().tokens()).toMatchObject({ access_token: "tok" });
  });

  it("round-trips the PKCE code verifier and throws if it is missing", async () => {
    const provider = makeProvider();
    await expect(provider.codeVerifier()).rejects.toThrow(/code verifier/i);
    await provider.saveCodeVerifier("verifier-abc");
    expect(await provider.codeVerifier()).toBe("verifier-abc");
  });

  it("isolates per-flow state in memory so a shared-store write can't corrupt another flow", async () => {
    const a = makeProvider();
    const b = makeProvider(); // same on-disk store, separate memory (mimics a second process)
    await a.saveCodeVerifier("verifier-a");
    await a.saveClientInformation({ client_id: "client-a", redirect_uris: ["http://a"] });
    await a.saveTokens({ access_token: "token-a", token_type: "Bearer" });

    // b runs its own flow against the same store, overwriting every file.
    await b.saveCodeVerifier("verifier-b");
    await b.saveClientInformation({ client_id: "client-b", redirect_uris: ["http://b"] });
    await b.saveTokens({ access_token: "token-b", token_type: "Bearer" });

    expect(await a.codeVerifier()).toBe("verifier-a");
    expect((await a.clientInformation())?.client_id).toBe("client-a");
    expect((await a.tokens())?.access_token).toBe("token-a");

    expect(await b.codeVerifier()).toBe("verifier-b");
    expect((await b.clientInformation())?.client_id).toBe("client-b");
    expect((await b.tokens())?.access_token).toBe("token-b");
  });

  it("clears cached memory on invalidateCredentials so a later store value is read", async () => {
    const provider = makeProvider();
    await provider.saveTokens({ access_token: "old", token_type: "Bearer" });
    expect((await provider.tokens())?.access_token).toBe("old"); // served from memory

    await provider.invalidateCredentials("tokens"); // clears memory and removes the file
    await store.saveTokens({ access_token: "new", token_type: "Bearer" }); // a fresh write lands

    expect((await provider.tokens())?.access_token).toBe("new"); // memory cleared, disk re-read
  });

  it("ignores a persisted registration whose redirect_uri does not match the bound port", async () => {
    await store.saveClientInformation({
      client_id: "stale",
      redirect_uris: ["http://127.0.0.1:1234/oauth/callback"],
    });
    // makeProvider's redirectUrl is http://127.0.0.1:8909/oauth/callback — no match.
    expect(await makeProvider().clientInformation()).toBeUndefined();
  });

  it("reuses a persisted registration whose redirect_uri matches the bound port", async () => {
    await store.saveClientInformation({
      client_id: "match",
      redirect_uris: ["http://127.0.0.1:8909/oauth/callback"],
    });
    expect((await makeProvider().clientInformation())?.client_id).toBe("match");
  });
});
