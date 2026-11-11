import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const packageName = "mcp-filter-proxy";
const repository = "SecretX33/mcp-filter-proxy";
const registry = "https://registry.npmjs.org/";
const npmVersion = "12.2.2";
const predicateType = "https://slsa.dev/provenance/v1";

type PackageManifest = Record<string, unknown> & { name: string; version: string };
type ProvenanceSubject = { name: string; digest: { sha512: string } };

export type NpmPublisher = {
  generateProvenance: (
    subjects: ProvenanceSubject[],
    options: Record<string, unknown>,
  ) => Promise<unknown>;
  verifyProvenance: (subject: ProvenanceSubject, path: string) => Promise<unknown>;
  publish: (
    manifest: PackageManifest,
    tarball: Buffer,
    options: {
      registry: string;
      access: "public";
      defaultTag: "latest";
      npmVersion: string;
      forceAuth: { token: string };
      provenanceFile: string;
      timeout: number;
      retry: { retries: number };
    },
  ) => Promise<unknown>;
};

type PublishEnvironment = NodeJS.ProcessEnv & {
  ACTIONS_ID_TOKEN_REQUEST_URL: string;
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: string;
  RELEASE_VERSION: string;
  RELEASE_TARBALL: string;
  DRY_RUN: "true" | "false";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseTokenExpiry(value: unknown): number {
  if (typeof value === "string") return Date.parse(value);
  if (typeof value !== "number" || !Number.isFinite(value)) return NaN;
  const milliseconds = Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
  return new Date(milliseconds).getTime();
}

export function loadNpm(directory: string | undefined): NpmPublisher {
  if (!directory)
    throw new Error(
      "NPM_DIRECTORY is missing. Install the pinned npm version and resolve its global installation directory.",
    );
  const require = createRequire(join(directory, "package.json"));
  const manifest: unknown = require("./package.json");
  if (!isRecord(manifest) || manifest.version !== npmVersion) {
    throw new Error(
      `Publishing requires npm ${npmVersion}. Reinstall the pinned publishing tooling before retrying.`,
    );
  }
  // npm's provenance helpers are internal, so the workflow pins the npm version.
  const provenance: unknown = require(
    join(dirname(require.resolve("libnpmpublish")), "provenance.js"),
  );
  const publisher: unknown = require("libnpmpublish");
  if (!isRecord(publisher) || !isRecord(provenance)) {
    throw new Error(
      "Pinned npm returned invalid publishing modules. Reinstall the publishing tooling.",
    );
  }
  const npm = { ...publisher, ...provenance };
  for (const name of ["publish", "generateProvenance", "verifyProvenance"] as const) {
    if (typeof npm[name] !== "function") {
      throw new Error(
        `Pinned npm is missing ${name}. Check the publishing tooling installation and provenance helper compatibility.`,
      );
    }
  }
  return npm as NpmPublisher;
}

async function request(
  url: string | URL,
  options: RequestInit,
  context: string,
  fetch: typeof globalThis.fetch,
) {
  try {
    return await fetch(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(
      `${context}: request failed (${errorMessage(error)}). Check network access and service availability.`,
    );
  }
}

async function responseJson(
  response: Response,
  context: string,
): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    if (!isRecord(value)) throw new Error("Expected a JSON object");
    return value;
  } catch {
    throw new Error(
      `${context}: the service returned invalid JSON (HTTP ${response.status}).`,
    );
  }
}

