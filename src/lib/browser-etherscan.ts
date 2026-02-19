import { v7 as uuidv7 } from "uuid";
import Decimal from "decimal.js-light";
import type { Backend } from "./backend.js";
import type {
  Account,
  AccountType,
  JournalEntry,
  LineItem,
  EtherscanSyncResult,
  ChainInfo,
} from "./types/index.js";
import { SUPPORTED_CHAINS } from "./types/index.js";

// ---- API types ----

export interface NormalTx {
  hash: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  isError: string;
  gasUsed: string;
  gasPrice: string;
}

export interface InternalTx {
  hash: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  isError: string;
  traceId: string;
}

export interface Erc20Tx {
  hash: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  contractAddress: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimal: string;
}

export interface Erc721Tx {
  hash: string;
  timeStamp: string;
  from: string;
  to: string;
  contractAddress: string;
  tokenID: string;
  tokenName: string;
  tokenSymbol: string;
}

export interface Erc1155Tx {
  hash: string;
  timeStamp: string;
  from: string;
  to: string;
  contractAddress: string;
  tokenID: string;
  tokenValue: string;
  tokenName: string;
  tokenSymbol: string;
}

interface ApiResponse {
  status: string;
  message: string;
  result: unknown;
}

// ---- Hash grouping ----

export interface TxHashGroup {
  hash: string;
  timestamp: string;
  normal: NormalTx | null;
  internals: InternalTx[];
  erc20s: Erc20Tx[];
  erc721s: Erc721Tx[];
  erc1155s: Erc1155Tx[];
}

function newHashGroup(hash: string): TxHashGroup {
  return {
    hash,
    timestamp: "",
    normal: null,
    internals: [],
    erc20s: [],
    erc721s: [],
    erc1155s: [],
  };
}

function updateMinTimestamp(group: TxHashGroup, newTs: string): void {
  if (!group.timestamp) {
    group.timestamp = newTs;
    return;
  }
  const cur = parseInt(group.timestamp, 10) || Infinity;
  const nw = parseInt(newTs, 10) || Infinity;
  if (nw < cur) {
    group.timestamp = newTs;
  }
}

export function groupByHash(
  normal: NormalTx[],
  internal: InternalTx[],
  erc20: Erc20Tx[],
  erc721: Erc721Tx[],
  erc1155: Erc1155Tx[],
): Map<string, TxHashGroup> {
  const groups = new Map<string, TxHashGroup>();

  for (const tx of normal) {
    const key = tx.hash.toLowerCase();
    if (!groups.has(key)) groups.set(key, newHashGroup(key));
    const g = groups.get(key)!;
    updateMinTimestamp(g, tx.timeStamp);
    g.normal = tx;
  }

  for (const tx of internal) {
    const key = tx.hash.toLowerCase();
    if (!groups.has(key)) groups.set(key, newHashGroup(key));
    const g = groups.get(key)!;
    updateMinTimestamp(g, tx.timeStamp);
    g.internals.push(tx);
  }

  for (const tx of erc20) {
    const key = tx.hash.toLowerCase();
    if (!groups.has(key)) groups.set(key, newHashGroup(key));
    const g = groups.get(key)!;
    updateMinTimestamp(g, tx.timeStamp);
    g.erc20s.push(tx);
  }

  for (const tx of erc721) {
    const key = tx.hash.toLowerCase();
    if (!groups.has(key)) groups.set(key, newHashGroup(key));
    const g = groups.get(key)!;
    updateMinTimestamp(g, tx.timeStamp);
    g.erc721s.push(tx);
  }

  for (const tx of erc1155) {
    const key = tx.hash.toLowerCase();
    if (!groups.has(key)) groups.set(key, newHashGroup(key));
    const g = groups.get(key)!;
    updateMinTimestamp(g, tx.timeStamp);
    g.erc1155s.push(tx);
  }

  return groups;
}

// ---- Helpers ----

