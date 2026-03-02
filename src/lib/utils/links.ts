const LINK_CHAR_RE = /[^\p{L}\p{N}_-]/gu;

/** Normalize a single link: trim, lowercase, strip ^ prefix, strip invalid chars. */
export function normalizeLink(link: string): string {
  return link.trim().toLowerCase().replace(/^\^+/, "").replace(LINK_CHAR_RE, "");
}

/**
 * Parse links from a string value.
 * Handles beancount "^"-prefixed format: "^link1 ^link2"
 */
export function parseLinks(value?: string): string[] {
  if (!value) return [];
  const raw = value.split(/\s+/).map((l) => l.replace(/^\^+/, ""));
  return raw.map(normalizeLink).filter((l) => l.length > 0);
}

/** Serialize links array to beancount format for export: "^a ^b" */
export function serializeLinksForExport(links: string[]): string {
  return links
    .map(normalizeLink)
    .filter((l) => l.length > 0)
    .map((l) => `^${l}`)
    .join(" ");
}

const LINK_COLORS = [
  "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950 dark:text-fuchsia-300",
  "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  "bg-lime-100 text-lime-700 dark:bg-lime-950 dark:text-lime-300",
  "bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300",
  "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
];

/** Deterministic color class for a link based on string hash (different palette than tags). */
export function linkColor(link: string): string {
  let hash = 0;
  for (let i = 0; i < link.length; i++) {
    hash = (hash * 37 + link.charCodeAt(i)) | 0;
  }
  return LINK_COLORS[Math.abs(hash) % LINK_COLORS.length];
}