export async function readArtifact(
  path: string,
  version: string,
): Promise<{ manifest: PackageManifest; tarball: Buffer }> {
  let tarball;
  let manifest: unknown;
  try {
    tarball = await readFile(path);
    manifest = JSON.parse(
      execFileSync("tar", ["-xzOf", "-", "package/package.json"], {
        input: tarball,
        encoding: "utf8",
      }),
    );
  } catch (error) {
    throw new Error(
      `Cannot read the release tarball and its package/package.json: ${errorMessage(error)}`,
    );
  }
  if (!isRecord(manifest)) {
    throw new Error(
      "Release package/package.json must contain a JSON object. Check the release build.",
    );
  }
  const url =
    typeof manifest.repository === "string"
      ? manifest.repository
      : isRecord(manifest.repository)
        ? manifest.repository.url
        : undefined;
  if (
    manifest.name !== packageName ||
    manifest.version !== version ||
    manifest.private ||
    typeof url !== "string" ||
    url?.replace(/^git\+/, "").replace(/\.git$/, "") !==
      `https://github.com/${repository}`
  ) {
    throw new Error(
      `Release asset must contain the public package ${packageName}@${version} with repository https://github.com/${repository}. Check the release build and selected tag.`,
    );
  }
  return {
    manifest: { ...manifest, name: manifest.name, version: manifest.version },
    tarball,
  };
}

function validateEnvironment(env: NodeJS.ProcessEnv): asserts env is PublishEnvironment {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    env.GITHUB_REPOSITORY !== repository
  ) {
    throw new Error(
      `Publishing must run on a GitHub-hosted Actions runner in ${repository}. Local and self-hosted publishes are refused.`,
    );
  }
  if (env.NPM_TOKEN || env.NODE_AUTH_TOKEN || env.NPM_ID_TOKEN) {
    throw new Error(
      "Remove NPM_TOKEN, NODE_AUTH_TOKEN, and NPM_ID_TOKEN from the publishing job. Only a freshly requested GitHub OIDC identity may authorize this release.",
    );
  }
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error(
      "GitHub OIDC is unavailable. Grant id-token: write to both the calling workflow and the reusable publish workflow.",
    );
  }
  if (
    !env.GITHUB_WORKFLOW_REF ||
    !env.GITHUB_SHA ||
    env.GITHUB_SERVER_URL !== "https://github.com"
  ) {
    throw new Error(
      "GitHub workflow identity, source commit, or server URL is missing or invalid. Run the publishing workflow on github.com so provenance can identify its source.",
    );
  }
  if (
    !/^\d+\.\d+\.\d+$/.test(env.RELEASE_VERSION ?? "") ||
    (env.DRY_RUN !== "true" && env.DRY_RUN !== "false")
  ) {
    throw new Error(
      "RELEASE_VERSION must be a release version such as 0.1.4, and DRY_RUN must be exactly true or false.",
    );
  }
  if (!env.RELEASE_TARBALL) {
    throw new Error(
      "RELEASE_TARBALL is missing. Set it to the downloaded release package before running the publisher.",
    );
  }
}

