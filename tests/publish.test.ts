import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import {
  loadNpm,
  publishRelease,
  readArtifact,
  type NpmPublisher,
} from "../.github/scripts/publish.js";

vi.mock("node:timers/promises", () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

const version = "0.1.4";
const manifest = {
  name: "mcp-filter-proxy",
  version,
  repository: { url: "git+https://github.com/SecretX33/mcp-filter-proxy.git" },
};
const identity = `header.${Buffer.from(
  JSON.stringify({
    aud: "npm:registry.npmjs.org",
    repository: "SecretX33/mcp-filter-proxy",
    repository_visibility: "public",
    workflow_ref:
      "SecretX33/mcp-filter-proxy/.github/workflows/build-release-and-publish.yml@refs/heads/main",
  }),
).toString("base64url")}.signature`;
let directory: string;
let artifact: string;
let tarball: Buffer;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "publish-test-"));
  await mkdir(join(directory, "package"));
  await writeFile(join(directory, "package/package.json"), JSON.stringify(manifest));
  artifact = join(directory, "release.tgz");
  execFileSync("tar", ["-czf", artifact, "-C", directory, "package"]);
  tarball = await readFile(artifact);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(setTimeout).mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

function fixture(
  expires: string | number = new Date(Date.now() + 3_600_000).toISOString(),
) {
  const env = {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_REPOSITORY: "SecretX33/mcp-filter-proxy",
    GITHUB_WORKFLOW_REF:
      "SecretX33/mcp-filter-proxy/.github/workflows/build-release-and-publish.yml@refs/heads/main",
    GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
    GITHUB_SERVER_URL: "https://github.com",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://github.example/oidc",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-request-token",
    RELEASE_VERSION: version,
    RELEASE_TARBALL: artifact,
    DRY_RUN: "false",
  };
  const credentials = {
    token_type: "oidc",
    token: "exchanged-oidc-token",
    expires,
  };
  const bundle = { mediaType: "test-bundle" };
  const events: string[] = [];
  const requests: { url: string; options?: RequestInit }[] = [];
  const metadata = {
    _npmUser: { trustedPublisher: { id: "github" } },
    dist: {
      integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
      attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
    },
  };
  const npm = {
    generateProvenance: vi.fn<NpmPublisher["generateProvenance"]>(async () => {
      events.push("sign");
      return bundle;
    }),
    verifyProvenance: vi.fn<NpmPublisher["verifyProvenance"]>(async (subject, path) => {
      events.push("verify");
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), bundle);
      assert.equal(
        subject.digest.sha512,
        createHash("sha512").update(tarball).digest("hex"),
      );
    }),
    publish: vi.fn<NpmPublisher["publish"]>(async () => {
      events.push("publish");
    }),
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).startsWith(env.ACTIONS_ID_TOKEN_REQUEST_URL)) {
      events.push("identity");
      return Response.json({ value: identity });
    }
    if (String(url).includes("/oidc/token/exchange/")) {
      events.push("exchange");
      return Response.json(credentials, { status: 201 });
    }
    if (events.includes("publish")) return Response.json(metadata);
    return new Response(null, { status: 404 });
  });
  return { env, npm, fetch, credentials, events, requests, metadata };
}

test("validates OIDC and provenance before publishing the same bytes with no credential fallback", async () => {
  const state = fixture();
  await publishRelease(state);
  assert.deepEqual(state.events, ["identity", "exchange", "sign", "verify", "publish"]);
  const identityRequest = state.requests.find(({ url }) =>
    url.startsWith(state.env.ACTIONS_ID_TOKEN_REQUEST_URL),
  );
  assert.ok(identityRequest);
  assert.equal(
    new URL(identityRequest.url).searchParams.get("audience"),
    "npm:registry.npmjs.org",
  );
  const exchange = state.requests.find(({ url }) =>
    url.includes("/oidc/token/exchange/"),
  );
  assert.ok(exchange);
  assert.equal(
    new Headers(exchange.options?.headers).get("Authorization"),
    `Bearer ${identity}`,
  );
  const [publishedManifest, publishedBytes, options] = state.npm.publish.mock.calls[0];
  assert.deepEqual(publishedManifest, manifest);
  assert.deepEqual(publishedBytes, tarball);
  assert.deepEqual(options.forceAuth, { token: state.credentials.token });
  assert.equal(options.registry, "https://registry.npmjs.org/");
  assert.equal(options.access, "public");
  assert.equal(options.retry.retries, 0);
  const verifiedPath = state.npm.verifyProvenance.mock.calls[0][1];
  assert.equal(options.provenanceFile, verifiedPath);
  await assert.rejects(readFile(verifiedPath), { code: "ENOENT" });
});

