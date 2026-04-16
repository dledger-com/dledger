export type QifAccountType = "Bank" | "CCard" | "Cash" | "Oth A" | "Oth L" | "Invst" | "Memorized";

export type QifDateFormat = "MM/DD/YY" | "DD/MM/YY" | "DD.MM.YY";

export interface QifAccountHeader {
  name: string;
  type: QifAccountType;
  description?: string;
}

export interface QifSplitLine {
  category: string;
  memo?: string;
  amount: string;
}

export interface QifTransaction {
  date: string;
  amount: string;
  amountU?: string;
  payee?: string;
  memo?: string;
  checkNum?: string;
  cleared?: string;
  category?: string;
  address?: string[];
  splits: QifSplitLine[];
}

export interface QifSection {
  account?: QifAccountHeader;
  type: QifAccountType;
  transactions: QifTransaction[];
}

export interface QifParseResult {
  sections: QifSection[];
  warnings: string[];
}

const SUPPORTED_TYPES = new Set<string>(["Bank", "CCard", "Cash", "Oth A", "Oth L"]);
const SKIPPED_TYPES = new Set<string>(["Invst", "Memorized", "Cat", "Class"]);

/**
 * Detect whether a category string is a transfer (enclosed in brackets).
 */
export function isTransfer(category: string): { isTransfer: true; accountName: string } | { isTransfer: false } {
  const trimmed = category.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return { isTransfer: true, accountName: trimmed.slice(1, -1) };
  }
  return { isTransfer: false };
}

/**
 * Parse a QIF date string to YYYY-MM-DD.
 *
 * Handles:
 * - MM/DD/YY, MM/DD/YYYY (US)
 * - MM/DD'YY (apostrophe for 2000s)
 * - DD/MM/YY, DD/MM/YYYY (European slash)
 * - DD.MM.YY, DD.MM.YYYY (European dot)
 * - DD-MM-YY, DD-MM-YYYY (European dash)
 */
