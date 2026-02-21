export function matchesFilter<T>(item: T, term: string, fields: (keyof T)[]): boolean {
  if (!term) return true;
  const lower = term.toLowerCase();
  return fields.some((f) => {
    const val = item[f];
    return typeof val === "string" && val.toLowerCase().includes(lower);
  });
}
