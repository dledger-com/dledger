export type LedgerFormat = "ledger" | "beancount" | "hledger";

/**
 * Auto-detect ledger file format by scoring the first ~50 non-empty, non-comment lines.
 * Returns "beancount" or "hledger" if confident, otherwise "ledger" (the default).
 */
export function detectFormat(content: string): LedgerFormat {
  let bc = 0;
  let hl = 0;
  let scanned = 0;

  const lines = content.split("\n");
  for (const raw of lines) {
    if (scanned >= 50) break;
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    scanned++;

    // Beancount signals
    // `txn` keyword after date
    if (/^\d{4}[-/]\d{2}[-/]\d{2}\s+txn\b/.test(line)) {
      bc += 5;
    }
    // `option "` or `plugin "` directive
    if (/^(option|plugin)\s+"/.test(line)) {
      bc += 5;
    }
    // Quoted description after date + status
    if (/^\d{4}[-/]\d{2}[-/]\d{2}\s+[*!]\s+"/.test(line)) {
      bc += 3;
    }
    // `open` / `close` / `balance` after date (shared with dledger, mild beancount signal)
    if (/^\d{4}[-/]\d{2}[-/]\d{2}\s+(open|close|balance)\s/.test(line)) {
      bc += 2;
    }
    // `{cost}` lot syntax in posting
    if (/\{[^}]*\}/.test(line) && /^\s/.test(raw)) {
      bc += 3;
    }

    // hledger signals
    // YYYY/MM/DD date format (hledger/ledger-cli style)
    if (/^\d{4}\/\d{2}\/\d{2}\s/.test(line)) {
      hl += 3;
    }
    // `account` directive (no date prefix)
    if (/^account\s+\S/.test(line)) {
      hl += 5;
    }
    // `commodity` directive (no date prefix)
    if (/^commodity\s+\S/.test(line)) {
      hl += 3;
    }
    // Inline `=` balance assertion in posting
    if (/^\s+\S.*\s+=\s/.test(raw)) {
      hl += 5;
    }
    // Prefix currency symbol ($, EUR before amount) in posting
    if (/^\s+\S+.*\s+[\$€£]\d/.test(raw) || /^\s+\S+.*\s+[A-Z]{3}\s+[\-\d]/.test(raw)) {
      hl += 3;
    }
  }

  if (bc > hl && bc >= 3) return "beancount";
  if (hl > bc && hl >= 3) return "hledger";
  return "ledger";
}

/** Return the conventional file extension for a format. */
export function formatExtension(format: LedgerFormat): string {
  switch (format) {
    case "beancount":
      return ".beancount";
    case "hledger":
      return ".journal";
    case "ledger":
      return ".ledger";
  }
}

/** Human-readable label for display. */
export function formatLabel(format: LedgerFormat): string {
  switch (format) {
    case "beancount":
      return "Beancount";
    case "hledger":
      return "hledger";
    case "ledger":
      return "Ledger";
  }
}
