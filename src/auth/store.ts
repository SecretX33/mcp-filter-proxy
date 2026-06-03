import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs/promises";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { PROJECT_INFO } from "../util.js";

/**
 * Default root for cached OAuth state. Versioned so a proxy upgrade starts from a clean cache
 * instead of reusing a registration/token that an older version may have written differently.
 */
const defaultRoot = (): string =>
  join(homedir(), ".mcp-auth", `mcp-filter-proxy-${PROJECT_INFO.version}`, "oauth");

/**
 * File-backed persistence for one upstream server's OAuth session (tokens, dynamically
 * registered client, PKCE verifier, and discovery state). State lives under a per-server
 * directory keyed by a hash of the server URL so multiple wrapped servers stay isolated.
 */
export class FileAuthStore {
  private readonly dir: string;

  constructor(serverUrl: string, baseDir?: string | null) {
    const root = baseDir ?? defaultRoot();
    const key = createHash("sha256").update(serverUrl).digest("hex").slice(0, 16);
    this.dir = join(root, key);
  }

  async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    return this.readJson<OAuthClientInformationFull>("client_info.json");
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await this.writeJson("client_info.json", info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.readJson<OAuthTokens>("tokens.json");
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.writeJson("tokens.json", tokens);
  }

  async codeVerifier(): Promise<string | undefined> {
    return this.readText("code_verifier.txt");
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.writeText("code_verifier.txt", verifier);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.readJson<OAuthDiscoveryState>("discovery_state.json");
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.writeJson("discovery_state.json", state);
  }

  /** Remove cached credentials. Scope mirrors the SDK's `invalidateCredentials` contract. */
  async invalidate(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    const files: Record<typeof scope, string[]> = {
      all: [
        "client_info.json",
        "tokens.json",
        "code_verifier.txt",
        "discovery_state.json",
      ],
      client: ["client_info.json"],
      tokens: ["tokens.json"],
      verifier: ["code_verifier.txt"],
      discovery: ["discovery_state.json"],
    };
    await Promise.all(files[scope].map((name) => this.remove(name)));
  }

  private async readJson<T>(name: string): Promise<T | undefined> {
    const text = await this.readText(name);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      console.error(`Ignoring corrupt OAuth cache file ${name}: ${err}`);
      return undefined;
    }
  }

  private async readText(name: string): Promise<string | undefined> {
    try {
      return await fs.readFile(join(this.dir, name), "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  private async writeJson(name: string, value: unknown): Promise<void> {
    await this.writeText(name, JSON.stringify(value, null, 2));
  }

  /** Write atomically (tmp file + rename) so a crash never leaves a half-written cache. */
  private async writeText(name: string, content: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = join(this.dir, name);
    const tmp = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, content, { mode: 0o600 });
    await fs.rename(tmp, target);
  }

  private async remove(name: string): Promise<void> {
    try {
      await fs.unlink(join(this.dir, name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
