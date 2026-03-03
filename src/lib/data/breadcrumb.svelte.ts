// Breadcrumb override store — allows pages to set human-readable labels
// for path segments (e.g., entry description instead of UUID).

let _overrides = $state<Map<string, string>>(new Map());

export function setBreadcrumbOverride(segment: string, label: string) {
  _overrides = new Map(_overrides).set(segment, label);
}

export function clearBreadcrumbOverride(segment: string) {
  const next = new Map(_overrides);
  next.delete(segment);
  _overrides = next;
}

export function getBreadcrumbOverrides(): Map<string, string> {
  return _overrides;
}
