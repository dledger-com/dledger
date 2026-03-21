/** Metadata key used to store tags on journal entries. */
export const TAGS_META_KEY = "tags";

/** Metadata key used to store a free-form note on journal entries. */
export const NOTE_META_KEY = "note";

const TAG_CHAR_RE = /[^\p{L}\p{N}_-]/gu;

/** Normalize a single tag: trim, lowercase, strip invalid chars. */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(TAG_CHAR_RE, "");
}

/**
 * Parse tags from a metadata string value.
 * Handles both comma-separated ("groceries,food") and beancount "#"-prefixed ("#groceries #food") formats.
 */
export function parseTags(value?: string): string[] {
  if (!value) return [];
  // Detect beancount format: starts with # or contains space-separated #tags
  const isBeancount = /(?:^|\s)#\S/.test(value);
  let raw: string[];
  if (isBeancount) {
    raw = value.split(/\s+/).map((t) => t.replace(/^#+/, ""));
  } else {
    raw = value.split(",");
  }
  return raw.map(normalizeTag).filter((t) => t.length > 0);
}

/** Serialize tags array to comma-separated string for storage. */
export function serializeTags(tags: string[]): string {
  return tags.map(normalizeTag).filter((t) => t.length > 0).join(",");
}

const TAG_COLORS = [
  "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  "bg-pink-100 text-pink-700 dark:bg-pink-950 dark:text-pink-300",
  "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  "bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300",
];

/** Deterministic color class for a tag based on string hash. */
export function tagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = (hash * 31 + tag.charCodeAt(i)) | 0;
  }
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}
