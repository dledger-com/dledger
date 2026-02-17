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

interface NormalTx {
  hash: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  isError: string;
  gasUsed: string;
  gasPrice: string;
}

interface InternalTx {
  hash: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  isError: string;
  traceId: string;
}

interface ApiResponse {
  status: string;
  message: string;
  result: unknown;
}

// ---- Helpers ----

function pow10(exp: number): Decimal {
  let result = new Decimal(1);
  const ten = new Decimal(10);
  for (let i = 0; i < exp; i++) result = result.times(ten);
  return result;
}

function weiToNative(weiStr: string, decimals: number): Decimal {
  if (!weiStr || weiStr === "0") return new Decimal(0);
  return new Decimal(weiStr).dividedBy(pow10(decimals));
}

function calculateGasFee(
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

function timestampToDate(ts: string): string {
  const secs = parseInt(ts, 10);
  if (isNaN(secs)) throw new Error(`bad timestamp '${ts}'`);
  return new Date(secs * 1000).toISOString().slice(0, 10);
}

function shortAddr(addr: string): string {
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

function inferAccountType(fullName: string): AccountType {
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

async function fetchPaginated<T>(
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

  // ---- Process transactions ----

  async function processNormalTx(
    tx: NormalTx,
    source: string,
  ): Promise<void> {
    const date = timestampToDate(tx.timeStamp);
    const value = weiToNative(tx.value, chain!.decimals);
    const gasFee = calculateGasFee(
      tx.gasUsed,
      tx.gasPrice,
      chain!.decimals,
    );

    const from = tx.from.toLowerCase();
    const to = tx.to.toLowerCase();
    const chainName = chain!.name;
    const ourAccount = `Assets:${chainName}:${label}`;
    const entryId = uuidv7();
    const items: LineItem[] = [];
    const curr = chain!.native_currency;

    if (from === addr && to === addr) {
      if (gasFee.isZero()) return;
      const gasAccId = await ensureAccount(
        `Expenses:${chainName}:Gas`,
        date,
      );
      const ourAccId = await ensureAccount(ourAccount, date);
      items.push(makeItem(entryId, gasAccId, gasFee, curr));
      items.push(makeItem(entryId, ourAccId, gasFee.neg(), curr));
    } else if (!to) {
      if (gasFee.isZero()) return;
      const ccAccId = await ensureAccount(
        `Expenses:${chainName}:ContractCreation`,
        date,
      );
      const ourAccId = await ensureAccount(ourAccount, date);
      items.push(makeItem(entryId, ccAccId, gasFee, curr));
      items.push(makeItem(entryId, ourAccId, gasFee.neg(), curr));
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
        items.push(
          makeItem(entryId, ourAccId, totalOut.neg(), curr),
        );
    } else if (to === addr) {
      if (value.isZero()) return;
      const extAccount = `Equity:${chainName}:External:${shortAddr(from)}`;
      const extAccId = await ensureAccount(extAccount, date);
      const ourAccId = await ensureAccount(ourAccount, date);
      items.push(makeItem(entryId, ourAccId, value, curr));
      items.push(makeItem(entryId, extAccId, value.neg(), curr));
    } else {
      return;
    }

    if (items.length === 0) return;

    const description = formatTxDescription(tx, addr, chain!);
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
      await backend.postJournalEntry(entry, items);
      result.transactions_imported++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      result.warnings.push(`post tx ${tx.hash}: ${msg}`);
    }
  }

  async function processInternalTx(
    tx: InternalTx,
    source: string,
  ): Promise<void> {
    const date = timestampToDate(tx.timeStamp);
    const value = weiToNative(tx.value, chain!.decimals);
    if (value.isZero()) return;

    const from = tx.from.toLowerCase();
    const to = tx.to.toLowerCase();
    const chainName = chain!.name;
    const ourAccount = `Assets:${chainName}:${label}`;
    const entryId = uuidv7();
    const items: LineItem[] = [];
    const curr = chain!.native_currency;

    if (from === addr && to === addr) {
      return;
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
    } else {
      return;
    }

    const hashShort =
      tx.hash.length >= 10 ? tx.hash.substring(0, 10) : tx.hash;
    const description = `${curr} internal transfer (${hashShort})`;
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
      await backend.postJournalEntry(entry, items);
      result.transactions_imported++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      result.warnings.push(`post internal tx ${tx.hash}: ${msg}`);
    }
  }

  // 1. Ensure native currency
  await ensureCurrency(chain.native_currency, chain.decimals);

  // 2. Fetch transactions
  const normalTxns = await fetchPaginated<NormalTx>(
    apiKey,
    addr,
    "txlist",
    chainId,
  );
  const internalTxns = await fetchPaginated<InternalTx>(
    apiKey,
    addr,
    "txlistinternal",
    chainId,
  );

  // 3. Process normal transactions
  for (const tx of normalTxns) {
    if (tx.isError === "1") continue;
    const source = `etherscan:${chainId}:${tx.hash}`;
    if (existingSources.has(source)) {
      result.transactions_skipped++;
      continue;
    }
    await processNormalTx(tx, source);
  }

  // 4. Process internal transactions
  for (const tx of internalTxns) {
    if (tx.isError === "1") continue;
    const source = `etherscan:${chainId}:int:${tx.hash}:${tx.traceId}`;
    if (existingSources.has(source)) {
      result.transactions_skipped++;
      continue;
    }
    await processInternalTx(tx, source);
  }

  return result;
}
