import { v7 as uuidv7 } from "uuid";
import type { Backend } from "$lib/backend.js";
import type { Account, AccountType, Currency, JournalEntry, LineItem } from "$lib/types/index.js";

export interface CsvColumnMapping {
  accountColumn: string;     // column name for account, or a fixed account path prefixed with "="
  currencyColumn?: string;   // column name or fixed value prefixed with "="
  amountColumn: string;      // column name
  amountNegate?: boolean;    // negate the amount (e.g. for credit columns)
}

export interface CsvImportOptions {
  delimiter?: string;           // default ","
  dateColumn: string;           // column name
  descriptionColumn?: string;   // column name
  lines: CsvColumnMapping[];    // each maps columns → a line item
  dateFormat?: string;          // "YYYY-MM-DD" (default), "MM/DD/YYYY", "DD/MM/YYYY"
}

export interface CsvImportResult {
  entries_created: number;
  accounts_created: number;
  currencies_created: number;
  warnings: string[];
  transaction_currency_dates: [string, string][];
}

function parseCsvRow(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseDate(value: string, format: string): string | null {
  const v = value.trim();
  if (format === "MM/DD/YYYY") {
    const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  if (format === "DD/MM/YYYY") {
    const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  // Default: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return null;
}

function inferAccountType(fullName: string): AccountType {
  const first = fullName.split(":")[0];
  switch (first) {
    case "Assets": case "Asset": return "asset";
    case "Liabilities": case "Liability": return "liability";
    case "Equity": case "Exchange": return "equity";
    case "Income": case "Revenue": return "revenue";
    case "Expenses": case "Expense": return "expense";
    default: return "expense";
  }
}

async function ensureAccount(
  backend: Backend,
  fullName: string,
  accountCache: Map<string, Account>,
  counters: { accounts: number },
): Promise<string> {
  const existing = accountCache.get(fullName);
  if (existing) return existing.id;

  // Create parent accounts recursively
  const parts = fullName.split(":");
  let parentId: string | null = null;
  for (let i = 1; i <= parts.length; i++) {
    const path = parts.slice(0, i).join(":");
    const cached = accountCache.get(path);
    if (cached) {
      parentId = cached.id;
      continue;
    }
    const account: Account = {
      id: uuidv7(),
      parent_id: parentId,
      account_type: inferAccountType(path),
      name: parts[i - 1],
      full_name: path,
      allowed_currencies: [],
      is_postable: i === parts.length,
      is_archived: false,
      created_at: new Date().toISOString().slice(0, 10),
    };
    await backend.createAccount(account);
    accountCache.set(path, account);
    counters.accounts++;
    parentId = account.id;
  }
  return parentId!;
}

async function ensureCurrency(
  backend: Backend,
  code: string,
  currencyCache: Set<string>,
  counters: { currencies: number },
): Promise<void> {
  if (currencyCache.has(code)) return;
  const currency: Currency = {
    code,
    name: code,
    decimal_places: code.length <= 3 ? 2 : 8,
    is_base: false,
  };
  try {
    await backend.createCurrency(currency);
    counters.currencies++;
  } catch {
    // duplicate - fine
  }
  currencyCache.add(code);
}

export function parseCsv(content: string, delimiter = ","): { headers: string[]; rows: string[][] } {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCsvRow(lines[0], delimiter);
  const rows = lines.slice(1).map((l) => parseCsvRow(l, delimiter));
  return { headers, rows };
}

export async function importCsv(
  backend: Backend,
  content: string,
  options: CsvImportOptions,
): Promise<CsvImportResult> {
  const delimiter = options.delimiter ?? ",";
  const dateFormat = options.dateFormat ?? "YYYY-MM-DD";
  const result: CsvImportResult = {
    entries_created: 0,
    accounts_created: 0,
    currencies_created: 0,
    warnings: [],
    transaction_currency_dates: [],
  };

  const { headers, rows } = parseCsv(content, delimiter);
  if (headers.length === 0) {
    result.warnings.push("Empty CSV file");
    return result;
  }

  const colIndex = new Map<string, number>();
  headers.forEach((h, i) => colIndex.set(h.trim(), i));

  const dateIdx = colIndex.get(options.dateColumn);
  if (dateIdx === undefined) {
    result.warnings.push(`Date column "${options.dateColumn}" not found`);
    return result;
  }
  const descIdx = options.descriptionColumn ? colIndex.get(options.descriptionColumn) : undefined;

  // Build caches
  const existingCurrencies = new Set((await backend.listCurrencies()).map((c) => c.code));
  const existingAccounts = new Map<string, Account>();
  for (const acc of await backend.listAccounts()) {
    existingAccounts.set(acc.full_name, acc);
  }
  const counters = { accounts: 0, currencies: 0 };

  const currencyDateSet = new Set<string>();

  for (let rowNum = 0; rowNum < rows.length; rowNum++) {
    const row = rows[rowNum];
    if (row.length === 0 || (row.length === 1 && row[0] === "")) continue;

    // Parse date
    const rawDate = row[dateIdx] ?? "";
    const date = parseDate(rawDate, dateFormat);
    if (!date) {
      result.warnings.push(`Row ${rowNum + 2}: invalid date "${rawDate}"`);
      continue;
    }

    const description = descIdx !== undefined ? (row[descIdx] ?? "CSV Import") : "CSV Import";

    const entryId = uuidv7();
    const lineItems: LineItem[] = [];

    for (const mapping of options.lines) {
      // Resolve account
      let accountFullName: string;
      if (mapping.accountColumn.startsWith("=")) {
        accountFullName = mapping.accountColumn.slice(1);
      } else {
        const accIdx = colIndex.get(mapping.accountColumn);
        if (accIdx === undefined) {
          result.warnings.push(`Row ${rowNum + 2}: account column "${mapping.accountColumn}" not found`);
          continue;
        }
        accountFullName = row[accIdx] ?? "";
      }
      if (!accountFullName) continue;

      // Resolve currency
      let currency: string;
      if (mapping.currencyColumn) {
        if (mapping.currencyColumn.startsWith("=")) {
          currency = mapping.currencyColumn.slice(1);
        } else {
          const curIdx = colIndex.get(mapping.currencyColumn);
          currency = curIdx !== undefined ? (row[curIdx] ?? "USD") : "USD";
        }
      } else {
        currency = "USD";
      }

      // Resolve amount
      const amtIdx = colIndex.get(mapping.amountColumn);
      if (amtIdx === undefined) {
        result.warnings.push(`Row ${rowNum + 2}: amount column "${mapping.amountColumn}" not found`);
        continue;
      }
      let amountStr = (row[amtIdx] ?? "").replace(/[,$]/g, "");
      if (!amountStr || isNaN(parseFloat(amountStr))) {
        result.warnings.push(`Row ${rowNum + 2}: invalid amount "${row[amtIdx]}"`);
        continue;
      }
      let amount = parseFloat(amountStr);
      if (mapping.amountNegate) amount = -amount;

      // Ensure account + currency exist
      await ensureCurrency(backend, currency, existingCurrencies, counters);
      const accountId = await ensureAccount(backend, accountFullName, existingAccounts, counters);

      lineItems.push({
        id: uuidv7(),
        journal_entry_id: entryId,
        account_id: accountId,
        currency,
        amount: amount.toString(),
        lot_id: null,
      });

      // Track currency dates for rate backfill
      if (currency !== "USD") {
        currencyDateSet.add(`${currency}:${date}`);
      }
    }

    if (lineItems.length === 0) continue;

    // Verify that amounts balance (sum to 0)
    const sum = lineItems.reduce((s, li) => s + parseFloat(li.amount), 0);
    if (Math.abs(sum) > 0.0001) {
      result.warnings.push(`Row ${rowNum + 2}: amounts don't balance (sum=${sum.toFixed(4)}). Skipping.`);
      continue;
    }

    const entry: JournalEntry = {
      id: entryId,
      date,
      description,
      status: "confirmed",
      source: "csv-import",
      voided_by: null,
      created_at: new Date().toISOString().slice(0, 10),
    };

    await backend.postJournalEntry(entry, lineItems);
    result.entries_created++;
  }

  result.accounts_created = counters.accounts;
  result.currencies_created = counters.currencies;
  result.transaction_currency_dates = [...currencyDateSet].map((s) => {
    const [currency, date] = s.split(":");
    return [currency, date] as [string, string];
  });

  return result;
}