async function exchangeToken(env: PublishEnvironment, fetch: typeof globalThis.fetch) {
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (url.protocol !== "https:")
    throw new Error("The GitHub OIDC endpoint must use HTTPS. Publishing is refused.");
  url.searchParams.set("audience", "npm:registry.npmjs.org");
  console.error("Requesting GitHub OIDC identity for npm:registry.npmjs.org.");
  const identityResponse = await request(
    url,
    {
      headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    },
    "Requesting GitHub OIDC identity",
    fetch,
  );
  console.error(`GitHub OIDC identity response: HTTP ${identityResponse.status}.`);
  if (!identityResponse.ok) {
    throw new Error(
      `GitHub refused the OIDC request (HTTP ${identityResponse.status}). Check id-token: write on the caller and reusable workflow.`,
    );
  }
  const { value: identity } = await responseJson(identityResponse, "GitHub OIDC");
  if (typeof identity !== "string" || !identity)
    throw new Error("GitHub returned no OIDC identity token. Publishing is refused.");
  console.error(`::add-mask::${identity}`);
  let claims: unknown;
  try {
    claims = JSON.parse(
      Buffer.from(identity.split(".")[1], "base64url").toString("utf8"),
    );
  } catch {
    throw new Error(
      "GitHub returned an unreadable OIDC identity token. Publishing is refused.",
    );
  }
  if (
    !isRecord(claims) ||
    claims.repository !== repository ||
    claims.repository_visibility !== "public" ||
    claims.aud !== "npm:registry.npmjs.org"
  ) {
    throw new Error(
      `OIDC identity must target npm:registry.npmjs.org and the public repository ${repository}. Check the repository visibility and token audience.`,
    );
  }
  const workflow = claims.workflow_ref ?? env.GITHUB_WORKFLOW_REF;
  console.error(`Validating npm trusted publisher for ${packageName} using ${workflow}.`);
  const exchangeResponse = await request(
    `${registry}-/npm/v1/oidc/token/exchange/package/${packageName}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${identity}` },
    },
    "Exchanging GitHub identity with npm",
    fetch,
  );
  console.error(`npm OIDC exchange response: HTTP ${exchangeResponse.status}.`);
  if (!exchangeResponse.ok) {
    throw new Error(
      `npm refused trusted publishing for ${packageName} (HTTP ${exchangeResponse.status}). In npm package Settings > Trusted publishing, authorize repository ${repository}, calling workflow ${workflow}, and its environment if configured. Check that the publisher configuration has not expired.`,
    );
  }
  const credentials = await responseJson(exchangeResponse, "npm OIDC exchange");
  const token = credentials.token;
  const tokenPresent = typeof token === "string" && token.length > 0;
  if (tokenPresent) console.error(`::add-mask::${token}`);
  const checkedAt = Date.now();
  const expiresAt = parseTokenExpiry(credentials.expires);
  const expiryParsed = Number.isFinite(expiresAt);
  const remainingSeconds = expiryParsed
    ? Math.floor((expiresAt - checkedAt) / 1000)
    : null;
  const tokenType =
    credentials.token_type === "oidc" ||
    credentials.token_type === "bearer" ||
    credentials.token_type === "Bearer"
      ? credentials.token_type
      : "unrecognized or missing";
  const fieldTypes = Object.fromEntries(
    ["token", "token_type", "created", "expires", "expires_in", "expires_at"].map(
      (key) => [
        key,
        Object.hasOwn(credentials, key)
          ? credentials[key] === null
            ? "null"
            : typeof credentials[key]
          : "missing",
      ],
    ),
  );
  console.error(
    `npm OIDC exchange diagnostics: ${JSON.stringify({
      fieldTypes,
      tokenPresent,
      tokenType,
      checkedAt: new Date(checkedAt).toISOString(),
      expiresAt: expiryParsed ? new Date(expiresAt).toISOString() : null,
      remainingSeconds,
      requiredRemainingSeconds: 60,
    })}`,
  );
  const failures: string[] = [];
  if (!tokenPresent) failures.push("token must be a non-empty string");
  if (credentials.token_type !== "oidc") failures.push('token_type must equal "oidc"');
  if (typeof credentials.expires !== "string" && typeof credentials.expires !== "number")
    failures.push("expires must be a string or number");
  else if (!expiryParsed) failures.push("expires must be a parseable timestamp");
  else if (expiresAt <= checkedAt + 60_000)
    failures.push("token must have more than 60 seconds remaining");
  if (!tokenPresent || failures.length > 0) {
    throw new Error(
      `npm OIDC response validation failed: ${failures.join("; ")}. See the sanitized exchange diagnostics above. No package was uploaded. Account-token fallback is forbidden.`,
    );
  }
  console.error("npm accepted this workflow as a trusted publisher.");
  return token;
}

async function verifyPublished(
  version: string,
  integrity: string,
  fetch: typeof globalThis.fetch,
) {
  let problem;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await request(
        `${registry}${packageName}/${version}`,
        {
          headers: { "Cache-Control": "no-cache" },
        },
        "Checking published npm metadata",
        fetch,
      );
      if (!response.ok) throw new Error(`npm metadata returned HTTP ${response.status}`);
      const metadata = await responseJson(response, "Published npm metadata");
      const publisher = metadata._npmUser;
      if (
        !isRecord(publisher) ||
        !isRecord(publisher.trustedPublisher) ||
        publisher.trustedPublisher.id !== "github"
      )
        throw new Error("npm metadata does not identify a GitHub trusted publisher");
      const dist = metadata.dist;
      if (
        !isRecord(dist) ||
        !isRecord(dist.attestations) ||
        !isRecord(dist.attestations.provenance) ||
        dist.attestations.provenance.predicateType !== predicateType
      )
        throw new Error("npm metadata does not contain SLSA provenance");
      if (dist.integrity !== integrity)
        throw new Error("npm metadata does not match the uploaded tarball SHA-512");
      console.error(
        `Verified ${packageName}@${version}: GitHub trusted publisher, SLSA provenance, and matching tarball integrity.`,
      );
      return;
    } catch (error) {
      problem = errorMessage(error);
      if (attempt < 4) await setTimeout(2_000);
    }
  }
  throw new Error(
    `Upload completed, but release verification failed: ${problem}. The version may already be public. Inspect https://www.npmjs.com/package/${packageName}/v/${version} before retrying; published versions cannot be replaced.`,
  );
}

