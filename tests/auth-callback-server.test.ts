import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createCallbackServer,
  type CallbackServer,
} from "../src/auth/callback-server.js";

// Use a high, unlikely-to-collide port per test to avoid races.
let nextPort = 18900;
const port = () => nextPort++;

async function withServer(
  opts: { port: number; expectedState: string; timeoutMs?: number },
  fn: (server: CallbackServer) => Promise<void>,
): Promise<void> {
  const server = createCallbackServer(opts);
  await server.listen({ cycle: false });
  try {
    await fn(server);
  } finally {
    server.close();
  }
}

/** Bind a throwaway listener so the port is occupied, returning its port and a closer. */
async function occupy(p: number): Promise<{ port: number; close: () => void }> {
  const srv = createServer((_req, res) => res.end());
  await new Promise<void>((resolve) => srv.listen(p, "127.0.0.1", resolve));
  return {
    port: (srv.address() as AddressInfo).port,
    close: () => srv.close(),
  };
}

describe("createCallbackServer", () => {
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

  it("exposes redirectUrl without binding until listen() is called", async () => {
    const p = port();
    const server = createCallbackServer({ port: p, expectedState: "s5" });
    expect(server.redirectUrl).toBe(`http://127.0.0.1:${p}/oauth/callback`);
    // Nothing is bound yet, so the port is free for another listener to claim.
    const other = await occupy(p);
    expect(other.port).toBe(p);
    other.close();
    // close() before listen() is a safe no-op.
    expect(() => server.close()).not.toThrow();
  });

  it("cycles to the next free port when the configured one is busy", async () => {
    const p = port();
    const busy = await occupy(p);
    try {
      const server = createCallbackServer({ port: p, expectedState: "s6" });
      await server.listen({ cycle: true });
      try {
        expect(server.redirectUrl).toBe(`http://127.0.0.1:${p + 1}/oauth/callback`);
        const res = await fetch(`${server.redirectUrl}?code=cycled&state=s6`);
        expect(res.status).toBe(200);
        expect(await server.waitForCode()).toBe("cycled");
      } finally {
        server.close();
      }
    } finally {
      busy.close();
    }
  });

  it("fails with a hint on a busy port when cycling is disabled", async () => {
    const p = port();
    const busy = await occupy(p);
    try {
      const server = createCallbackServer({ port: p, expectedState: "s7" });
      await expect(server.listen({ cycle: false })).rejects.toThrow(
        /MCP_FILTER_PROXY_OAUTH_CALLBACK_PORT/,
      );
    } finally {
      busy.close();
    }
  });
});
