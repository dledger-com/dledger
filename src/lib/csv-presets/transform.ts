import { v7 as uuidv7 } from "uuid";
import type { Backend } from "$lib/backend.js";
import type { Account, AccountType, Currency, JournalEntry, LineItem } from "$lib/types/index.js";
import type { CsvImportResult } from "$lib/utils/csv-import.js";
import type { CsvRecord } from "./types.js";

import { parseDate, type DateFormatId } from "./parse-date.js";
import { parseAmount } from "./parse-amount.js";
import { buildDedupIndex, isDuplicate, computeRecordFingerprint, computeAmountFingerprint } from "./dedup.js";
import { ASSETS_IMPORT, EXPENSES_UNCATEGORIZED, INCOME_UNCATEGORIZED } from "$lib/accounts/paths.js";
import { getBackend } from "$lib/backend.js";
import { taskQueue } from "$lib/task-queue.svelte.js";
import { invalidate } from "$lib/data/invalidation.js";
import { toast } from "svelte-sonner";
import { enqueueRateBackfill } from "$lib/exchange-rate-historical.js";
import type { HistoricalFetchConfig } from "$lib/exchange-rate-historical.js";
import { yieldToUI } from "$lib/utils/yield.js";


export interface ImportOptions {
  signal?: AbortSignal;
  onProgress?: (progress: { current: number; total: number; message?: string }) => void;
}

export interface TransformOptions {
  dateColumn: string;
  dateFormat: DateFormatId;
  descriptionColumn?: string;
  amountColumn?: string;
  debitAmountColumn?: string;
  creditAmountColumn?: string;
  currencyColumn?: string;
  fixedCurrency?: string;
  mainAccount?: string;
  counterAccount?: string;
  europeanNumbers?: boolean;
}

export interface TransformResult {
  records: CsvRecord[];
  warnings: string[];
}

function resolveColumn(headers: string[], row: string[], colName: string): string {
  const idx = headers.indexOf(colName);
  return idx >= 0 ? (row[idx] ?? "") : "";
}

export function transformGeneric(
  headers: string[],
  rows: string[][],
  options: TransformOptions,
): TransformResult {
  const records: CsvRecord[] = [];
  const warnings: string[] = [];
  const european = options.europeanNumbers ?? false;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.length === 0 || (row.length === 1 && row[0] === "")) continue;

    // Parse date
    const rawDate = resolveColumn(headers, row, options.dateColumn);
    const date = parseDate(rawDate, options.dateFormat);
    if (!date) {
      warnings.push(`Row ${i + 2}: invalid date "${rawDate}"`);
      continue;
    }

    // Description
    const description = options.descriptionColumn
      ? resolveColumn(headers, row, options.descriptionColumn) || "CSV Import"
      : "CSV Import";

    // Currency
    const currency = options.fixedCurrency
      ?? (options.currencyColumn
        ? resolveColumn(headers, row, options.currencyColumn) || "USD"
        : "USD");

    // Amount
    let amount: number | null = null;
    if (options.amountColumn) {
      const raw = resolveColumn(headers, row, options.amountColumn);
      amount = parseAmount(raw, european);
    }

    // Split mode: separate debit/credit columns
    if (options.debitAmountColumn || options.creditAmountColumn) {
      let debit = 0;
      let credit = 0;
      if (options.debitAmountColumn) {
        const raw = resolveColumn(headers, row, options.debitAmountColumn);
        if (raw.trim()) debit = parseAmount(raw, european) ?? 0;
      }
      if (options.creditAmountColumn) {
        const raw = resolveColumn(headers, row, options.creditAmountColumn);
        if (raw.trim()) credit = parseAmount(raw, european) ?? 0;
      }
      amount = debit > 0 ? debit : credit > 0 ? -credit : (debit - credit) || null;
    }

    if (amount === null || !Number.isFinite(amount) || amount === 0) {
      warnings.push(`Row ${i + 2}: invalid or zero amount`);
      continue;
    }

    const mainAccount = options.mainAccount ?? ASSETS_IMPORT;
    const counterAccount = options.counterAccount
      ?? (amount > 0 ? EXPENSES_UNCATEGORIZED : INCOME_UNCATEGORIZED);

    records.push({
      date,
      description,
      lines: [
        { account: mainAccount, currency, amount: amount.toString() },
        { account: counterAccount, currency, amount: (-amount).toString() },
      ],
    });
  }

  return { records, warnings };
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
    asset_type: "",
    param: "",
    name: code,
    decimal_places: code.length <= 3 ? 2 : 8,
    is_base: false,
  };
  try {
    await backend.createCurrency(currency);
    counters.currencies++;
  } catch {
    // duplicate
  }
  currencyCache.add(code);
}

