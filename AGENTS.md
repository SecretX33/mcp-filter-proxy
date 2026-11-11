# AGENTS.md

## What this is

A generic MCP proxy (published as `mcp-filter-proxy`) that wraps any MCP server, filters which tools, resources, and prompts are exposed to clients via per-kind allowlists, and can bridge between transport types (e.g. wrap a stdio server and expose it over HTTP, or the reverse). For each kind, the `*/list` response is filtered and the corresponding access (`tools/call`, `resources/read`, `prompts/get`) rejects disallowed items. Resources are filtered by name; since `resources/read` carries a uri, a cached uri↔name map (`src/resource-resolver.ts`) resolves it. Everything else passes through unfiltered.

## Commands

The package manager is **pnpm**. Node 24 is used in CI.

- `pnpm build` — bundle to `dist/` with tsdown
- `pnpm dev` — build in watch mode
- `pnpm test` — run the vitest suite once
- `pnpm typecheck` — `tsc --noEmit` for `src` plus `tsc -p tsconfig.test.json` for tests (two passes)
- `pnpm format` — prettier check (this is what CI runs; it does not auto-fix)
- `pnpm format:write` — prettier auto-fix
- Run a single test file: `pnpm vitest run tests/filter.test.ts`
- Run tests matching a name: `pnpm vitest run -t "filters tools"`

CI (`.github/workflows/ci.yml`) runs, in order: `format`, `typecheck`, `test`. Match that order locally before pushing. Note `pnpm format` fails on unformatted files, so run `format:write` first if needed.

## Architecture

The proxy is a Client↔Server bridge built on `@modelcontextprotocol/sdk`. It connects to the upstream (wrapped) server as an MCP **Client**, and exposes itself to downstream clients as an MCP **Server**. The two sides can use different transports, which is what enables transport bridging.

Data flow and the role of each file:

- `src/index.ts` — entry point. Parses config, optionally spawns a local upstream process for sse/http (and polls `waitForServer` until it responds), builds the upstream transport, then calls `startProxy`.
- `src/config.ts` — single source of config truth. Zod-validated env vars (all prefixed `MCP_FILTER_PROXY_`) plus positional CLI args (the wrapped command + args). Also owns `stripProxyEnv()`, which removes every `MCP_FILTER_PROXY_*` var before env is forwarded to any spawned child, so proxy config never leaks into the wrapped server.
- `src/filter.ts` — pure allowlist logic (`createAllowFilter`, `isAllowed`, `filterByKey`, plus the `ProxyFilters` bundle for tools/resources/prompts). A `null` allowlist means allow-all.
- `src/resource-resolver.ts` — `ResourceNameResolver`, a per-upstream cache mapping resource uri→name (filled from relayed `resources/list`, with a one-time paginated sweep on a miss, invalidated on `resources/list_changed`), so name-based read enforcement works for the uri-only `resources/read`.
- `src/proxy.ts` — the core. `createProxyServer` wires a `Server` to the upstream `Client`: it intercepts `tools`, `resources`, and `prompts` list/access requests to apply the filters, and relays everything else transparently in **both** directions — downstream→upstream requests/notifications via `server.fallback*Handler`, and upstream→downstream notifications and server-initiated requests (sampling, elicitation, `roots/list`) via `upstream.fallback*Handler`. The proxy advertises the upstream's own server info, capabilities, and instructions. `startProxy` connects the upstream client (declaring `UPSTREAM_CLIENT_CAPABILITIES`), builds one shared `ResourceNameResolver`, then exposes via stdio or HTTP.
  - **`UPSTREAM_CLIENT_CAPABILITIES`** is a fixed client-capability set the proxy advertises to the upstream on the downstream client's behalf: `roots`, `sampling`, `elicitation`, and the `io.modelcontextprotocol/ui` extension. The UI extension is load-bearing, not cosmetic: some servers (Atlassian) only return their app/widget resources via `resources/list` and `resources/templates/list` when the client declares it; without it those calls return `-32601`. The widgets are ordinary resources, so `MCP_FILTER_PROXY_ALLOWED_RESOURCES` filters them by name like any other. The set is fixed (not mirrored per downstream client) because the upstream `initialize` happens once at startup and is shared across downstream clients in stateless HTTP; the upstream→downstream request relay makes the declared capabilities serviceable, erroring gracefully if the live downstream client lacks one.
