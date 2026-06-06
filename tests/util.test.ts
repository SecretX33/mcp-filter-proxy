import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PROJECT_INFO, parseUrlStrict } from "../src/util.js";

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

describe("parseUrlStrict", () => {
  describe("accepts valid http(s) URLs", () => {
    it.each([
      ["http://example.com", "http://example.com/"],
      ["https://www.google.com", "https://www.google.com/"],
      ["http://test.com/path/to/resource", "http://test.com/path/to/resource"],
      ["https://api.github.com/users/octocat", "https://api.github.com/users/octocat"],
      [
        "https://subdomain.example.com/page?param=value#section",
        "https://subdomain.example.com/page?param=value#section",
      ],
      ["http://localhost:3000", "http://localhost:3000/"],
      ["http://localhost:3001/mcp", "http://localhost:3001/mcp"],
      ["https://127.0.0.1:8080", "https://127.0.0.1:8080/"],
      ["http://a.com", "http://a.com/"],
    ])("normalizes %s", (input, expected) => {
      expect(parseUrlStrict(input)).toBe(expected);
    });
  });

  describe("rejects unsupported protocols", () => {
    it.each([
      "ftp://example.com/test",
      "ssh://test.com/whoami",
      "telnet://malicious.com/dir",
      "file:///C:/Windows/System32/calc.exe",
      "file://localhost/etc/passwd",
      'javascript:alert("XSS")',
      'javascript:eval("malicious code")',
      "javascript:$(calc.exe)?response_type=code.....",
      'data:text/html,<script>alert("XSS")</script>',
    ])("rejects %s", (url) => {
      expect(() => parseUrlStrict(url)).toThrow(/Invalid upstream URL/);
    });
  });

  describe("rejects malicious or malformed hosts", () => {
    it.each([
      "https://www.$(calc.exe).com/foo",
      "https://www.example.com:$(calc.exe)/foo",
      "https://exam ple.com",
      "not a url",
      "",
    ])("rejects %s", (url) => {
      expect(() => parseUrlStrict(url)).toThrow(/Invalid upstream URL/);
    });
  });

  describe("encodes URL components", () => {
    it("double-encodes special characters in the pathname", () => {
      expect(parseUrlStrict("https://example.com/path with spaces")).toBe(
        "https://example.com/path%2520with%2520spaces",
      );
    });

    it("encodes query parameter values", () => {
      expect(
        parseUrlStrict("https://example.com?key=value with spaces&another=test"),
      ).toBe("https://example.com/?key=value%20with%20spaces&another=test");
    });

    it("double-encodes hash fragments", () => {
      expect(parseUrlStrict("https://example.com#section with spaces")).toBe(
        "https://example.com/#section%2520with%2520spaces",
      );
    });

    it("preserves empty query parameter values", () => {
      expect(parseUrlStrict("https://example.com?empty&hasvalue=test")).toBe(
        "https://example.com/?empty&hasvalue=test",
      );
    });

    it("encodes basic-auth credentials", () => {
      expect(parseUrlStrict("http://user$(calc)r:pass$(calc)word@domain.com")).toBe(
        "http://user%24(calc)r:pass%24(calc)word@domain.com/",
      );
    });
  });

  describe("preserves clean, complex URLs", () => {
    it.each([
      "https://user:pass@example.com:8080/path/to/resource?param=value&other=test#fragment",
      "https://api.example.com/v1/users?limit=10&offset=0#results",
      "https://example.com/api/v1/mcp?tenant=acme",
      "https://user:pass@example.com/secure",
    ])("round-trips %s", (url) => {
      expect(parseUrlStrict(url)).toBe(url);
    });
  });
});
