import { randomUUID } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { ProxyConfig } from "../config.js";
import { FileAuthStore } from "./store.js";
import { startCallbackServer } from "./callback-server.js";
import { openInBrowser, type OpenBrowser } from "./browser.js";
import { ProxyOAuthClientProvider } from "./oauth-provider.js";

/**
 * Runtime handle for an in-progress interactive OAuth flow: it lets the connect logic wait for
 * the browser redirect to deliver the authorization `code`, and tear down the callback server.
 */
export interface OAuthRuntime {
  waitForCode(): Promise<string>;
  close(): void;
}

export type UpstreamAuth =
  | { kind: "none" }
  | { kind: "static"; requestInit: RequestInit }
  | { kind: "oauth"; authProvider: OAuthClientProvider; runtime: OAuthRuntime };

/**
 * Resolves which authentication strategy to use for an http/sse upstream and wires it up.
 */
export async function buildUpstreamAuth(
  config: ProxyConfig,
  openBrowser: OpenBrowser = openInBrowser,
): Promise<UpstreamAuth> {
  const { auth } = config;
  if (config.transport === "stdio") return { kind: "none" };

  if (auth.token) {
    const scheme = auth.tokenScheme === "basic" ? "Basic" : "Bearer";
    console.error(`Using static ${scheme} credential for upstream authentication`);
    return {
      kind: "static",
      requestInit: {
        headers: { Authorization: `${scheme} ${auth.token}` },
      },
    };
  }

  if (auth.mode === "none") return { kind: "none" };

  const store = new FileAuthStore(config.url!, auth.storeDir);
  const state = randomUUID();
  const callback = await startCallbackServer({
    port: auth.callbackPort,
    expectedState: state,
  });

  const authProvider = new ProxyOAuthClientProvider({
    store,
    redirectUrl: callback.redirectUrl,
    state,
    openBrowser,
    clientName: auth.clientName,
    scope: auth.scope,
  });

  return {
    kind: "oauth",
    authProvider,
    runtime: {
      waitForCode: () => callback.waitForCode(),
      close: () => callback.close(),
    },
  };
}
