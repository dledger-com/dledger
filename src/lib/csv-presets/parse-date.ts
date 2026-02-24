export type DateFormatId =
  | "YYYY-MM-DD"
  | "MM/DD/YYYY"
  | "DD/MM/YYYY"
  | "DD.MM.YYYY"
  | "YYYY/MM/DD"
  | "YYYYMMDD"
  | "ISO8601"
  | "UNIX_SECONDS"
  | "UNIX_MILLIS";

interface DateFormatDef {
  id: DateFormatId;
  label: string;
  example: string;
  parse(value: string): string | null;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function isValidDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(y, m, 0).getDate();
  return d <= daysInMonth;
}

export const DATE_FORMATS: DateFormatDef[] = [
  {
    id: "YYYY-MM-DD",
    label: "YYYY-MM-DD",
    example: "2024-01-15",
    parse(v) {
      const m = v.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (!m) return null;
      const [, yr, mo, dy] = m;
      const y = parseInt(yr), mn = parseInt(mo), d = parseInt(dy);
      if (!isValidDate(y, mn, d)) return null;
      return `${yr}-${pad2(mn)}-${pad2(d)}`;
    },
  },
  {
    id: "MM/DD/YYYY",
    label: "MM/DD/YYYY",
    example: "01/15/2024",
    parse(v) {
      const m = v.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!m) return null;
      const [, mo, dy, yr] = m;
      const y = parseInt(yr), mn = parseInt(mo), d = parseInt(dy);
      if (!isValidDate(y, mn, d)) return null;
      return `${yr}-${pad2(mn)}-${pad2(d)}`;
    },
  },
  {
    id: "DD/MM/YYYY",
    label: "DD/MM/YYYY",
    example: "15/01/2024",
    parse(v) {
      const m = v.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!m) return null;
      const [, dy, mo, yr] = m;
      const y = parseInt(yr), mn = parseInt(mo), d = parseInt(dy);
      if (!isValidDate(y, mn, d)) return null;
      return `${yr}-${pad2(mn)}-${pad2(d)}`;
    },
  },
  {
    id: "DD.MM.YYYY",
    label: "DD.MM.YYYY",
    example: "15.01.2024",
    parse(v) {
      const m = v.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
      if (!m) return null;
      const [, dy, mo, yr] = m;
      const y = parseInt(yr), mn = parseInt(mo), d = parseInt(dy);
      if (!isValidDate(y, mn, d)) return null;
      return `${yr}-${pad2(mn)}-${pad2(d)}`;
    },
  },
  {
    id: "YYYY/MM/DD",
    label: "YYYY/MM/DD",
    example: "2024/01/15",
    parse(v) {
      const m = v.trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
      if (!m) return null;
      const [, yr, mo, dy] = m;
      const y = parseInt(yr), mn = parseInt(mo), d = parseInt(dy);
      if (!isValidDate(y, mn, d)) return null;
      return `${yr}-${pad2(mn)}-${pad2(d)}`;
    },
  },
  {
    id: "YYYYMMDD",
    label: "YYYYMMDD",
    example: "20240115",
    parse(v) {
      const m = v.trim().match(/^(\d{4})(\d{2})(\d{2})$/);
      if (!m) return null;
      const [, yr, mo, dy] = m;
      const y = parseInt(yr), mn = parseInt(mo), d = parseInt(dy);
      if (!isValidDate(y, mn, d)) return null;
      return `${yr}-${pad2(mn)}-${pad2(d)}`;
    },
  },
  {
    id: "ISO8601",
    label: "ISO 8601 (with time)",
    example: "2024-01-15T10:30:00Z",
    parse(v) {
      const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ]/);
      if (!m) return null;
      const [, yr, mo, dy] = m;
      const y = parseInt(yr), mn = parseInt(mo), d = parseInt(dy);
      if (!isValidDate(y, mn, d)) return null;
      return `${yr}-${pad2(mn)}-${pad2(d)}`;
    },
  },
  {
    id: "UNIX_SECONDS",
    label: "Unix timestamp (seconds)",
    example: "1705312200",
    parse(v) {
      const n = Number(v.trim());
      if (!Number.isFinite(n) || n < 0 || n > 4102444800) return null;
      // Must be in seconds range (before year 2100)
      if (n > 1e11) return null; // looks like millis
      const d = new Date(n * 1000);
      if (isNaN(d.getTime())) return null;
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    },
  },
  {
    id: "UNIX_MILLIS",
    label: "Unix timestamp (milliseconds)",
    example: "1705312200000",
    parse(v) {
      const n = Number(v.trim());
      if (!Number.isFinite(n) || n < 0) return null;
      // Must be in millis range
      if (n < 1e11) return null; // looks like seconds
      const d = new Date(n);
      if (isNaN(d.getTime())) return null;
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    },
  },
];

const FORMAT_MAP = new Map(DATE_FORMATS.map((f) => [f.id, f]));

export function parseDate(value: string, formatId: DateFormatId): string | null {
  const fmt = FORMAT_MAP.get(formatId);
  if (!fmt) return null;
  return fmt.parse(value);
}

export function detectDateFormat(sampleValues: string[]): DateFormatId | null {
  if (sampleValues.length === 0) return null;

  const results: { id: DateFormatId; successes: number }[] = [];

  for (const fmt of DATE_FORMATS) {
    let successes = 0;
    for (const v of sampleValues) {
      if (v.trim() && fmt.parse(v) !== null) successes++;
    }
    results.push({ id: fmt.id, successes });
  }

  // Need 80% success rate
  const nonEmpty = sampleValues.filter((v) => v.trim()).length;
  if (nonEmpty === 0) return null;
  const threshold = nonEmpty * 0.8;

  const passing = results.filter((r) => r.successes >= threshold);
  if (passing.length === 0) return null;

  // If both MM/DD/YYYY and DD/MM/YYYY pass, disambiguate
  const mmdd = passing.find((r) => r.id === "MM/DD/YYYY");
  const ddmm = passing.find((r) => r.id === "DD/MM/YYYY");
  if (mmdd && ddmm) {
    // Look for a value where the first part > 12 (must be day) or second part > 12 (must be day)
    for (const v of sampleValues) {
      const m = v.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!m) continue;
      const first = parseInt(m[1]);
      const second = parseInt(m[2]);
      if (first > 12) return "DD/MM/YYYY"; // first field can't be month
      if (second > 12) return "MM/DD/YYYY"; // second field can't be month
    }
    // If ambiguous, default to MM/DD/YYYY
    return "MM/DD/YYYY";
  }

  // Prefer more specific formats first — ISO8601 over YYYY-MM-DD if both match
  // Sort by specificity: ISO8601 > date-only formats > unix
  const priority: DateFormatId[] = [
    "YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY", "DD.MM.YYYY",
    "YYYY/MM/DD", "YYYYMMDD", "ISO8601", "UNIX_SECONDS", "UNIX_MILLIS",
  ];

  // If ISO8601 passes and YYYY-MM-DD also passes, prefer ISO8601 only if values have time component
  const iso = passing.find((r) => r.id === "ISO8601");
  const ymd = passing.find((r) => r.id === "YYYY-MM-DD");
  if (iso && ymd) {
    const hasTime = sampleValues.some((v) => /T|Z|\d{2}:\d{2}/.test(v));
    if (hasTime) return "ISO8601";
    return "YYYY-MM-DD";
  }

  // Return the first passing format in priority order
  for (const id of priority) {
    if (passing.some((r) => r.id === id)) return id;
  }

  return passing[0].id;
}