export function pow10(exp: number): Decimal {
  let result = new Decimal(1);
  const ten = new Decimal(10);
  for (let i = 0; i < exp; i++) result = result.times(ten);
  return result;
}

export function weiToNative(weiStr: string, decimals: number): Decimal {
  if (!weiStr || weiStr === "0") return new Decimal(0);
  return new Decimal(weiStr).dividedBy(pow10(decimals));
}

export function calculateGasFee(
  gasUsed: string,
  gasPrice: string,
  decimals: number,
): Decimal {
  const used = new Decimal(gasUsed || "0");
  const price = new Decimal(gasPrice || "0");
  const weiFee = used.times(price);
  if (weiFee.isZero()) return new Decimal(0);
  return weiFee.dividedBy(pow10(decimals));
}

export function timestampToDate(ts: string): string {
  const secs = parseInt(ts, 10);
  if (isNaN(secs)) throw new Error(`bad timestamp '${ts}'`);
  return new Date(secs * 1000).toISOString().slice(0, 10);
}

export function shortAddr(addr: string): string {
  return addr.length >= 10 ? addr.substring(0, 10) : addr;
}

function formatTxDescription(
  tx: NormalTx,
  ourAddress: string,
  chain: ChainInfo,
): string {
  const from = tx.from.toLowerCase();
  const to = tx.to.toLowerCase();
  const hashShort =
    tx.hash.length >= 10 ? tx.hash.substring(0, 10) : tx.hash;
  const currency = chain.native_currency;

  if (from === ourAddress && to === ourAddress) {
    return `${currency} self-transfer (${hashShort})`;
  } else if (!to) {
    return `${currency} contract creation (${hashShort})`;
  } else if (from === ourAddress) {
    return `${currency} sent to ${shortAddr(to)} (${hashShort})`;
  } else {
    return `${currency} received from ${shortAddr(from)} (${hashShort})`;
  }
}

export function inferAccountType(fullName: string): AccountType {
  const first = fullName.split(":")[0];
  switch (first) {
    case "Assets":
      return "asset";
    case "Liabilities":
      return "liability";
    case "Equity":
      return "equity";
    case "Income":
      return "revenue";
    case "Expenses":
      return "expense";
    default:
      throw new Error(`cannot infer account type from '${fullName}'`);
  }
}

// ---- HTTP ----

