import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FileAuthStore } from "./store.js";
import type { OpenBrowser } from "./browser.js";

export interface OAuthProviderOptions {
  store: FileAuthStore;
  /** redirect_uri served by the loopback callback server. */
  redirectUrl: string;
  /** CSRF state shared with the callback server. */
  state: string;
  openBrowser: OpenBrowser;
  clientName: string;
  /** OAuth scope to request as the fallback when the server advertises none. */
  scope: string;
  /** RFC 8707 resource/audience to bind the token to, or null to omit it. */
  resource?: string | null;
  /** Invoked just before the browser is opened, to bind the loopback callback server lazily when an
   * interactive sign-in is actually starting. */
  onBeforeRedirect?: () => Promise<void>;
}

/**
 * Interactive `OAuthClientProvider` for upstream connections. Performs the standard MCP OAuth
 * dance (RFC 9728 discovery + dynamic client registration + authorization_code/PKCE), opening a
 * browser for the user and persisting everything to disk via {@link FileAuthStore} so later runs
 * reuse the cached token (and refresh it transparently) without prompting again.
 */
export class ProxyOAuthClientProvider implements OAuthClientProvider {
  constructor(private readonly opts: OAuthProviderOptions) {}

  get redirectUrl(): string {
    return this.opts.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.opts.clientName,
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: this.opts.scope,
    };
  }

  /**
   * Choose the RFC 8707 `resource` to send on the authorize/token requests. A configured resource
   * wins; otherwise we honor the one advertised by the server's Protected Resource Metadata; if
   * neither exists we return undefined so the parameter is omitted (the SDK's default, which avoids
   * upsetting servers that don't expect it).
   */
  async validateResourceURL(
    _serverUrl: string | URL,
    resourceFromMetadata?: string,
  ): Promise<URL | undefined> {
    if (this.opts.resource) return new URL(this.opts.resource);
    if (resourceFromMetadata) return new URL(resourceFromMetadata);
    return undefined;
  }

  state(): string {
    return this.opts.state;
  }

  clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    return this.opts.store.clientInformation();
  }

  saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    return this.opts.store.saveClientInformation(info);
  }

  tokens(): Promise<OAuthTokens | undefined> {
    return this.opts.store.tokens();
  }

  saveTokens(tokens: OAuthTokens): Promise<void> {
    return this.opts.store.saveTokens(tokens);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.opts.onBeforeRedirect?.();
    await this.opts.openBrowser(authorizationUrl.toString());
  }

  saveCodeVerifier(verifier: string): Promise<void> {
    return this.opts.store.saveCodeVerifier(verifier);
  }

  async codeVerifier(): Promise<string> {
    const verifier = await this.opts.store.codeVerifier();
    if (!verifier) {
      throw new Error(
        "Missing PKCE code verifier; the OAuth flow was not started correctly",
      );
    }
    return verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    return this.opts.store.saveDiscoveryState(state);
  }

  discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.opts.store.discoveryState();
  }

  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    return this.opts.store.invalidate(scope);
  }
}
