import { describe, it, expect } from "vitest";
import { createToolFilter, filterToolList, isToolAllowed } from "../src/filter.js";

describe("createToolFilter", () => {
  it("returns allow-all filter when allowedTools is null", () => {
    const filter = createToolFilter(null);
    expect(isToolAllowed("anything", filter)).toBe(true);
  });

  it("returns selective filter when allowedTools is a set", () => {
    const filter = createToolFilter(new Set(["read_file", "list_dir"]));
    expect(isToolAllowed("read_file", filter)).toBe(true);
    expect(isToolAllowed("list_dir", filter)).toBe(true);
    expect(isToolAllowed("delete_file", filter)).toBe(false);
  });
});

describe("filterToolList", () => {
  const tools = [
    { name: "read_file", description: "Read", inputSchema: { type: "object" as const } },
    {
      name: "write_file",
      description: "Write",
      inputSchema: { type: "object" as const },
    },
    {
      name: "delete_file",
      description: "Delete",
      inputSchema: { type: "object" as const },
    },
  ];

  it("returns all tools when filter allows everything", () => {
    const filter = createToolFilter(null);
    expect(filterToolList(tools, filter)).toHaveLength(3);
  });

  it("returns only allowed tools", () => {
    const filter = createToolFilter(new Set(["read_file"]));
    const result = filterToolList(tools, filter);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("read_file");
  });

  it("returns empty array when no tools match", () => {
    const filter = createToolFilter(new Set(["nonexistent"]));
    expect(filterToolList(tools, filter)).toHaveLength(0);
  });
});
