/**
 * Resolve `include` directives in ledger file content.
 * Used for browser-based multi-file import (zip or multi-file selection).
 */

const INCLUDE_RE = /^include\s+["']?([^"'\n]+?)["']?\s*$/gm;
const MAX_DEPTH = 10;

/**
 * Recursively resolve `include` directives against a file map.
 * @param content The main file content
 * @param fileMap Map of filename → content (e.g. from zip or multi-file selection)
 * @param depth Current recursion depth (prevents infinite loops)
 * @returns Resolved content with includes replaced by file contents
 */
export function resolveIncludes(
  content: string,
  fileMap: Map<string, string>,
  depth = 0,
): string {
  if (depth > MAX_DEPTH) return content;
  return content.replace(INCLUDE_RE, (_, path: string) => {
    const normalized = path.trim();
    // Try exact match first, then basename match
    const resolved =
      fileMap.get(normalized) ??
      fileMap.get(basename(normalized));
    if (resolved === undefined) {
      return `; WARNING: included file not found: ${normalized}`;
    }
    return resolveIncludes(resolved, fileMap, depth + 1);
  });
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.substring(idx + 1) : path;
}

/** File extensions accepted for ledger import from zip archives. */
export const LEDGER_EXTENSIONS = new Set([
  ".beancount",
  ".journal",
  ".ledger",
  ".hledger",
  ".txt",
]);

/**
 * Filter and sort ledger files from a zip file map.
 * @param entries Map of filename → content
 * @returns Sorted array of [filename, content] pairs
 */
export function filterLedgerFiles(
  entries: Map<string, string>,
): [string, string][] {
  return [...entries.entries()]
    .filter(([name]) => {
      const ext = name.substring(name.lastIndexOf(".")).toLowerCase();
      return LEDGER_EXTENSIONS.has(ext);
    })
    .sort(([a], [b]) => a.localeCompare(b));
}
