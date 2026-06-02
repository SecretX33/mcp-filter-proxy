import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PROJECT_INFO } from "../src/util.js";

const packageJson = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf-8",
  ),
) as { name: string; version: string };

describe("PROJECT_INFO", () => {
  it("exposes a non-empty name and version", () => {
    expect(PROJECT_INFO.name.length).toBeGreaterThan(0);
    expect(PROJECT_INFO.version.length).toBeGreaterThan(0);
  });

  it("matches the values in package.json", () => {
    expect(PROJECT_INFO.name).toBe(packageJson.name);
    expect(PROJECT_INFO.version).toBe(packageJson.version);
  });
});
