import Decimal from "decimal.js-light";
import type {
  AccountType,
} from "./types/index.js";
import { ETHERSCAN_PAID_ONLY_CHAINS } from "./types/index.js";

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
  routescanApiKey?: string,
): Promise<T[]> {
  const allResults: T[] = [];
  let page = 1;
  const useRoutescan = ETHERSCAN_PAID_ONLY_CHAINS.has(chainId);

  while (true) {
    const url = useRoutescan
      ? `https://api.routescan.io/v2/network/mainnet/evm/${chainId}/etherscan/api?module=account&action=${action}&address=${address}&startblock=0&endblock=99999999&page=${page}&offset=10000&sort=asc${routescanApiKey ? `&apikey=${routescanApiKey}` : ""}`
      : `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=${action}&address=${address}&startblock=0&endblock=99999999&page=${page}&offset=10000&sort=asc&apikey=${apiKey}`;
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
      const provider = useRoutescan ? "Routescan" : "Etherscan";
      throw new Error(`${provider} API error: ${apiResp.message}`);
    }

    if (Array.isArray(apiResp.result)) {
      const count = apiResp.result.length;
      allResults.push(...(apiResp.result as T[]));
      if (count < 10000) break;
    } else {
      break;
    }

    page++;
    // Routescan free tier: 2 rps (500ms), Etherscan: ~4 rps (250ms)
    await new Promise((r) => setTimeout(r, useRoutescan ? 500 : 250));
  }

  return allResults;
}

