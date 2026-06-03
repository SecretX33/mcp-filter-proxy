export interface AllowFilter {
  allowAll: boolean;
  allowed: Set<string>;
}

/** Filters applied to each kind of forwarded primitive. */
export interface ProxyFilters {
  tools: AllowFilter;
  resources: AllowFilter;
  prompts: AllowFilter;
}

export function createAllowFilter(allowed: Set<string> | null): AllowFilter {
  if (allowed === null) {
    return { allowAll: true, allowed: new Set() };
  }
  return { allowAll: false, allowed };
}

export function isAllowed(key: string, filter: AllowFilter): boolean {
  return filter.allowAll || filter.allowed.has(key);
}

/** Keep only the items whose key (via `keyOf`) is allowed by the filter. */
export function filterByKey<T>(
  items: T[],
  keyOf: (item: T) => string,
  filter: AllowFilter,
): T[] {
  if (filter.allowAll) return items;
  return items.filter((item) => filter.allowed.has(keyOf(item)));
}