export async function publishRelease({
  env = process.env,
  npm,
  fetch = globalThis.fetch,
}: {
  env?: NodeJS.ProcessEnv;
  npm?: NpmPublisher;
  fetch?: typeof globalThis.fetch;
} = {}) {
  validateEnvironment(env);
  npm ??= loadNpm(env.NPM_DIRECTORY);
  const { manifest, tarball } = await readArtifact(
    env.RELEASE_TARBALL,
    env.RELEASE_VERSION,
  );
  const existing = await request(
    `${registry}${packageName}/${manifest.version}`,
    {},
    "Checking release availability",
    fetch,
  );
  if (existing.ok)
    throw new Error(
      `${packageName}@${manifest.version} already exists on npm. Select a new version; published versions cannot be replaced.`,
    );
  if (existing.status !== 404)
    throw new Error(
      `Cannot check whether ${packageName}@${manifest.version} exists (HTTP ${existing.status}). No upload was attempted.`,
    );
  const token = await exchangeToken(env, fetch);
  const digest = createHash("sha512").update(tarball).digest();
  const subject = {
    name: `pkg:npm/${packageName}@${manifest.version}`,
    digest: { sha512: digest.toString("hex") },
  };
  const directory = await mkdtemp(join(tmpdir(), "mcp-filter-proxy-publish-"));
  const provenanceFile = join(directory, "provenance.sigstore");
  try {
    console.error(
      "Generating and verifying signed provenance for the exact release tarball before upload.",
    );
    try {
      const bundle = await npm.generateProvenance([subject], {});
      await writeFile(provenanceFile, JSON.stringify(bundle), { mode: 0o600 });
      await npm.verifyProvenance(subject, provenanceFile);
    } catch (error) {
      throw new Error(
        `Provenance preflight failed: ${errorMessage(error)}. No package was uploaded. Check id-token: write, public repository visibility, and access to Sigstore Fulcio and Rekor.`,
      );
    }
    if (env.DRY_RUN === "true") {
      console.error(
        "Dry run passed: npm accepted OIDC authentication and signed provenance was verified. No package was uploaded to npm. Signing recorded the attestation in the public Sigstore transparency log.",
      );
      return;
    }
    console.error(
      `Publishing ${packageName}@${manifest.version} with the verified provenance bundle and OIDC token only.`,
    );
    try {
      await npm.publish(manifest, tarball, {
        registry,
        access: "public",
        defaultTag: "latest",
        npmVersion,
        forceAuth: { token },
        provenanceFile,
        timeout: 30_000,
        retry: { retries: 0 },
      });
    } catch (error) {
      const code =
        isRecord(error) && typeof error.code === "string" ? error.code : "unknown error";
      throw new Error(
        `npm upload failed or its result is unknown (${code}): ${errorMessage(error)}. Check the trusted publisher allows direct publishing and inspect npm for ${packageName}@${manifest.version} before retrying. No account-token fallback was attempted.`,
      );
    }
    await verifyPublished(manifest.version, `sha512-${digest.toString("base64")}`, fetch);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  publishRelease().catch((error: unknown) => {
    const message = errorMessage(error)
      .replaceAll("%", "%25")
      .replaceAll("\r", "%0D")
      .replaceAll("\n", "%0A");
    console.error(`::error::${message}`);
    process.exitCode = 1;
  });
}
