import type { ProxyConfig } from "../config";
import type { UpstreamAuth } from "../auth";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

export function buildUpstreamOptions({
  auth,
  config,
}: {
  auth: UpstreamAuth;
  config: ProxyConfig;
}) {
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
  return Object.keys(transportOptions).length > 0 ? transportOptions : undefined;
}
