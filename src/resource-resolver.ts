import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

interface NamedResource {
  uri: string;
  name: string;
}

/**
 * Maps resource `uri` -> `name` for the upstream server, so the proxy can enforce a name-based
 * resource allowlist on `resources/read` (which carries only a uri). The map is filled from every
 * `resources/list` the proxy relays; on a miss it does a single paginated sweep of the upstream
 * resource list and caches it. A `resources/list_changed` notification invalidates the cache.
 */
export class ResourceNameResolver {
  private uriToName = new Map<string, string>();
  private loaded = false;
  private loading: Promise<void> | null = null;

  constructor(private readonly upstream: Client) {}

  /** Record uri -> name pairs observed in a relayed list response. */
  record(resources: NamedResource[]): void {
    for (const { uri, name } of resources) {
      this.uriToName.set(uri, name);
    }
  }

  /** Resolve a resource uri to its name, loading the full upstream list once if needed. */
  async nameForUri(uri: string): Promise<string | undefined> {
    const cached = this.uriToName.get(uri);
    if (cached !== undefined) return cached;
    if (!this.loaded) await this.ensureLoaded();
    return this.uriToName.get(uri);
  }

  /** Drop the cache so the next lookup re-syncs (e.g. after a list_changed notification). */
  invalidate(): void {
    this.uriToName.clear();
    this.loaded = false;
  }

  private ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (!this.loading) {
      this.loading = this.loadAll().finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  private async loadAll(): Promise<void> {
    let cursor: string | undefined;
    do {
      const result = await this.upstream.listResources(cursor ? { cursor } : {});
      this.record(result.resources);
      cursor = result.nextCursor;
    } while (cursor);
    this.loaded = true;
  }
}