- `src/transports/upstream-{stdio,sse,http}.ts` — build the upstream Client transport. stdio forwards cleaned env via `stripProxyEnv`.
- `src/server/{stdio,http}.ts` — expose the proxy downstream. HTTP uses Express + `StreamableHTTPServerTransport` in **stateless** mode: a fresh `Server` per request, all sharing the one upstream `Client`. SSE is supported only as an upstream transport, not as an expose transport.

### Transport bridging

Upstream transport (`MCP_FILTER_PROXY_UPSTREAM_TRANSPORT`): `stdio`, `sse`, or `http`. It is **optional**: when unset, `resolveUpstreamTransport` in `config.ts` autodetects it (a `SERVER_URL` means a remote upstream, which starts as `http`, or `sse` when the URL path has an `sse` segment, both with `autoNegotiateRemote: true`; a command with no URL means `stdio`; neither is an error). `connectUpstream` in `proxy.ts` is a bounded retry loop that handles, at most once each and in any order, interactive OAuth (on 401) and a bidirectional `http`↔`sse` fallback (on a 404/405 transport mismatch, only when `autoNegotiateRemote`). Setting the var explicitly forces that transport with no fallback. Expose transport (`MCP_FILTER_PROXY_EXPOSE_TRANSPORT`): `stdio` (default) or `http`. Any combination is valid. For stdio upstream the wrapped command comes from positional CLI args; for sse/http it comes from `MCP_FILTER_PROXY_SERVER_URL` (and an optional local command to spawn). See `README.md` for the full env var table and config examples.

## Conventions

- ESM only (`"type": "module"`). Use `.js` extensions in relative imports even from `.ts` files (e.g. `import { x } from "./config.js"`).
- The build (`tsdown.config.ts`) minifies but keeps identifiers (`mangle: false`) and emits no `.d.ts`. `failOnWarn` is on, so build warnings break CI.
- All logging goes to **stderr** (`console.error`), never stdout. stdout is reserved for the MCP protocol stream when exposing over stdio; writing to it corrupts the channel.
- `src/util.ts` reads `package.json` at runtime to get name/version. The path is relative to `dist/`, so the build output layout matters.
- New config belongs in the `EnvSchema` zod object in `config.ts`, with the validated result threaded through `ProxyConfig`.
- Upstream OAuth defaults to the `openid email profile` scope (`MCP_FILTER_PROXY_OAUTH_SCOPE`). This is deliberate, not arbitrary: servers like Atlassian advertise a `resources` capability but return `-32601` for `resources/list`/`prompts/list` unless the token carries a scope, and they publish no scope metadata to discover one from. Server-advertised scopes still win; the default only applies as the SDK's last-resort fallback. Custom upstream headers come from `MCP_FILTER_PROXY_HEADERS` (a JSON object, `${VAR}`-expanded) and the optional RFC 8707 audience from `MCP_FILTER_PROXY_OAUTH_RESOURCE` (via the provider's `validateResourceURL`).
- The OAuth callback server (`src/auth/callback-server.ts`) binds its loopback port (`MCP_FILTER_PROXY_OAUTH_CALLBACK_PORT`, default `8661`) **lazily**, only when an interactive sign-in actually runs, so parallel instances reusing a cached token never contend for it. `createCallbackServer` is construct-only; `buildUpstreamAuth` binds eagerly before connecting when there is no cached token (so the resolved port reaches the SDK's `redirect_uri`), otherwise defers via the provider's `onBeforeRedirect`. When the port is not set explicitly (`callbackPortExplicit` in `config.ts`), `listen({ cycle: true })` scans to the next free port instead of failing.
- Same-URL proxy instances share one on-disk OAuth store (`FileAuthStore`, keyed by a URL hash), so `ProxyOAuthClientProvider` caches per-flow state (`clientInformation`, `tokens`, `codeVerifier`) in memory: reads are memory-first, writes are write-through to disk, and `invalidateCredentials` clears the cache. This lets simultaneous cold-start sign-ins on the same upstream proceed without clobbering each other's PKCE verifier/registration. `clientInformation()` additionally reuses a persisted registration only when its `redirect_uris` includes the bound `redirectUrl`, so a cycled port forces a fresh registration that matches.
