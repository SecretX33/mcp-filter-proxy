import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAuthStore } from "../src/auth/store.js";

describe("FileAuthStore", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "mcp-auth-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("returns undefined for everything when nothing is saved", async () => {
    const store = new FileAuthStore("https://example.com/mcp", baseDir);
    expect(await store.tokens()).toBeUndefined();
    expect(await store.clientInformation()).toBeUndefined();
    expect(await store.codeVerifier()).toBeUndefined();
    expect(await store.discoveryState()).toBeUndefined();
  });

  it("round-trips tokens, client info, verifier, and discovery state", async () => {
    const store = new FileAuthStore("https://example.com/mcp", baseDir);

    await store.saveTokens({
      access_token: "a",
      token_type: "Bearer",
      refresh_token: "r",
    });
    await store.saveClientInformation({
      client_id: "cid",
      redirect_uris: ["http://127.0.0.1:8909/oauth/callback"],
    });
    await store.saveCodeVerifier("verifier-123");
    await store.saveDiscoveryState({
      authorizationServerUrl: "https://auth.example.com",
    });

    expect(await store.tokens()).toMatchObject({ access_token: "a", refresh_token: "r" });
    expect(await store.clientInformation()).toMatchObject({ client_id: "cid" });
    expect(await store.codeVerifier()).toBe("verifier-123");
    expect(await store.discoveryState()).toMatchObject({
      authorizationServerUrl: "https://auth.example.com",
    });
  });

  it("isolates state per server URL", async () => {
    const a = new FileAuthStore("https://a.example.com/mcp", baseDir);
    const b = new FileAuthStore("https://b.example.com/mcp", baseDir);

    await a.saveTokens({ access_token: "token-a", token_type: "Bearer" });

    expect(await a.tokens()).toMatchObject({ access_token: "token-a" });
    expect(await b.tokens()).toBeUndefined();
  });

  it("persists across store instances for the same URL", async () => {
    const url = "https://example.com/mcp";
    await new FileAuthStore(url, baseDir).saveTokens({
      access_token: "persisted",
      token_type: "Bearer",
    });

    const reopened = new FileAuthStore(url, baseDir);
    expect(await reopened.tokens()).toMatchObject({ access_token: "persisted" });
  });

  it("invalidate('tokens') removes only tokens", async () => {
    const store = new FileAuthStore("https://example.com/mcp", baseDir);
    await store.saveTokens({ access_token: "a", token_type: "Bearer" });
    await store.saveClientInformation({ client_id: "cid", redirect_uris: ["http://x"] });

    await store.invalidate("tokens");

    expect(await store.tokens()).toBeUndefined();
    expect(await store.clientInformation()).toMatchObject({ client_id: "cid" });
  });

  it("invalidate('all') clears every cached file", async () => {
    const store = new FileAuthStore("https://example.com/mcp", baseDir);
    await store.saveTokens({ access_token: "a", token_type: "Bearer" });
    await store.saveClientInformation({ client_id: "cid", redirect_uris: ["http://x"] });
    await store.saveCodeVerifier("v");

    await store.invalidate("all");

    expect(await store.tokens()).toBeUndefined();
    expect(await store.clientInformation()).toBeUndefined();
    expect(await store.codeVerifier()).toBeUndefined();
  });
});
