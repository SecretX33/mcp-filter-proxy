import { dirname, join } from "path";
import { fileURLToPath } from "url";
import * as fs from "node:fs";

// Load name/version from package.json (works from dist/ after tsdown)
const __dirname = dirname(fileURLToPath(import.meta.url));

export const PROJECT_INFO = JSON.parse(
  fs.readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
) as { name: string; version: string };

/**
 * Parse `raw` as an http(s) URL, rejecting any other scheme, and return a sanitized url with every
 * component percent-encoded, or throws if it's not a valid http(s) URL.
 */
export function parseUrlStrict(raw: string): string {
  const abort = (): never => {
    throw new Error(`Invalid upstream URL: ${raw}`);
  };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return abort();
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") abort();
  // Hostnames can't be re-encoded in place; reject if anything looks suspicious.
  if (url.hostname !== encodeURIComponent(url.hostname)) abort();
  if (url.username) url.username = encodeURIComponent(url.username);
  if (url.password) url.password = encodeURIComponent(url.password);
  url.pathname =
    url.pathname.slice(0, 1) +
    encodeURIComponent(url.pathname.slice(1)).replace(/%2f/gi, "/");
  url.search =
    url.search.slice(0, 1) +
    Array.from(url.searchParams.entries()).map(sanitizeParam).join("&");
  url.hash = url.hash.slice(0, 1) + encodeURIComponent(url.hash.slice(1));
  return url.href;
}

function sanitizeParam([k, v]: [string, string]): string {
  return `${encodeURIComponent(k)}${v.length > 0 ? `=${encodeURIComponent(v)}` : ""}`;
}