export function parseQifDate(raw: string, format: QifDateFormat): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let part1: string;
  let part2: string;
  let part3: string;

  // Handle apostrophe notation: M/D'YY → M/D/YY
  const normalized = trimmed.replace("'", "/");

  // Split on separators: / . -
  const parts = normalized.split(/[/.\-]/);
  if (parts.length !== 3) return null;

  [part1, part2, part3] = parts;

  const n1 = parseInt(part1, 10);
  const n2 = parseInt(part2, 10);
  let yearRaw = parseInt(part3, 10);
  if (isNaN(n1) || isNaN(n2) || isNaN(yearRaw)) return null;

  // Resolve 2-digit year
  let year: number;
  if (yearRaw < 100) {
    year = yearRaw < 50 ? 2000 + yearRaw : 1900 + yearRaw;
  } else {
    year = yearRaw;
  }

  let month: number;
  let day: number;

  if (format === "MM/DD/YY") {
    month = n1;
    day = n2;
  } else {
    // DD/MM/YY or DD.MM.YY
    day = n1;
    month = n2;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/**
 * Auto-detect date format by scanning all D fields.
 * Returns a format when unambiguous, defaults to MM/DD/YY when ambiguous.
 */
export function detectQifDateFormat(transactions: QifTransaction[]): QifDateFormat {
  let mustBeMonthFirst = false;
  let mustBeDayFirst = false;
  let hasDotSep = false;

  for (const tx of transactions) {
    const raw = tx.date.trim().replace("'", "/");
    const parts = raw.split(/[/.\-]/);
    if (parts.length !== 3) continue;

    // Check separator
    if (raw.includes(".")) hasDotSep = true;

    const n1 = parseInt(parts[0], 10);
    const n2 = parseInt(parts[1], 10);
    if (isNaN(n1) || isNaN(n2)) continue;

    // If first position > 12, it can't be a month → must be day-first
    if (n1 > 12) mustBeDayFirst = true;
    // If second position > 12, it can't be a month → must be month-first
    if (n2 > 12) mustBeMonthFirst = true;
  }

  // Contradiction — both positions had values > 12 → malformed data, default to US
  if (mustBeMonthFirst && mustBeDayFirst) return "MM/DD/YY";

  if (mustBeDayFirst) return hasDotSep ? "DD.MM.YY" : "DD/MM/YY";
  if (mustBeMonthFirst) return "MM/DD/YY";

  // All ambiguous — default to US convention (QIF is US-origin)
  return "MM/DD/YY";
}

function parseAccountType(raw: string): QifAccountType | null {
  const trimmed = raw.trim();
  // Handle !Type: prefix
  if (trimmed === "Bank" || trimmed === "CCard" || trimmed === "Cash" ||
      trimmed === "Oth A" || trimmed === "Oth L" || trimmed === "Invst" ||
      trimmed === "Memorized" || trimmed === "Cat" || trimmed === "Class") {
    return trimmed as QifAccountType;
  }
  return null;
}

function parseTransaction(lines: string[]): QifTransaction | null {
  let date = "";
  let amount = "";
  let amountU: string | undefined;
  let payee: string | undefined;
  let memo: string | undefined;
  let checkNum: string | undefined;
  let cleared: string | undefined;
  let category: string | undefined;
  const address: string[] = [];
  const splits: QifSplitLine[] = [];

  // Temporary split accumulator
  let splitCat: string | undefined;
  let splitMemo: string | undefined;

  for (const line of lines) {
    if (line.length === 0) continue;
    const code = line[0];
    const value = line.slice(1);

    switch (code) {
      case "D": date = value; break;
      case "T": amount = value.replace(/,/g, ""); break; // Strip US thousand separators from raw
      case "U": amountU = value.replace(/,/g, ""); break;
      case "P": payee = value; break;
      case "M": memo = value; break;
      case "N": checkNum = value; break;
      case "C": cleared = value; break;
      case "L": category = value; break;
      case "A": address.push(value); break;
      case "S": {
        // Flush previous split if any
        if (splitCat !== undefined) {
          splits.push({ category: splitCat, memo: splitMemo, amount: "" });
        }
        splitCat = value;
        splitMemo = undefined;
        break;
      }
      case "E": splitMemo = value; break;
      case "$": {
        if (splitCat !== undefined) {
          splits.push({ category: splitCat, memo: splitMemo, amount: value.replace(/,/g, "") });
          splitCat = undefined;
          splitMemo = undefined;
        }
        break;
      }
    }
  }

  // Flush last split if $ was missing
  if (splitCat !== undefined) {
    splits.push({ category: splitCat, memo: splitMemo, amount: "" });
  }

  // Date and amount are required
  if (!date || !amount) return null;

  const tx: QifTransaction = { date, amount, splits };
  if (amountU) tx.amountU = amountU;
  if (payee) tx.payee = payee;
  if (memo) tx.memo = memo;
  if (checkNum) tx.checkNum = checkNum;
  if (cleared) tx.cleared = cleared;
  if (category) tx.category = category;
  if (address.length > 0) tx.address = address;

  return tx;
}

function parseAccountHeader(lines: string[]): QifAccountHeader | null {
  let name = "";
  let type: QifAccountType = "Bank";
  let description: string | undefined;

  for (const line of lines) {
    if (line.length === 0) continue;
    const code = line[0];
    const value = line.slice(1);

    switch (code) {
      case "N": name = value; break;
      case "T": {
        const parsed = parseAccountType(value);
        if (parsed) type = parsed;
        break;
      }
      case "D": description = value; break;
    }
  }

  if (!name) return null;

  const header: QifAccountHeader = { name, type };
  if (description) header.description = description;
  return header;
}

/**
 * Parse a QIF file into structured sections.
 */
export function parseQif(content: string): QifParseResult {
  const warnings: string[] = [];
  const sections: QifSection[] = [];

  // Normalize line endings
  const normalized = content.replace(/\r\n?/g, "\n");

  // Split into lines for processing
  const allLines = normalized.split("\n");

  let currentAccount: QifAccountHeader | undefined;
  let currentType: QifAccountType | null = null;
  let currentTransactions: QifTransaction[] = [];
  let recordLines: string[] = [];
  let inAccountBlock = false;
  let accountBlockLines: string[] = [];

  function flushSection(): void {
    if (currentType && SUPPORTED_TYPES.has(currentType) && currentTransactions.length > 0) {
      sections.push({
        account: currentAccount,
        type: currentType,
        transactions: currentTransactions,
      });
    }
    currentTransactions = [];
  }

  function flushRecord(): void {
    if (recordLines.length > 0) {
      const tx = parseTransaction(recordLines);
      if (tx) {
        currentTransactions.push(tx);
      } else if (recordLines.some((l) => l.length > 0)) {
        warnings.push(`Skipped malformed record (missing date or amount)`);
      }
      recordLines = [];
    }
  }

  function flushAccountBlock(): void {
    if (accountBlockLines.length > 0) {
      const header = parseAccountHeader(accountBlockLines);
      if (header) {
        currentAccount = header;
      }
      accountBlockLines = [];
    }
    inAccountBlock = false;
  }

  for (const rawLine of allLines) {
    const line = rawLine.trimEnd();

    // Check for section headers
    if (line.startsWith("!")) {
      if (line.startsWith("!Type:")) {
        // Flush any previous section
        if (inAccountBlock) flushAccountBlock();
        flushRecord();
        flushSection();

        const typeName = line.slice(6).trim();
        const parsed = parseAccountType(typeName);

        if (parsed && SKIPPED_TYPES.has(parsed)) {
          // Count transactions in skipped section to report
          let skippedCount = 0;
          // We'll handle this by setting currentType to null and counting ^ separators
          currentType = null;
          // Warn about skipped type
          if (parsed === "Invst") {
            // Count will be added when we hit the next section header
            warnings.push(`Skipped investment account section (not yet supported)`);
          } else if (parsed === "Memorized") {
            warnings.push(`Skipped memorized transactions section`);
          }
          // Cat/Class are silently skipped
          continue;
        } else if (parsed && SUPPORTED_TYPES.has(parsed)) {
          currentType = parsed;
          // If no explicit !Account preceded this, derive account from type
          if (!currentAccount) {
            currentAccount = undefined;
          }
        } else {
          warnings.push(`Unknown section type: "${typeName}"`);
          currentType = null;
        }
        continue;
      }

      if (line === "!Account") {
        // Flush previous section
        flushRecord();
        flushSection();
        inAccountBlock = true;
        accountBlockLines = [];
        continue;
      }

      // Other ! headers (e.g., !Option, !Clear:AutoSwitch) — ignore
      continue;
    }

    // Record separator
    if (line === "^") {
      if (inAccountBlock) {
        flushAccountBlock();
      } else if (currentType && SUPPORTED_TYPES.has(currentType)) {
        flushRecord();
      }
      continue;
    }

    // Accumulate lines
    if (inAccountBlock) {
      accountBlockLines.push(line);
    } else if (currentType && SUPPORTED_TYPES.has(currentType)) {
      recordLines.push(line);
    }
  }

  // Flush remaining
  if (inAccountBlock) flushAccountBlock();
  flushRecord();
  flushSection();

  if (sections.length === 0 && warnings.length === 0) {
    warnings.push("No supported transaction data found in QIF file");
  }

  return { sections, warnings };
}
