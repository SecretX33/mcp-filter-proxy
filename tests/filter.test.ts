import { describe, it, expect } from "vitest";
import { createFilterRule, filterByKey, isAllowed } from "../src/filter.js";

describe("createFilterRule / isAllowed", () => {
  it("allows everything when neither list is set", () => {
    const rule = createFilterRule(null, null);
    expect(rule.mode).toBe("allow-all");
    expect(isAllowed("anything", rule)).toBe(true);
  });

  it("allows only the listed names in allow mode", () => {
    const rule = createFilterRule(["read_file", "list_dir"], null);
    expect(isAllowed("read_file", rule)).toBe(true);
    expect(isAllowed("list_dir", rule)).toBe(true);
    expect(isAllowed("delete_file", rule)).toBe(false);
  });

  it("blocks the listed names in deny mode and allows the rest", () => {
    const rule = createFilterRule(null, ["delete_file"]);
    expect(isAllowed("delete_file", rule)).toBe(false);
    expect(isAllowed("read_file", rule)).toBe(true);
  });

  it("matches glob patterns (prefix, suffix, contains)", () => {
    const allow = createFilterRule(["read_*", "*_meta", "*search*"], null);
    expect(isAllowed("read_file", allow)).toBe(true);
    expect(isAllowed("page_meta", allow)).toBe(true);
    expect(isAllowed("jira_search_v2", allow)).toBe(true);
    expect(isAllowed("write_file", allow)).toBe(false);

    const deny = createFilterRule(null, ["*delete*"]);
    expect(isAllowed("hard_delete_all", deny)).toBe(false);
    expect(isAllowed("read_file", deny)).toBe(true);
  });

  it("throws when both allow and deny are given", () => {
    expect(() => createFilterRule(["a"], ["b"])).toThrow(/mutually exclusive/);
  });
});

describe("filterByKey", () => {
  const byName = <T extends { name: string }>(t: T) => t.name;
  const byUri = <T extends { uri: string }>(r: T) => r.uri;

  const tools = [{ name: "read_file" }, { name: "write_file" }, { name: "delete_file" }];
  const resources = [
    { uri: "test://a", name: "a" },
    { uri: "test://b", name: "b" },
  ];

  it("returns all items when the rule allows everything", () => {
    expect(filterByKey(tools, byName, createFilterRule(null, null))).toHaveLength(3);
  });

  it("keeps only allowed names", () => {
    const result = filterByKey(tools, byName, createFilterRule(["read_file"], null));
    expect(result.map((t) => t.name)).toEqual(["read_file"]);
  });

  it("drops denied names", () => {
    const result = filterByKey(tools, byName, createFilterRule(null, ["*_file"]));
    expect(result.map((t) => t.name)).toEqual([]);
  });

  it("filters by a uri key with a glob", () => {
    const result = filterByKey(resources, byUri, createFilterRule(["test://b"], null));
    expect(result.map((r) => r.uri)).toEqual(["test://b"]);
  });

  it("returns an empty array when nothing matches an allowlist", () => {
    expect(filterByKey(tools, byName, createFilterRule(["nope"], null))).toHaveLength(0);
  });
});