export async function importRecords(
  backend: Backend,
  records: CsvRecord[],
  presetId?: string,
  options?: ImportOptions,
): Promise<CsvImportResult> {
  const result: CsvImportResult = {
    entries_created: 0,
    accounts_created: 0,
    currencies_created: 0,
    warnings: [],
    transaction_currency_dates: [],
    duplicates_skipped: 0,
  };

  if (records.length === 0) return result;

  // Build dedup index from existing entries
  const dedupIndex = await buildDedupIndex(backend, records, presetId);

  const existingCurrencies = new Set((await backend.listCurrencies()).map((c) => c.code));
  const existingAccounts = new Map<string, Account>();
  for (const acc of await backend.listAccounts()) {
    existingAccounts.set(acc.full_name, acc);
  }
  const counters = { accounts: 0, currencies: 0 };
  const currencyDateSet = new Set<string>();

  // Group records by groupKey
  const groups = new Map<string, CsvRecord[]>();
  const ungrouped: CsvRecord[] = [];
  for (const rec of records) {
    if (rec.groupKey) {
      const arr = groups.get(rec.groupKey) ?? [];
      arr.push(rec);
      groups.set(rec.groupKey, arr);
    } else {
      ungrouped.push(rec);
    }
  }

  const totalCount = ungrouped.length + groups.size;
  let processed = 0;
  options?.onProgress?.({ current: 0, total: totalCount, message: "Importing records..." });

  // Process ungrouped records individually
  for (const rec of ungrouped) {
    if (options?.signal?.aborted) throw new DOMException("Import cancelled", "AbortError");
    if (isDuplicate(rec, presetId, dedupIndex)) {
      result.duplicates_skipped++;
      processed++;
      options?.onProgress?.({ current: processed, total: totalCount, message: "Importing records..." });
      continue;
    }
    const entryResult = await postRecord(
      backend, rec, presetId, existingCurrencies, existingAccounts,
      counters, currencyDateSet,
    );
    if (entryResult) {
      result.entries_created++;
      // Add to index for intra-batch dedup
      dedupIndex.fingerprints.add(computeRecordFingerprint(rec));
      dedupIndex.amountFingerprints.add(computeAmountFingerprint(rec));
      if (rec.sourceKey && presetId) {
        dedupIndex.sources.add(`csv-import:${presetId}:${rec.sourceKey}`);
      }
    } else {
      result.warnings.push(`Skipped: "${rec.description}" on ${rec.date}`);
    }
    processed++;
    options?.onProgress?.({ current: processed, total: totalCount, message: "Importing records..." });
    if (processed % 10 === 0) await yieldToUI();
  }

  // Process grouped records: merge lines into a single entry
  for (const [, group] of groups) {
    if (options?.signal?.aborted) throw new DOMException("Import cancelled", "AbortError");
    const merged: CsvRecord = {
      date: group[0].date,
      description: group[0].description,
      lines: group.flatMap((r) => r.lines),
      sourceKey: group[0].sourceKey,
      ...(group[0].metadata ? { metadata: group[0].metadata } : {}),
    };
    if (isDuplicate(merged, presetId, dedupIndex)) {
      result.duplicates_skipped++;
      processed++;
      options?.onProgress?.({ current: processed, total: totalCount, message: "Importing records..." });
      continue;
    }
    const entryResult = await postRecord(
      backend, merged, presetId, existingCurrencies, existingAccounts,
      counters, currencyDateSet,
    );
    if (entryResult) {
      result.entries_created++;
      dedupIndex.fingerprints.add(computeRecordFingerprint(merged));
      dedupIndex.amountFingerprints.add(computeAmountFingerprint(merged));
      if (merged.sourceKey && presetId) {
        dedupIndex.sources.add(`csv-import:${presetId}:${merged.sourceKey}`);
      }
    } else {
      result.warnings.push(`Skipped grouped: "${merged.description}" on ${merged.date}`);
    }
    processed++;
    options?.onProgress?.({ current: processed, total: totalCount, message: "Importing records..." });
    if (processed % 10 === 0) await yieldToUI();
  }

  result.accounts_created = counters.accounts;
  result.currencies_created = counters.currencies;
  result.transaction_currency_dates = [...currencyDateSet].map((s) => {
    const [currency, date] = s.split(":");
    return [currency, date] as [string, string];
  });

  return result;
}