test("dry run performs real preflight steps and never uploads to npm", async () => {
  const state = fixture();
  state.env.DRY_RUN = "true";
  await publishRelease(state);
  assert.deepEqual(state.events, ["identity", "exchange", "sign", "verify"]);
  assert.equal(state.npm.publish.mock.calls.length, 0);
  const path = state.npm.verifyProvenance.mock.calls[0][1];
  await assert.rejects(readFile(path), { code: "ENOENT" });
});

for (const key of ["NPM_TOKEN", "NODE_AUTH_TOKEN", "NPM_ID_TOKEN"]) {
  test(`refuses injected ${key} credentials before any network request`, async () => {
    const state = fixture();
    state.env = { ...state.env, [key]: "account-token" };
    await assert.rejects(publishRelease(state), /Remove NPM_TOKEN/);
    assert.equal(state.fetch.mock.calls.length, 0);
    assert.equal(state.npm.publish.mock.calls.length, 0);
  });
}

for (const [key, value, message] of [
  ["RUNNER_ENVIRONMENT", "self-hosted", /GitHub-hosted/],
  ["GITHUB_REPOSITORY", "attacker/fork", /GitHub-hosted/],
  ["ACTIONS_ID_TOKEN_REQUEST_TOKEN", "", /id-token: write/],
  ["DRY_RUN", "", /DRY_RUN must be exactly/],
] as const) {
  test(`refuses invalid ${key} before upload`, async () => {
    const state = fixture();
    state.env[key] = value;
    await assert.rejects(publishRelease(state), message);
    assert.equal(state.npm.publish.mock.calls.length, 0);
  });
}

test("rejects release assets with a different version", async () => {
  await assert.rejects(readArtifact(artifact, "0.1.5"), /Release asset must contain/);
});

test("refuses an already published version", async () => {
  const state = fixture();
  state.fetch.mockImplementation(async () => Response.json(manifest));
  await assert.rejects(publishRelease(state), /already exists on npm/);
  assert.equal(state.npm.generateProvenance.mock.calls.length, 0);
  assert.equal(state.npm.publish.mock.calls.length, 0);
});

test("registry availability errors never allow publication", async () => {
  const state = fixture();
  state.fetch.mockImplementation(async () => new Response(null, { status: 503 }));
  await assert.rejects(publishRelease(state), /HTTP 503.*No upload was attempted/);
  assert.equal(state.npm.publish.mock.calls.length, 0);
});

test("OIDC exchange rejection includes the calling workflow and never signs or uploads", async () => {
  const state = fixture();
  const fetch = state.fetch.getMockImplementation();
  assert.ok(fetch);
  state.fetch.mockImplementation(async (url, options) =>
    String(url).includes("/oidc/token/exchange/")
      ? new Response(null, { status: 401 })
      : fetch(url, options),
  );
  await assert.rejects(publishRelease(state), /HTTP 401.*build-release-and-publish.yml/);
  assert.equal(state.npm.generateProvenance.mock.calls.length, 0);
  assert.equal(state.npm.publish.mock.calls.length, 0);
});

for (const invalid of [
  { credentials: { token_type: "bearer" }, message: /token_type must equal "oidc"/ },
  {
    credentials: { expires: "invalid" },
    message: /expires must be a parseable timestamp/,
  },
  {
    credentials: { expires: new Date(0).toISOString() },
    message: /more than 60 seconds remaining/,
  },
  { credentials: { token: "" }, message: /token must be a non-empty string/ },
  { credentials: { expires: true }, message: /expires must be a string or number/ },
  { credentials: { expires: 1e100 }, message: /expires must be a parseable timestamp/ },
  { credentials: { expires: 0 }, message: /more than 60 seconds remaining/ },
]) {
  test(`reports invalid exchanged credentials: ${JSON.stringify(invalid.credentials)}`, async () => {
    const state = fixture();
    Object.assign(state.credentials, invalid.credentials);
    await assert.rejects(publishRelease(state), invalid.message);
    assert.equal(state.npm.generateProvenance.mock.calls.length, 0);
    assert.equal(state.npm.publish.mock.calls.length, 0);
  });
}

