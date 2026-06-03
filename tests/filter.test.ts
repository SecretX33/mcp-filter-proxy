import { describe, it, expect } from "vitest";
import { createAllowFilter, filterByKey, isAllowed } from "../src/filter.js";

describe("createAllowFilter / isAllowed", () => {
  it("allows everything when the allowlist is null", () => {
    const filter = createAllowFilter(null);
    expect(isAllowed("anything", filter)).toBe(true);
  });

  it("allows only the listed keys when the allowlist is a set", () => {
    const filter = createAllowFilter(new Set(["read_file", "list_dir"]));
    expect(isAllowed("read_file", filter)).toBe(true);
    expect(isAllowed("list_dir", filter)).toBe(true);
    expect(isAllowed("delete_file", filter)).toBe(false);
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

  it("returns all items when the filter allows everything", () => {
    expect(filterByKey(tools, byName, createAllowFilter(null))).toHaveLength(3);
  });

  it("filters by a name key", () => {
    const result = filterByKey(tools, byName, createAllowFilter(new Set(["read_file"])));
    expect(result.map((t) => t.name)).toEqual(["read_file"]);
  });

  it("filters by a uri key", () => {
    const result = filterByKey(
      resources,
      byUri,
      createAllowFilter(new Set(["test://b"])),
    );
    expect(result.map((r) => r.uri)).toEqual(["test://b"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterByKey(tools, byName, createAllowFilter(new Set(["nope"])))).toHaveLength(
      0,
    );
  });
});
