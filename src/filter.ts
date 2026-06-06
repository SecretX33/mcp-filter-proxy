import picomatch from "picomatch";
import type { KindFilter } from "./config";

export type FilterRule =
  | { mode: "allow-all" }
  | { mode: "allow"; matches: (name: string) => boolean }
  | { mode: "deny"; matches: (name: string) => boolean };

export interface ProxyFilters {
  tools: FilterRule;
  resources: FilterRule;
  prompts: FilterRule;
}

const compile = (patterns: string[]): ((name: string) => boolean) =>
  picomatch(patterns, { dot: true });

export function createFilterRule({ allowed, denied }: KindFilter): FilterRule {
  if (allowed && denied) {
    throw new Error("allow and deny patterns are mutually exclusive");
  }
  if (allowed) return { mode: "allow", matches: compile(allowed) };
  if (denied) return { mode: "deny", matches: compile(denied) };
  return { mode: "allow-all" };
}

export function isAllowed(name: string, rule: FilterRule): boolean {
  if (rule.mode === "allow-all") return true;
  return rule.mode === "allow" ? rule.matches(name) : !rule.matches(name);
}

/** Keep only the items whose key (via `keyOf`) is allowed by the rule. */
export function filterByKey<T>(
  items: T[],
  keyOf: (item: T) => string,
  rule: FilterRule,
): T[] {
  if (rule.mode === "allow-all") return items;
  return items.filter((item) => isAllowed(keyOf(item), rule));
}