test("logs successful exchange status and expiry metadata without exposing credentials", async () => {
  const state = fixture();
  state.env.DRY_RUN = "true";
  await publishRelease(state);
  const messages = vi.mocked(console.error).mock.calls.flat().map(String);
  assert.ok(messages.includes("GitHub OIDC identity response: HTTP 200."));
  assert.ok(messages.includes("npm OIDC exchange response: HTTP 201."));
  const diagnostics = messages.find((message) =>
    message.startsWith("npm OIDC exchange diagnostics:"),
  );
  assert.ok(diagnostics);
  assert.match(diagnostics, /"tokenPresent":true/);
  assert.match(diagnostics, /"tokenType":"oidc"/);
  assert.ok(diagnostics.includes(String(state.credentials.expires)));
  assert.match(diagnostics, /"requiredRemainingSeconds":60/);
  const visibleMessages = messages
    .filter((message) => !message.startsWith("::add-mask::"))
    .join("\n");
  for (const secret of [
    identity,
    state.credentials.token,
    state.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  ]) {
    assert.ok(!visibleMessages.includes(secret));
  }
});

for (const unit of ["seconds", "milliseconds"] as const) {
  test(`accepts npm's numeric expiry in Unix ${unit}`, async () => {
    const expiresAt = Math.floor((Date.now() + 3_600_000) / 1000) * 1000;
    const state = fixture(unit === "seconds" ? expiresAt / 1000 : expiresAt);
    state.env.DRY_RUN = "true";
    await publishRelease(state);
    assert.equal(state.npm.verifyProvenance.mock.calls.length, 1);
    assert.equal(state.npm.publish.mock.calls.length, 0);
    const messages = vi.mocked(console.error).mock.calls.flat().map(String).join("\n");
    assert.ok(messages.includes(new Date(expiresAt).toISOString()));
    assert.match(messages, /"expires":"number"/);
    assert.ok(messages.includes("Dry run passed:"));
  });

  test(`rejects numeric expiry in ${unit} with insufficient lifetime`, async () => {
    const expiresAt = Date.now() + 30_000;
    const state = fixture(unit === "seconds" ? Math.floor(expiresAt / 1000) : expiresAt);
    await assert.rejects(publishRelease(state), /more than 60 seconds remaining/);
    assert.equal(state.npm.generateProvenance.mock.calls.length, 0);
    assert.equal(state.npm.publish.mock.calls.length, 0);
  });
}

test("missing expiry metadata is identified before signing or upload", async () => {
  const state = fixture();
  Reflect.deleteProperty(state.credentials, "expires");
  await assert.rejects(publishRelease(state), /expires must be a string or number/);
  const messages = vi.mocked(console.error).mock.calls.flat().map(String).join("\n");
  assert.match(messages, /"expires":"missing"/);
  assert.match(messages, /"expiresAt":null/);
  assert.equal(state.npm.generateProvenance.mock.calls.length, 0);
  assert.equal(state.npm.publish.mock.calls.length, 0);
});

test("diagnostics and validation errors omit credentials even if echoed in metadata", async () => {
  const state = fixture();
  state.credentials.token_type = identity;
  state.credentials.expires = state.credentials.token;
  Object.assign(state.credentials, { debug: state.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN });
  await assert.rejects(publishRelease(state), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /token_type must equal "oidc"/);
    assert.match(error.message, /expires must be a parseable timestamp/);
    const visibleMessages = vi
      .mocked(console.error)
      .mock.calls.flat()
      .map(String)
      .filter((message) => !message.startsWith("::add-mask::"))
      .join("\n");
    for (const secret of [
      identity,
      state.credentials.token,
      state.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    ]) {
      assert.ok(!visibleMessages.includes(secret));
      assert.ok(!error.message.includes(secret));
    }
    return true;
  });
  assert.equal(state.npm.publish.mock.calls.length, 0);
});

for (const step of ["generateProvenance", "verifyProvenance"] as const) {
  test(`failure in ${step} aborts before upload, including dry runs`, async () => {
    for (const dryRun of ["true", "false"]) {
      const state = fixture();
      state.env.DRY_RUN = dryRun;
      state.npm[step].mockRejectedValue(new Error("signature failure"));
      await assert.rejects(
        publishRelease(state),
        /Provenance preflight failed: signature failure.*No package was uploaded/,
      );
      assert.equal(state.npm.publish.mock.calls.length, 0);
    }
  });
}

