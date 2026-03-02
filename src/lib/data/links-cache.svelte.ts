// Module-level cache for links data (persists across SPA navigations)
let _cache = $state<Array<{ link_name: string; entry_count: number }> | null>(null);

export function getCachedLinks() {
  return _cache;
}

export function setCachedLinks(data: Array<{ link_name: string; entry_count: number }>) {
  _cache = data;
}
