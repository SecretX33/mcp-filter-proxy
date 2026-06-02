export interface ToolFilter {
  allowAll: boolean;
  allowed: Set<string>;
}

export function createToolFilter(allowedTools: Set<string> | null): ToolFilter {
  if (allowedTools === null) {
    return { allowAll: true, allowed: new Set() };
  }
  return { allowAll: false, allowed: allowedTools };
}

export function isToolAllowed(name: string, filter: ToolFilter): boolean {
  return filter.allowAll || filter.allowed.has(name);
}

export function filterToolList<T extends { name: string }>(
  tools: T[],
  filter: ToolFilter,
): T[] {
  if (filter.allowAll) return tools;
  return tools.filter((t) => filter.allowed.has(t.name));
}