test("upload failure explains uncertainty and never retries the mutation", async () => {
  const state = fixture();
  state.npm.publish.mockRejectedValue(
    Object.assign(new Error("registry rejected upload"), { code: "E403" }),
  );
  await assert.rejects(
    publishRelease(state),
    /result is unknown \(E403\).*direct publishing/,
  );
  assert.equal(state.npm.publish.mock.calls.length, 1);
});

for (const [field, message] of [
  ["publisher", /does not identify a GitHub trusted publisher/],
  ["provenance", /does not contain SLSA provenance/],
  ["integrity", /does not match the uploaded tarball/],
] as const) {
  test(`post-upload verification rejects invalid ${field} metadata`, async () => {
    const state = fixture();
    if (field === "publisher") state.metadata._npmUser.trustedPublisher.id = "";
    if (field === "provenance")
      state.metadata.dist.attestations.provenance.predicateType = "";
    if (field === "integrity") state.metadata.dist.integrity = "sha512-wrong";
    await assert.rejects(publishRelease(state), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Upload completed.*may already be public/);
      assert.match(error.message, message);
      return true;
    });
    assert.equal(state.npm.publish.mock.calls.length, 1);
  });
}

test("waits for npm publication visibility and verifies without repeating the upload", async () => {
  const state = fixture();
  let now = Date.now();
  const startedAt = now;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.mocked(setTimeout).mockImplementation(async (delay) => {
    now += delay ?? 0;
  });
  const fetch = state.fetch.getMockImplementation();
  assert.ok(fetch);
  const verificationTimes: number[] = [];
  state.fetch.mockImplementation(async (url, options) => {
    if (state.events.includes("publish")) {
      verificationTimes.push(now - startedAt);
      if (now - startedAt < 90_000) return new Response(null, { status: 404 });
    }
    return fetch(url, options);
  });
  await publishRelease(state);
  assert.deepEqual(
    verificationTimes,
    [0, 15_000, 30_000, 45_000, 60_000, 75_000, 90_000],
  );
  assert.equal(state.npm.publish.mock.calls.length, 1);
  const messages = vi.mocked(console.error).mock.calls.flat().map(String).join("\n");
  assert.match(messages, /Upload accepted by npm/);
  assert.match(messages, /HTTP 404.*Retrying in 15 seconds/);
  assert.match(messages, /Verified mcp-filter-proxy@0.1.4/);
});

test("stops verification after three minutes and reports that upload already completed", async () => {
  const state = fixture();
  let now = Date.now();
  const startedAt = now;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.mocked(setTimeout).mockImplementation(async (delay) => {
    now += delay ?? 0;
  });
  const fetch = state.fetch.getMockImplementation();
  assert.ok(fetch);
  let verificationRequests = 0;
  state.fetch.mockImplementation(async (url, options) => {
    if (state.events.includes("publish")) {
      verificationRequests++;
      return new Response(null, { status: 404 });
    }
    return fetch(url, options);
  });
  await assert.rejects(
    publishRelease(state),
    /Upload completed.*within 180 seconds.*HTTP 404.*may already be public/,
  );
  assert.equal(now - startedAt, 180_000);
  assert.equal(verificationRequests, 12);
  assert.equal(state.npm.publish.mock.calls.length, 1);
});

test("slow metadata requests consume the verification deadline", async () => {
  const state = fixture();
  let now = Date.now();
  const startedAt = now;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.mocked(setTimeout).mockImplementation(async (delay) => {
    now += delay ?? 0;
  });
  const fetch = state.fetch.getMockImplementation();
  assert.ok(fetch);
  const verificationSignals: AbortSignal[] = [];
  state.fetch.mockImplementation(async (url, options) => {
    if (state.events.includes("publish")) {
      assert.ok(options?.signal);
      verificationSignals.push(options.signal);
      now += 30_000;
      return new Response(null, { status: 503 });
    }
    return fetch(url, options);
  });
  await assert.rejects(publishRelease(state), /within 180 seconds.*HTTP 503/);
  assert.equal(now - startedAt, 180_000);
  assert.equal(verificationSignals.length, 4);
  assert.equal(state.npm.publish.mock.calls.length, 1);
});

test.skipIf(!process.env.NPM_DIRECTORY)(
  "pinned npm exposes the required publishing and provenance helpers",
  () => {
    const npm = loadNpm(process.env.NPM_DIRECTORY);
    for (const key of ["publish", "generateProvenance", "verifyProvenance"] as const)
      assert.equal(typeof npm[key], "function");
  },
);
