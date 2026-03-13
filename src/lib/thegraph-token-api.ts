import Decimal from "decimal.js-light";
import type { TxHashGroup, NormalTx, Erc20Tx, Erc721Tx, Erc1155Tx } from "./handlers/types.js";

// --- Chain mapping ---

export const THE_GRAPH_NETWORK_MAP: Record<number, string> = {
  1: "mainnet",
  10: "optimism",
  42161: "arbitrum-one",
  8453: "base",
  56: "bsc",
  137: "polygon",
  43114: "avalanche",
  130: "unichain",
};

export function isTheGraphSupportedChain(chainId: number): boolean {
  return chainId in THE_GRAPH_NETWORK_MAP;
}

// --- Response types ---

export interface GraphTokenTransfer {
  from_address: string;
  to_address: string;
  token_address: string | null;
  amount: string; // human-readable (e.g. "1.5")
  transaction_id: string;
  block_timestamp: string; // ISO 8601
  block_number: number;
  token_type: "native" | "erc20";
  token_symbol: string | null;
  token_name: string | null;
  token_decimals: number | null;
}

export interface GraphNftTransfer {
  from_address: string;
  to_address: string;
  token_address: string;
  token_id: string;
  amount: string; // "1" for ERC-721, may be >1 for ERC-1155
  transaction_id: string;
  block_timestamp: string;
  block_number: number;
  token_type: "erc721" | "erc1155";
  token_symbol: string | null;
  token_name: string | null;
}

interface GraphApiResponse<T> {
  data: T[];
  next_cursor?: string;
}

// --- API client ---

const GRAPH_API_BASE = "https://token-api.thegraph.com";

async function fetchGraphPage<T>(
  apiKey: string,
  path: string,
  params: Record<string, string>,
  cursor?: string,
): Promise<GraphApiResponse<T>> {
  const url = new URL(`${GRAPH_API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  url.searchParams.set("limit", "1000");
  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`The Graph API ${resp.status}: ${text}`);
  }

  return resp.json() as Promise<GraphApiResponse<T>>;
}

export async function fetchGraphTransfers(
  apiKey: string,
  address: string,
  network: string,
  startTime?: number,
): Promise<GraphTokenTransfer[]> {
  const all: GraphTokenTransfer[] = [];
  const params: Record<string, string> = {
    network,
    account_address: address.toLowerCase(),
  };
  if (startTime) {
    params.start_timestamp = new Date(startTime * 1000).toISOString();
  }

  let cursor: string | undefined;
  do {
    const page = await fetchGraphPage<GraphTokenTransfer>(
      apiKey,
      "/v1/evm/transfers",
      params,
      cursor,
    );
    all.push(...page.data);
    cursor = page.next_cursor;
  } while (cursor);

  return all;
}

export async function fetchGraphNftTransfers(
  apiKey: string,
  address: string,
  network: string,
  startTime?: number,
): Promise<GraphNftTransfer[]> {
  const all: GraphNftTransfer[] = [];
  const params: Record<string, string> = {
    network,
    account_address: address.toLowerCase(),
  };
  if (startTime) {
    params.start_timestamp = new Date(startTime * 1000).toISOString();
  }

  let cursor: string | undefined;
  do {
    const page = await fetchGraphPage<GraphNftTransfer>(
      apiKey,
      "/v1/evm/nft/transfers",
      params,
      cursor,
    );
    all.push(...page.data);
    cursor = page.next_cursor;
  } while (cursor);

  return all;
}

// --- Conversion to TxHashGroup ---

/**
 * Convert human-readable amount to wei string.
 * e.g. "1.5" with 18 decimals → "1500000000000000000"
 */
export function amountToWei(amount: string, decimals: number): string {
  try {
    const d = new Decimal(amount);
    const factor = new Decimal(10).pow(decimals);
    return d.times(factor).toFixed(0);
  } catch {
    return "0";
  }
}

function isoToUnixStr(iso: string): string {
  const ts = Math.floor(new Date(iso).getTime() / 1000);
  return String(ts);
}

export function convertGraphToTxHashGroups(
  transfers: GraphTokenTransfer[],
  nftTransfers: GraphNftTransfer[],
  chainDecimals: number,
): TxHashGroup[] {
  const groupMap = new Map<string, TxHashGroup>();

  function getOrCreate(txId: string, timestamp: string): TxHashGroup {
    let g = groupMap.get(txId);
    if (!g) {
      g = {
        hash: txId,
        timestamp: isoToUnixStr(timestamp),
        normal: null,
        internals: [],
        erc20s: [],
        erc721s: [],
        erc1155s: [],
      };
      groupMap.set(txId, g);
    }
    return g;
  }

  for (const t of transfers) {
    const group = getOrCreate(t.transaction_id, t.block_timestamp);
    const ts = isoToUnixStr(t.block_timestamp);

    if (t.token_type === "native") {
      // Synthetic NormalTx — no gas data available from The Graph
      if (!group.normal) {
        group.normal = {
          hash: t.transaction_id,
          timeStamp: ts,
          from: t.from_address,
          to: t.to_address,
          value: amountToWei(t.amount, chainDecimals),
          gasUsed: "0",
          gasPrice: "0",
          isError: "0",
          blockNumber: String(t.block_number),
          nonce: "",
          functionName: "",
        } as NormalTx;
      }
    } else if (t.token_type === "erc20") {
      const decimals = t.token_decimals ?? 18;
      group.erc20s.push({
        hash: t.transaction_id,
        timeStamp: ts,
        from: t.from_address,
        to: t.to_address,
        value: amountToWei(t.amount, decimals),
        contractAddress: t.token_address ?? "",
        tokenName: t.token_name ?? "",
        tokenSymbol: t.token_symbol ?? "",
        tokenDecimal: String(decimals),
      } as Erc20Tx);
    }
  }

  for (const t of nftTransfers) {
    const group = getOrCreate(t.transaction_id, t.block_timestamp);
    const ts = isoToUnixStr(t.block_timestamp);

    if (t.token_type === "erc721") {
      group.erc721s.push({
        hash: t.transaction_id,
        timeStamp: ts,
        from: t.from_address,
        to: t.to_address,
        contractAddress: t.token_address,
        tokenID: t.token_id,
        tokenName: t.token_name ?? "",
        tokenSymbol: t.token_symbol ?? "",
      } as Erc721Tx);
    } else if (t.token_type === "erc1155") {
      group.erc1155s.push({
        hash: t.transaction_id,
        timeStamp: ts,
        from: t.from_address,
        to: t.to_address,
        contractAddress: t.token_address,
        tokenID: t.token_id,
        tokenValue: t.amount,
        tokenName: t.token_name ?? "",
        tokenSymbol: t.token_symbol ?? "",
      } as Erc1155Tx);
    }
  }

  return Array.from(groupMap.values());
}
