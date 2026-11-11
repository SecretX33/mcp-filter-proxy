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

export function loadNpm(directory) {
  if (!directory)
    throw new Error(
      "NPM_DIRECTORY is missing. Install the pinned npm version and resolve its global installation directory.",
    );
  const require = createRequire(join(directory, "package.json"));
  if (require("./package.json").version !== npmVersion) {
    throw new Error(
      `Publishing requires npm ${npmVersion}. Reinstall the pinned publishing tooling before retrying.`,
    );
  }
  // npm's provenance helpers are internal, so the workflow pins the npm version.
  const provenance = require(
    join(dirname(require.resolve("libnpmpublish")), "provenance.js"),
  );
  const npm = { ...require("libnpmpublish"), ...provenance };
  for (const name of ["publish", "generateProvenance", "verifyProvenance"]) {
    if (typeof npm[name] !== "function") {
      throw new Error(
        `Pinned npm is missing ${name}. Check the publishing tooling installation and provenance helper compatibility.`,
      );
    }
  }
  return npm;
}

async function request(url, options, context, fetch) {
  try {
    return await fetch(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(
      `${context}: request failed (${error.message}). Check network access and service availability.`,
    );
  }
}

async function responseJson(response, context) {
  try {
    const value = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Expected a JSON object");
    return value;
  } catch {
    throw new Error(
      `${context}: the service returned invalid JSON (HTTP ${response.status}).`,
    );
  }
}

export async function readArtifact(path, version) {
  let tarball;
  let manifest;
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
      `Cannot read the release tarball and its package/package.json: ${error.message}`,
    );
  }
  const url =
    typeof manifest.repository === "string"
      ? manifest.repository
      : manifest.repository?.url;
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
  return { manifest, tarball };
}

function validateEnvironment(env) {
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
    !["true", "false"].includes(env.DRY_RUN)
  ) {
    throw new Error(
      "RELEASE_VERSION must be a release version such as 0.1.4, and DRY_RUN must be exactly true or false.",
    );
  }
}

async function exchangeToken(env, fetch) {
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (url.protocol !== "https:")
    throw new Error("The GitHub OIDC endpoint must use HTTPS. Publishing is refused.");
  url.searchParams.set("audience", "npm:registry.npmjs.org");
  const identityResponse = await request(
    url,
    {
      headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    },
    "Requesting GitHub OIDC identity",
    fetch,
  );
  if (!identityResponse.ok) {
    throw new Error(
      `GitHub refused the OIDC request (HTTP ${identityResponse.status}). Check id-token: write on the caller and reusable workflow.`,
    );
  }
  const { value: identity } = await responseJson(identityResponse, "GitHub OIDC");
  if (typeof identity !== "string" || !identity)
    throw new Error("GitHub returned no OIDC identity token. Publishing is refused.");
  console.error(`::add-mask::${identity}`);
  let claims;
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
  if (!exchangeResponse.ok) {
    throw new Error(
      `npm refused trusted publishing for ${packageName} (HTTP ${exchangeResponse.status}). In npm package Settings > Trusted publishing, authorize repository ${repository}, calling workflow ${workflow}, and its environment if configured. Check that the publisher configuration has not expired.`,
    );
  }
  const credentials = await responseJson(exchangeResponse, "npm OIDC exchange");
  if (typeof credentials.token === "string" && credentials.token)
    console.error(`::add-mask::${credentials.token}`);
  if (
    credentials.token_type !== "oidc" ||
    typeof credentials.token !== "string" ||
    !credentials.token ||
    !(Date.parse(credentials.expires) > Date.now() + 60_000)
  ) {
    throw new Error(
      "npm did not return a valid, unexpired OIDC publishing token. Account-token fallback is forbidden. Retry the workflow to request fresh credentials.",
    );
  }
  console.error("npm accepted this workflow as a trusted publisher.");
  return credentials.token;
}

async function verifyPublished(version, integrity, fetch) {
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
      if (metadata._npmUser?.trustedPublisher?.id !== "github")
        throw new Error("npm metadata does not identify a GitHub trusted publisher");
      if (metadata.dist?.attestations?.provenance?.predicateType !== predicateType)
        throw new Error("npm metadata does not contain SLSA provenance");
      if (metadata.dist?.integrity !== integrity)
        throw new Error("npm metadata does not match the uploaded tarball SHA-512");
      console.error(
        `Verified ${packageName}@${version}: GitHub trusted publisher, SLSA provenance, and matching tarball integrity.`,
      );
      return;
    } catch (error) {
      problem = error.message;
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
        `Provenance preflight failed: ${error.message}. No package was uploaded. Check id-token: write, public repository visibility, and access to Sigstore Fulcio and Rekor.`,
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
      throw new Error(
        `npm upload failed or its result is unknown (${error.code ?? "unknown error"}): ${error.message}. Check the trusted publisher allows direct publishing and inspect npm for ${packageName}@${manifest.version} before retrying. No account-token fallback was attempted.`,
      );
    }
    await verifyPublished(manifest.version, `sha512-${digest.toString("base64")}`, fetch);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  publishRelease().catch((error) => {
    const message = error.message
      .replaceAll("%", "%25")
      .replaceAll("\r", "%0D")
      .replaceAll("\n", "%0A");
    console.error(`::error::${message}`);
    process.exitCode = 1;
  });
}
