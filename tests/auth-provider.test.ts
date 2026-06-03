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
    overrides: { openedUrls?: string[]; scope?: string | null } = {},
  ) =>
    new ProxyOAuthClientProvider({
      store,
      redirectUrl: "http://127.0.0.1:8909/oauth/callback",
      state: "state-xyz",
      clientName: "Test Proxy",
      scope: overrides.scope ?? null,
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
    expect(meta.scope).toBeUndefined();
  });

  it("includes scope in client metadata when configured", () => {
    expect(makeProvider({ scope: "read:jira" }).clientMetadata.scope).toBe("read:jira");
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
});
