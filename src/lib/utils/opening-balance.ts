/**
 * Shared helper for posting "opening balance" journal entries.
 *
 * An opening-balance entry represents a pre-dledger crypto holding. It carries
 * the crypto position in its line items AND, optionally, a declared EUR cost
 * basis via `description_data.costEUR`. When `costEUR` is set, the French tax
 * engine treats the entry as a pre-dledger acquisition (contributes to column A
 * of form 2086). When unset, it's a pure "pad" — the crypto appears in the
 * portfolio but no cost basis is declared.
 *
 * Used from both the Accounts page (when creating an asset account with an
 * opening balance) and the French tax page (where the user explicitly declares
 * pre-dledger acquisitions).
 */
import { v7 as uuidv7 } from "uuid";
import type { Backend } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import { renderDescription, openingBalanceDescription } from "../types/description-data.js";

export const OPENING_BALANCE_SOURCE = "system:opening-balance";
export const OPENING_BALANCE_EQUITY_PATH = "Equity:Opening-Balances";

export interface OpeningBalancePosition {
  accountId: string;
  currency: string;
  /** Decimal string. Positive = asset entering the account. */
  quantity: string;
}

export interface PostOpeningBalanceOptions {
  date: string;
  positions: OpeningBalancePosition[];
  /** Optional EUR cost basis. If set and > 0, classified as a pre-dledger
   *  acquisition by the French tax engine. */
  costEUR?: string;
  note?: string;
}

/**
 * Ensure the `Equity:Opening-Balances` account exists, creating it (and any
 * missing parents) if necessary. Returns the postable account id.
 */
export async function ensureOpeningBalancesAccount(
  backend: Backend,
  date: string,
): Promise<string> {
  const allAccounts = await backend.listAccounts();
  const existing = allAccounts.find(a => a.full_name === OPENING_BALANCE_EQUITY_PATH);
  if (existing) return existing.id;

  const parts = OPENING_BALANCE_EQUITY_PATH.split(":");
  let parentId: string | null = null;
  let resultId = "";
  for (let depth = 1; depth <= parts.length; depth++) {
    const path = parts.slice(0, depth).join(":");
    const ancestor = allAccounts.find(a => a.full_name === path);
    if (ancestor) {
      parentId = ancestor.id;
      continue;
    }
    const newId = uuidv7();
    const acc: Account = {
      id: newId,
      parent_id: parentId,
      account_type: "equity",
      name: parts[depth - 1],
      full_name: path,
      allowed_currencies: [],
      is_postable: depth === parts.length,
      is_archived: false,
      created_at: date,
    };
    await backend.createAccount(acc);
    parentId = newId;
    if (depth === parts.length) resultId = newId;
  }
  return resultId;
}

/**
 * Post an opening-balance journal entry. Returns the entry id.
 *
 * When `costEUR` is set and non-zero, the entry is also wired into the French
 * tax chain: persisted reports for years ≥ entry.year are deleted so the
 * engine recomputes A with the new contribution.
 */
export async function postOpeningBalanceEntry(
  backend: Backend,
  opts: PostOpeningBalanceOptions,
): Promise<string> {
  if (opts.positions.length === 0) {
    throw new Error("postOpeningBalanceEntry: at least one position is required");
  }

  const equityId = await ensureOpeningBalancesAccount(backend, opts.date);
  const now = new Date().toISOString();
  const entryId = uuidv7();
  const hasCost = !!opts.costEUR && opts.costEUR !== "0" && opts.costEUR.trim() !== "";

  const descData = openingBalanceDescription(
    hasCost ? opts.costEUR : undefined,
    opts.note?.trim() || undefined,
  );

  const items: LineItem[] = [];
  for (const pos of opts.positions) {
    if (!pos.currency || !pos.quantity || pos.quantity === "0") continue;
    const currency = pos.currency.trim().toUpperCase();
    // Asset side: +quantity currency
    items.push({
      id: uuidv7(),
      journal_entry_id: entryId,
      account_id: pos.accountId,
      currency,
      amount: pos.quantity,
      lot_id: null,
    });
    // Equity counter: -quantity currency
    items.push({
      id: uuidv7(),
      journal_entry_id: entryId,
      account_id: equityId,
      currency,
      amount: String(-Number(pos.quantity)),
      lot_id: null,
    });
  }

  if (items.length === 0) {
    throw new Error("postOpeningBalanceEntry: no valid positions");
  }

  const entry: JournalEntry = {
    id: entryId,
    date: opts.date,
    description: renderDescription(descData),
    description_data: JSON.stringify(descData),
    status: "confirmed",
    source: OPENING_BALANCE_SOURCE,
    voided_by: null,
    created_at: now,
  };

  await backend.postJournalEntry(entry, items);

  if (hasCost) {
    await invalidateFrenchTaxChainFromYear(backend, entry.date);
  }

  return entryId;
}

/**
 * Delete all persisted French tax reports for years ≥ entry.date.year.
 * Called after creating, editing, or deleting an opening-balance entry with
 * declared cost so the chain stays consistent.
 */
export async function invalidateFrenchTaxChainFromYear(
  backend: Backend,
  fromDate: string,
): Promise<void> {
  const year = parseInt(fromDate.slice(0, 4), 10);
  if (isNaN(year)) return;
  const years = await backend.listFrenchTaxReportYears();
  for (const y of years) {
    if (y >= year) {
      await backend.deleteFrenchTaxReport(y);
    }
  }
}

/**
 * List all opening-balance entries (with their line items) sorted by date.
 */
export async function listOpeningBalanceEntries(
  backend: Backend,
): Promise<[JournalEntry, LineItem[]][]> {
  const all = await backend.queryJournalEntries({ source: OPENING_BALANCE_SOURCE });
  return all
    .filter(([entry]) => entry.status === "confirmed")
    .sort((a, b) => a[0].date.localeCompare(b[0].date));
}

/**
 * Parse the costEUR field out of an entry's description_data.
 * Returns "0" if the entry has no declared cost.
 */
export function entryCostEUR(entry: JournalEntry): string {
  if (!entry.description_data) return "0";
  try {
    const data = JSON.parse(entry.description_data);
    if (data.type === "opening-balance" && data.costEUR) return data.costEUR;
  } catch { /* malformed */ }
  return "0";
}
