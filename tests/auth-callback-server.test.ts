import { describe, it, expect } from "vitest";
import { startCallbackServer, type CallbackServer } from "../src/auth/callback-server.js";

// Use a high, unlikely-to-collide port per test to avoid races.
let nextPort = 18900;
const port = () => nextPort++;

async function withServer(
  opts: { port: number; expectedState: string; timeoutMs?: number },
  fn: (server: CallbackServer) => Promise<void>,
): Promise<void> {
  const server = await startCallbackServer(opts);
  try {
    await fn(server);
  } finally {
    server.close();
  }
}

describe("startCallbackServer", () => {
  it("resolves waitForCode with the authorization code", async () => {
    const p = port();
    await withServer({ port: p, expectedState: "s1" }, async (server) => {
      expect(server.redirectUrl).toBe(`http://127.0.0.1:${p}/oauth/callback`);
      const res = await fetch(`${server.redirectUrl}?code=the-code&state=s1`);
      expect(res.status).toBe(200);
      expect(await server.waitForCode()).toBe("the-code");
    });
  });

  it("captures a redirect that arrives before waitForCode is awaited", async () => {
    const p = port();
    await withServer({ port: p, expectedState: "s2" }, async (server) => {
      await fetch(`${server.redirectUrl}?code=early&state=s2`);
      // Only now do we await — the code must not have been lost.
      expect(await server.waitForCode()).toBe("early");
    });
  });

  it("rejects on state mismatch", async () => {
    const p = port();
    await withServer({ port: p, expectedState: "right" }, async (server) => {
      const res = await fetch(`${server.redirectUrl}?code=x&state=wrong`);
      expect(res.status).toBe(400);
      await expect(server.waitForCode()).rejects.toThrow(/state mismatch/i);
    });
  });

  it("rejects when the provider returns an error", async () => {
    const p = port();
    await withServer({ port: p, expectedState: "s3" }, async (server) => {
      const res = await fetch(
        `${server.redirectUrl}?error=access_denied&error_description=nope&state=s3`,
      );
      expect(res.status).toBe(400);
      await expect(server.waitForCode()).rejects.toThrow(/access_denied/);
    });
  });

  it("rejects on timeout", async () => {
    const p = port();
    await withServer({ port: p, expectedState: "s4", timeoutMs: 50 }, async (server) => {
      await expect(server.waitForCode()).rejects.toThrow(/Timed out/);
    });
  });
});
