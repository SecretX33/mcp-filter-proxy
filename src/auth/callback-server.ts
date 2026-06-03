import { createServer, type Server } from "node:http";

const CALLBACK_PATH = "/oauth/callback";
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const CALLBACK_HOST = "127.0.0.1"; // RFC 8252: use the loopback IP literal, not "localhost"

export interface CallbackServer {
  /** The redirect_uri the authorization server should send the user back to. */
  readonly redirectUrl: string;
  /** Resolves with the authorization `code` once the browser hits the callback. */
  waitForCode(): Promise<string>;
  /** Stop listening. Safe to call multiple times. */
  close(): void;
}

const html = (message: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>mcp-filter-proxy</title></head>` +
  `<body style="font-family:system-ui;padding:2rem"><h2>${message}</h2>` +
  `<p>You can close this window and return to your application.</p></body></html>`;

/**
 * Starts a loopback HTTP server that captures the OAuth redirect. The capture promise is
 * created up front, so a redirect that arrives before `waitForCode()` is awaited is not lost.
 * The expected `state` is validated to guard against CSRF / stray requests.
 */
export function startCallbackServer(options: {
  port: number;
  expectedState: string;
  timeoutMs?: number;
}): Promise<CallbackServer> {
  const { port, expectedState, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  let settled = false;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // The promise can settle (e.g. on a stray/invalid callback) before a caller awaits
  // waitForCode(). Attach a no-op handler so that early rejection is never "unhandled";
  // real consumers still observe it through the returned promise reference.
  void codePromise.catch(() => {});

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${CALLBACK_HOST}:${port}`);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }

    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (error) {
      const desc = url.searchParams.get("error_description") ?? "";
      res
        .writeHead(400, { "content-type": "text/html" })
        .end(html("Authorization failed."));
      fail(new Error(`Authorization error: ${error}${desc ? ` (${desc})` : ""}`));
      return;
    }
    if (state !== expectedState) {
      res.writeHead(400, { "content-type": "text/html" }).end(html("Invalid state."));
      fail(new Error("OAuth state mismatch on callback (possible CSRF)"));
      return;
    }
    if (!code) {
      res.writeHead(400, { "content-type": "text/html" }).end(html("Missing code."));
      fail(new Error("OAuth callback did not include an authorization code"));
      return;
    }

    res
      .writeHead(200, { "content-type": "text/html" })
      .end(html("Authorization complete."));
    if (!settled) {
      settled = true;
      resolveCode(code);
    }
  });

  const timer = setTimeout(() => {
    fail(new Error(`Timed out waiting for OAuth authorization after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();

  function fail(err: Error): void {
    if (settled) return;
    settled = true;
    rejectCode(err);
  }

  const close = () => {
    clearTimeout(timer);
    server.close();
  };

  return new Promise<CallbackServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, CALLBACK_HOST, () => {
      server.removeListener("error", reject);
      console.error(
        `OAuth callback server listening on http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}`,
      );
      resolve({
        redirectUrl: `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}`,
        waitForCode: () => codePromise,
        close,
      });
    });
  });
}