async function postRecord(
  backend: Backend,
  rec: CsvRecord,
  presetId: string | undefined,
  existingCurrencies: Set<string>,
  existingAccounts: Map<string, Account>,
  counters: { accounts: number; currencies: number },
  currencyDateSet: Set<string>,
): Promise<boolean> {
  const entryId = uuidv7();
  const lineItems: LineItem[] = [];

  for (const line of rec.lines) {
    await ensureCurrency(backend, line.currency, existingCurrencies, counters);
    const accountId = await ensureAccount(backend, line.account, existingAccounts, counters);

    lineItems.push({
      id: uuidv7(),
      journal_entry_id: entryId,
      account_id: accountId,
      currency: line.currency,
      amount: line.amount,
      lot_id: null,
    });

    if (line.currency !== "USD") {
      currencyDateSet.add(`${line.currency}:${rec.date}`);
    }
  }

  if (lineItems.length === 0) return false;

  // Verify balance
  const sum = lineItems.reduce((s, li) => s + parseFloat(li.amount), 0);
  if (Math.abs(sum) > 0.0001) return false;

  const source = presetId
    ? `csv-import:${presetId}${rec.sourceKey ? `:${rec.sourceKey}` : ""}`
    : "csv-import";

  const entry: JournalEntry = {
    id: entryId,
    date: rec.date,
    description: rec.description,
    status: "confirmed",
    source,
    voided_by: null,
    created_at: new Date().toISOString().slice(0, 10),
  };

  await backend.postJournalEntry(entry, lineItems);

  // Store structured metadata if present
  if (rec.metadata && Object.keys(rec.metadata).length > 0) {
    await backend.setMetadata(entryId, rec.metadata);
  }

  return true;
}

export function enqueueRecordImport(params: {
  key: string;
  label: string;
  records: CsvRecord[];
  presetId?: string;
  postImport?: (backend: Backend, result: CsvImportResult) => Promise<void>;
  rateConfig: HistoricalFetchConfig;
  hiddenCurrencies: Set<string>;
}): string | null {
  const { key, label, records, presetId, postImport, rateConfig, hiddenCurrencies } = params;

  return taskQueue.enqueue({
    key,
    label,
    description: `Importing ${records.length} records`,
    run: async (ctx) => {
      const backend = getBackend();
      const result = await importRecords(backend, records, presetId, {
        signal: ctx.signal,
        onProgress: (p) => ctx.reportProgress(p),
      });

      if (postImport) {
        await postImport(backend, result);
      }

      const skipMsg = result.duplicates_skipped > 0 ? `, ${result.duplicates_skipped} duplicates skipped` : "";
      toast.success(`Imported ${result.entries_created} entries${skipMsg}`);
      if (result.entries_created > 0) invalidate("journal", "accounts", "reports");

      if (result.transaction_currency_dates.length > 0) {
        enqueueRateBackfill(
          taskQueue,
          backend,
          rateConfig,
          hiddenCurrencies,
          result.transaction_currency_dates,
        );
      }

      return {
        summary: `${result.entries_created} entries imported${skipMsg}`,
        data: result,
      };
    },
  });
}