export async function fetchPaginated<T>(
  apiKey: string,
  address: string,
  action: string,
  chainId: number,
): Promise<T[]> {
  const allResults: T[] = [];
  let page = 1;

  while (true) {
    const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=${action}&address=${address}&startblock=0&endblock=99999999&page=${page}&offset=10000&sort=asc&apikey=${apiKey}`;
    const resp = await fetch(url);
    const apiResp: ApiResponse = await resp.json();

    if (apiResp.status !== "1") {
      if (
        (typeof apiResp.message === "string" &&
          apiResp.message.includes("No transactions found")) ||
        apiResp.message === "No records found" ||
        apiResp.message === "OK"
      ) {
        break;
      }
      throw new Error(`Etherscan API error: ${apiResp.message}`);
    }

    if (Array.isArray(apiResp.result)) {
      const count = apiResp.result.length;
      allResults.push(...(apiResp.result as T[]));
      if (count < 10000) break;
    } else {
      break;
    }

    page++;
    await new Promise((r) => setTimeout(r, 250));
  }

  return allResults;
}

// ---- Description builders ----

function buildGroupDescription(
  group: TxHashGroup,
  ourAddress: string,
  chain: ChainInfo,
): string {
  const hashShort =
    group.hash.length >= 10 ? group.hash.substring(0, 10) : group.hash;
  const tokenCount =
    group.erc20s.length + group.erc721s.length + group.erc1155s.length;

  if (group.normal) {
    const base = formatTxDescription(group.normal, ourAddress, chain);
    if (tokenCount > 0) {
      return `${base} + ${tokenCount} token transfer(s)`;
    }
    return base;
  } else if (group.internals.length > 0 && tokenCount === 0) {
    // Internal-only
    return `${chain.native_currency} internal transfer (${hashShort})`;
  } else {
    // Token-only or mixed internal+token (no normal)
    return buildTokenDescription(group, ourAddress, hashShort);
  }
}

function buildTokenDescription(
  group: TxHashGroup,
  ourAddress: string,
  hashShort: string,
): string {
  const total =
    group.erc20s.length + group.erc721s.length + group.erc1155s.length;

  // Find the first token transfer involving our address
  for (const tx of group.erc20s) {
    const symbol = tx.tokenSymbol || `ERC20:${shortAddr(tx.contractAddress)}`;
    const from = tx.from.toLowerCase();
    const to = tx.to.toLowerCase();
    if (from === ourAddress) {
      const base = `${symbol} sent to ${shortAddr(to)} (${hashShort})`;
      return total > 1 ? `${base} + ${total - 1} more` : base;
    } else if (to === ourAddress) {
      const base = `${symbol} received from ${shortAddr(from)} (${hashShort})`;
      return total > 1 ? `${base} + ${total - 1} more` : base;
    }
  }

  for (const tx of group.erc721s) {
    const symbol =
      tx.tokenSymbol || `NFT:${shortAddr(tx.contractAddress)}`;
    const from = tx.from.toLowerCase();
    const to = tx.to.toLowerCase();
    if (from === ourAddress) {
      const base = `${symbol} sent to ${shortAddr(to)} (${hashShort})`;
      return total > 1 ? `${base} + ${total - 1} more` : base;
    } else if (to === ourAddress) {
      const base = `${symbol} received from ${shortAddr(from)} (${hashShort})`;
      return total > 1 ? `${base} + ${total - 1} more` : base;
    }
  }

  for (const tx of group.erc1155s) {
    const symbol =
      tx.tokenSymbol || `ERC1155:${shortAddr(tx.contractAddress)}`;
    const from = tx.from.toLowerCase();
    const to = tx.to.toLowerCase();
    if (from === ourAddress) {
      const base = `${symbol} sent to ${shortAddr(to)} (${hashShort})`;
      return total > 1 ? `${base} + ${total - 1} more` : base;
    } else if (to === ourAddress) {
      const base = `${symbol} received from ${shortAddr(from)} (${hashShort})`;
      return total > 1 ? `${base} + ${total - 1} more` : base;
    }
  }

  return `token transfer (${hashShort})`;
}

// ---- Main sync function ----

export async function syncEtherscan(
  backend: Backend,
  apiKey: string,
  address: string,
  label: string,
  chainId: number,
): Promise<EtherscanSyncResult> {
  const chain = SUPPORTED_CHAINS.find((c) => c.chain_id === chainId);
  if (!chain) throw new Error(`unsupported chain_id: ${chainId}`);

  const result: EtherscanSyncResult = {
    transactions_imported: 0,
    transactions_skipped: 0,
    accounts_created: 0,
    warnings: [],
  };

  const addr = address.toLowerCase();

  // Build caches
  const currencySet = new Set(
    (await backend.listCurrencies()).map((c) => c.code),
  );
  const accountMap = new Map<string, Account>();
  for (const acc of await backend.listAccounts()) {
    accountMap.set(acc.full_name, acc);
  }

  // Collect existing sources for dedup
  const entries = await backend.queryJournalEntries({});
  const existingSources = new Set<string>();
  const chainPrefix = `etherscan:${chainId}:`;
  for (const [e] of entries) {
    if (!e.source.startsWith("etherscan:")) continue;
    existingSources.add(e.source);
    // Backward compat for chain_id=1
    if (chainId === 1 && !e.source.startsWith("etherscan:1:")) {
      const rest = e.source.substring("etherscan:".length);
      if (rest.startsWith("0x")) {
        existingSources.add(`etherscan:1:${rest}`);
      } else if (rest.startsWith("int:")) {
        existingSources.add(`etherscan:1:${rest}`);
        // Also add hash-level key for old internal sources
        const parts = rest.split(":");
        if (parts.length >= 2) {
          existingSources.add(`etherscan:1:${parts[1]}`);
        }
      }
    }
    // Backward compat: old internal sources "etherscan:{chainId}:int:{hash}:{traceId}"
    if (e.source.startsWith(chainPrefix)) {
      const afterPrefix = e.source.substring(chainPrefix.length);
      if (afterPrefix.startsWith("int:")) {
        const parts = afterPrefix.split(":");
        if (parts.length >= 2) {
          existingSources.add(`etherscan:${chainId}:${parts[1]}`);
        }
      }
    }
  }

  async function ensureCurrency(
    code: string,
    decimalPlaces: number,
  ): Promise<void> {
    if (currencySet.has(code)) return;
    await backend.createCurrency({
      code,
      name: code,
      decimal_places: decimalPlaces,
      is_base: false,
    });
    currencySet.add(code);
  }

  async function ensureAccount(
    fullName: string,
    date: string,
  ): Promise<string> {
    const existing = accountMap.get(fullName);
    if (existing) return existing.id;

    const accountType = inferAccountType(fullName);
    const parts = fullName.split(":");
    let parentId: string | null = null;

    for (let depth = 1; depth < parts.length; depth++) {
      const ancestorName = parts.slice(0, depth).join(":");
      const existingAncestor = accountMap.get(ancestorName);
      if (existingAncestor) {
        parentId = existingAncestor.id;
      } else {
        const id = uuidv7();
        const acc: Account = {
          id,
          parent_id: parentId,
          account_type: accountType,
          name: parts[depth - 1],
          full_name: ancestorName,
          allowed_currencies: [],
          is_postable: true,
          is_archived: false,
          created_at: date,
        };
        await backend.createAccount(acc);
        accountMap.set(ancestorName, acc);
        result.accounts_created++;
        parentId = id;
      }
    }

    const id = uuidv7();
    const acc: Account = {
      id,
      parent_id: parentId,
      account_type: accountType,
      name: parts[parts.length - 1],
      full_name: fullName,
      allowed_currencies: [],
      is_postable: true,
      is_archived: false,
      created_at: date,
    };
    await backend.createAccount(acc);
    accountMap.set(fullName, acc);
    result.accounts_created++;
    return id;
  }

  function makeItem(
    entryId: string,
    accountId: string,
    amount: Decimal,
    currency: string,
  ): LineItem {
    return {
      id: uuidv7(),
      journal_entry_id: entryId,
      account_id: accountId,
      currency,
      amount: amount.toString(),
      lot_id: null,
    };
  }

  // ---- Item builders ----

  async function buildNormalItems(
    tx: NormalTx,
    entryId: string,
    date: string,
  ): Promise<LineItem[]> {
    const value = weiToNative(tx.value, chain!.decimals);
    const gasFee = calculateGasFee(tx.gasUsed, tx.gasPrice, chain!.decimals);
    const from = tx.from.toLowerCase();
    const to = tx.to.toLowerCase();
    const chainName = chain!.name;
    const ourAccount = `Assets:${chainName}:${label}`;
    const items: LineItem[] = [];
    const curr = chain!.native_currency;

    if (from === addr && to === addr) {
      if (!gasFee.isZero()) {
        const gasAccId = await ensureAccount(
          `Expenses:${chainName}:Gas`,
          date,
        );
        const ourAccId = await ensureAccount(ourAccount, date);
        items.push(makeItem(entryId, gasAccId, gasFee, curr));
        items.push(makeItem(entryId, ourAccId, gasFee.neg(), curr));
      }
    } else if (!to) {
      if (!gasFee.isZero()) {
        const ccAccId = await ensureAccount(
          `Expenses:${chainName}:ContractCreation`,
          date,
        );
        const ourAccId = await ensureAccount(ourAccount, date);
        items.push(makeItem(entryId, ccAccId, gasFee, curr));
        items.push(makeItem(entryId, ourAccId, gasFee.neg(), curr));
      }
    } else if (from === addr) {
      const extAccount = `Equity:${chainName}:External:${shortAddr(to)}`;
      const extAccId = await ensureAccount(extAccount, date);
      const ourAccId = await ensureAccount(ourAccount, date);
      if (!value.isZero())
        items.push(makeItem(entryId, extAccId, value, curr));
      if (!gasFee.isZero()) {
        const gasAccId = await ensureAccount(
          `Expenses:${chainName}:Gas`,
          date,
        );
        items.push(makeItem(entryId, gasAccId, gasFee, curr));
      }
      const totalOut = value.plus(gasFee);
      if (!totalOut.isZero())
        items.push(makeItem(entryId, ourAccId, totalOut.neg(), curr));
    } else if (to === addr) {
      if (!value.isZero()) {
        const extAccount = `Equity:${chainName}:External:${shortAddr(from)}`;
        const extAccId = await ensureAccount(extAccount, date);
        const ourAccId = await ensureAccount(ourAccount, date);
        items.push(makeItem(entryId, ourAccId, value, curr));
        items.push(makeItem(entryId, extAccId, value.neg(), curr));
      }
    }

    return items;
  }

  async function buildInternalItems(
    tx: InternalTx,
    entryId: string,
    date: string,
  ): Promise<LineItem[]> {
    const value = weiToNative(tx.value, chain!.decimals);
    if (value.isZero()) return [];

    const from = tx.from.toLowerCase();
    const to = tx.to.toLowerCase();
    const chainName = chain!.name;
    const ourAccount = `Assets:${chainName}:${label}`;
    const items: LineItem[] = [];
    const curr = chain!.native_currency;

    if (from === addr && to === addr) {
      // Self-transfer: no net effect
    } else if (from === addr) {
      const extAccount = `Equity:${chainName}:External:${shortAddr(to)}`;
      const extAccId = await ensureAccount(extAccount, date);
      const ourAccId = await ensureAccount(ourAccount, date);
      items.push(makeItem(entryId, extAccId, value, curr));
      items.push(makeItem(entryId, ourAccId, value.neg(), curr));
    } else if (to === addr) {
      const extAccount = `Equity:${chainName}:External:${shortAddr(from)}`;
      const extAccId = await ensureAccount(extAccount, date);
      const ourAccId = await ensureAccount(ourAccount, date);
      items.push(makeItem(entryId, ourAccId, value, curr));
      items.push(makeItem(entryId, extAccId, value.neg(), curr));
    }

    return items;
  }

  async function buildErc20Items(
    tx: Erc20Tx,
    entryId: string,
    date: string,
  ): Promise<LineItem[]> {
    const decimals = parseInt(tx.tokenDecimal, 10) || 18;
    const value = weiToNative(tx.value, decimals);
    if (value.isZero()) return [];

    const currency = tx.tokenSymbol || `ERC20:${shortAddr(tx.contractAddress)}`;
    await ensureCurrency(currency, decimals);

    const from = tx.from.toLowerCase();
    const to = tx.to.toLowerCase();
    const chainName = chain!.name;
    const ourAccount = `Assets:${chainName}:${label}`;
    const items: LineItem[] = [];

    if (from === addr && to === addr) {
      // Self-transfer: no net effect
    } else if (from === addr) {
      const extAccount = `Equity:${chainName}:External:${shortAddr(to)}`;
      const extAccId = await ensureAccount(extAccount, date);
      const ourAccId = await ensureAccount(ourAccount, date);
      items.push(makeItem(entryId, extAccId, value, currency));
      items.push(makeItem(entryId, ourAccId, value.neg(), currency));
    } else if (to === addr) {
      const extAccount = `Equity:${chainName}:External:${shortAddr(from)}`;
      const extAccId = await ensureAccount(extAccount, date);
      const ourAccId = await ensureAccount(ourAccount, date);
      items.push(makeItem(entryId, ourAccId, value, currency));
      items.push(makeItem(entryId, extAccId, value.neg(), currency));
    }

    return items;
  }

  async function buildErc721Items(
    tx: Erc721Tx,
    entryId: string,
    date: string,
  ): Promise<LineItem[]> {
    const value = new Decimal(1);
    const currency = tx.tokenSymbol || `NFT:${shortAddr(tx.contractAddress)}`;
    await ensureCurrency(currency, 0);

    const from = tx.from.toLowerCase();
    const to = tx.to.toLowerCase();
    const chainName = chain!.name;
    const ourAccount = `Assets:${chainName}:${label}`;
    const items: LineItem[] = [];

    if (from === addr && to === addr) {
      // Self-transfer: no net effect
    } else if (from === addr) {
      const extAccount = `Equity:${chainName}:External:${shortAddr(to)}`;
      const extAccId = await ensureAccount(extAccount, date);
      const ourAccId = await ensureAccount(ourAccount, date);
      items.push(makeItem(entryId, extAccId, value, currency));
      items.push(makeItem(entryId, ourAccId, value.neg(), currency));
    } else if (to === addr) {
      const extAccount = `Equity:${chainName}:External:${shortAddr(from)}`;
      const extAccId = await ensureAccount(extAccount, date);
      const ourAccId = await ensureAccount(ourAccount, date);
      items.push(makeItem(entryId, ourAccId, value, currency));
      items.push(makeItem(entryId, extAccId, value.neg(), currency));
    }

    return items;
  }

  async function buildErc1155Items(
    tx: Erc1155Tx,
    entryId: string,
    date: string,
  ): Promise<LineItem[]> {
    let value: Decimal;
    try {
      value = new Decimal(tx.tokenValue || "0");
    } catch {
      value = new Decimal(0);
    }
    if (value.isZero()) return [];

    const currency =
      tx.tokenSymbol || `ERC1155:${shortAddr(tx.contractAddress)}`;
    await ensureCurrency(currency, 0);

    const from = tx.from.toLowerCase();
    const to = tx.to.toLowerCase();
    const chainName = chain!.name;
    const ourAccount = `Assets:${chainName}:${label}`;
    const items: LineItem[] = [];

    if (from === addr && to === addr) {
      // Self-transfer: no net effect
    } else if (from === addr) {
      const extAccount = `Equity:${chainName}:External:${shortAddr(to)}`;
      const extAccId = await ensureAccount(extAccount, date);
      const ourAccId = await ensureAccount(ourAccount, date);
      items.push(makeItem(entryId, extAccId, value, currency));
      items.push(makeItem(entryId, ourAccId, value.neg(), currency));
    } else if (to === addr) {
      const extAccount = `Equity:${chainName}:External:${shortAddr(from)}`;
      const extAccId = await ensureAccount(extAccount, date);
      const ourAccId = await ensureAccount(ourAccount, date);
      items.push(makeItem(entryId, ourAccId, value, currency));
      items.push(makeItem(entryId, extAccId, value.neg(), currency));
    }

    return items;
  }

  // ---- Item merging ----

  function mergeItems(items: LineItem[]): LineItem[] {
    const sums = new Map<string, { entryId: string; amount: Decimal }>();

    for (const item of items) {
      const key = `${item.account_id}|${item.currency}`;
      const existing = sums.get(key);
      if (existing) {
        existing.amount = existing.amount.plus(new Decimal(item.amount));
      } else {
        sums.set(key, {
          entryId: item.journal_entry_id,
          amount: new Decimal(item.amount),
        });
      }
    }

    const merged: LineItem[] = [];
    for (const [key, { entryId, amount }] of sums) {
      if (amount.isZero()) continue;
      const [accountId, currency] = key.split("|", 2);
      merged.push({
        id: uuidv7(),
        journal_entry_id: entryId,
        account_id: accountId,
        currency,
        amount: amount.toString(),
        lot_id: null,
      });
    }

    return merged;
  }

  // ---- Hash group processing ----

  async function processHashGroup(group: TxHashGroup): Promise<void> {
    // Skip if normal tx has isError == "1"
    if (group.normal && group.normal.isError === "1") {
      return;
    }

    const date = timestampToDate(group.timestamp);
    const entryId = uuidv7();
    const allItems: LineItem[] = [];

    // Build normal items
    if (group.normal) {
      const items = await buildNormalItems(group.normal, entryId, date);
      allItems.push(...items);
    }

    // Build internal items (skip isError == "1")
    for (const internal of group.internals) {
      if (internal.isError === "1") continue;
      const items = await buildInternalItems(internal, entryId, date);
      allItems.push(...items);
    }

    // Build ERC20 items
    for (const erc20 of group.erc20s) {
      const items = await buildErc20Items(erc20, entryId, date);
      allItems.push(...items);
    }

    // Build ERC721 items
    for (const erc721 of group.erc721s) {
      const items = await buildErc721Items(erc721, entryId, date);
      allItems.push(...items);
    }

    // Build ERC1155 items
    for (const erc1155 of group.erc1155s) {
      const items = await buildErc1155Items(erc1155, entryId, date);
      allItems.push(...items);
    }

    // Merge items sharing the same (account_id, currency)
    const merged = mergeItems(allItems);
    if (merged.length === 0) return;

    // Build description
    const description = buildGroupDescription(group, addr, chain!);

    // Post journal entry
    const source = `etherscan:${chainId}:${group.hash}`;
    const entry: JournalEntry = {
      id: entryId,
      date,
      description,
      status: "confirmed",
      source,
      voided_by: null,
      created_at: date,
    };

    try {
      await backend.postJournalEntry(entry, merged);
      result.transactions_imported++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      result.warnings.push(`post tx ${group.hash}: ${msg}`);
    }
  }

  // ---- Main sync flow ----

  // 1. Ensure native currency
  await ensureCurrency(chain.native_currency, chain.decimals);

  // 2. Fetch all 5 transfer types (with rate-limiting delays)
  const normalTxns = await fetchPaginated<NormalTx>(
    apiKey,
    addr,
    "txlist",
    chainId,
  );

  await new Promise((r) => setTimeout(r, 250));
  const internalTxns = await fetchPaginated<InternalTx>(
    apiKey,
    addr,
    "txlistinternal",
    chainId,
  );

  await new Promise((r) => setTimeout(r, 250));
  const erc20Txns = await fetchPaginated<Erc20Tx>(
    apiKey,
    addr,
    "tokentx",
    chainId,
  );

  await new Promise((r) => setTimeout(r, 250));
  const erc721Txns = await fetchPaginated<Erc721Tx>(
    apiKey,
    addr,
    "tokennfttx",
    chainId,
  );

  await new Promise((r) => setTimeout(r, 250));
  const erc1155Txns = await fetchPaginated<Erc1155Tx>(
    apiKey,
    addr,
    "token1155tx",
    chainId,
  );

  // 3. Group by hash
  const groups = groupByHash(
    normalTxns,
    internalTxns,
    erc20Txns,
    erc721Txns,
    erc1155Txns,
  );

  // 4. Sort groups by timestamp and process
  const sortedGroups = Array.from(groups.values()).sort((a, b) => {
    const aTs = parseInt(a.timestamp, 10) || 0;
    const bTs = parseInt(b.timestamp, 10) || 0;
    return aTs - bTs;
  });

  for (const group of sortedGroups) {
    const source = `etherscan:${chainId}:${group.hash}`;
    if (existingSources.has(source)) {
      result.transactions_skipped++;
      continue;
    }
    await processHashGroup(group);
  }

  return result;
}
