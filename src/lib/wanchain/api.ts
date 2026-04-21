// Wanchain API client.
// Strategy: use Tokenview if an API key is configured, otherwise JSON-RPC via
// public Wanchain nodes. The client exposes uniform methods; callers don't
// care which backend served a particular result.

import { cexFetch, abortableDelay } from "../cex/fetch.js";
import type {
  RpcBlock,
  RpcLog,
  RpcReceipt,
  RpcTx,
  TokenMeta,
  WanchainTxGroup,
  Wrc20Transfer,
} from "./types.js";

// Mainnet RPC.
const RPC_URL = "https://gwan-ssl.wandevs.org:56891";
const RPC_PROXY_PREFIX = "/api/wanchain-rpc";

// Tokenview REST.
const TOKENVIEW_URL = "https://services.tokenview.io";
const TOKENVIEW_PROXY_PREFIX = "/api/wanchain-tokenview";

const RATE_LIMIT_MS = 120;
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 1500;

/** topic0 for ERC-20/WRC-20 Transfer(address,address,uint256). */
export const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Pads a 0x-hex address to a 32-byte topic (66 chars incl. 0x). */
export function addressTopic(addr: string): string {
  const clean = addr.toLowerCase().replace(/^0x/, "");
  return "0x" + clean.padStart(64, "0");
}

let lastReqAt = 0;

export function _resetRateLimiter(): void {
  lastReqAt = 0;
}

async function rateGate(signal?: AbortSignal): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastReqAt;
  if (elapsed < RATE_LIMIT_MS) await abortableDelay(RATE_LIMIT_MS - elapsed, signal);
  lastReqAt = Date.now();
}

// ── JSON-RPC ──────────────────────────────────────────────

async function rpcCall<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await rateGate(signal);
    const res = await cexFetch(RPC_URL, RPC_URL, RPC_PROXY_PREFIX, init, signal);
    if (res.status === 200) {
      const parsed = JSON.parse(res.body) as { result?: T; error?: { message: string } };
      if (parsed.error) {
        if (attempt < MAX_RETRIES && /rate|busy|timeout/i.test(parsed.error.message)) {
          await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
          continue;
        }
        throw new Error(`Wanchain RPC ${method} error: ${parsed.error.message}`);
      }
      return parsed.result as T;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
      continue;
    }
    throw new Error(`Wanchain RPC HTTP ${res.status}: ${res.body.slice(0, 400)}`);
  }
  throw new Error("Wanchain RPC: max retries exceeded");
}

function hexToNumber(h: string): number {
  return parseInt(h, 16);
}
function hexToBigDecimal(h: string): string {
  // Return as decimal string (no BigInt coercion needed for downstream Decimal.js).
  return BigInt(h).toString();
}

// ── Tokenview ─────────────────────────────────────────────

interface TokenviewTxItem {
  block_no: number;
  time: number;          // unix seconds
  txid: string;
  from: string;
  to: string;
  value: string;         // already decimal (WAN units, 18 decimals)
  fee?: string;
  state?: string | number;
}

interface TokenviewTxResp {
  code?: number;
  msg?: string;
  data?: {
    page?: number;
    total?: number;
    txs?: TokenviewTxItem[];
  };
}

interface TokenviewTokenTxItem {
  block_no: number;
  time: number;
  txid: string;
  from: string;
  to: string;
  value: string;         // raw base units
  tokenInfo?: { s?: string; d?: number; contract?: string };
  contractAddress?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
}

interface TokenviewTokenTxResp {
  code?: number;
  msg?: string;
  data?: {
    page?: number;
    total?: number;
    txs?: TokenviewTokenTxItem[];
  };
}

async function tokenviewGet<T>(path: string, apiKey: string, signal?: AbortSignal): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${TOKENVIEW_URL}${path}${sep}apikey=${encodeURIComponent(apiKey)}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await rateGate(signal);
    const res = await cexFetch(url, TOKENVIEW_URL, TOKENVIEW_PROXY_PREFIX, { method: "GET" }, signal);
    if (res.status === 200) return JSON.parse(res.body) as T;
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await abortableDelay(BASE_RETRY_MS * 2 ** attempt, signal);
      continue;
    }
    throw new Error(`Tokenview ${path} HTTP ${res.status}: ${res.body.slice(0, 300)}`);
  }
  throw new Error("Tokenview: max retries exceeded");
}

// ── Client ────────────────────────────────────────────────

export interface WanchainClientOptions {
  tokenviewApiKey?: string;
  /** Override starting block for native-tx scan — useful for tests. */
  startBlock?: number;
  /** Max block range per eth_getLogs request (public RPCs cap at 5k-10k). */
  logChunkSize?: number;
}

export class WanchainClient {
  private tokenviewApiKey: string | undefined;
  private logChunkSize: number;
  private tokenCache = new Map<string, TokenMeta>();

  constructor(opts: WanchainClientOptions = {}) {
    this.tokenviewApiKey = opts.tokenviewApiKey?.trim() || undefined;
    this.logChunkSize = opts.logChunkSize ?? 2000;
  }

  get mode(): "tokenview" | "rpc" {
    return this.tokenviewApiKey ? "tokenview" : "rpc";
  }

  async getLatestBlock(signal?: AbortSignal): Promise<number> {
    const hex = await rpcCall<string>("eth_blockNumber", [], signal);
    return hexToNumber(hex);
  }

  async getBlockByNumber(blockNumber: number, signal?: AbortSignal): Promise<RpcBlock | null> {
    const hex = "0x" + blockNumber.toString(16);
    return rpcCall<RpcBlock | null>("eth_getBlockByNumber", [hex, true], signal);
  }

  async getReceipt(txHash: string, signal?: AbortSignal): Promise<RpcReceipt | null> {
    return rpcCall<RpcReceipt | null>("eth_getTransactionReceipt", [txHash], signal);
  }

  /**
   * Fetch WRC-20 Transfer logs involving the address, across the given block range.
   * Makes two queries per chunk: outgoing (topic1=address) + incoming (topic2=address).
   */
  async getErc20Transfers(
    address: string,
    fromBlock: number,
    toBlock: number,
    signal?: AbortSignal,
  ): Promise<Wrc20Transfer[]> {
    const out: Wrc20Transfer[] = [];
    const padded = addressTopic(address);

    for (let lo = fromBlock; lo <= toBlock; lo += this.logChunkSize) {
      const hi = Math.min(lo + this.logChunkSize - 1, toBlock);
      const filter = (which: "from" | "to") => ({
        fromBlock: "0x" + lo.toString(16),
        toBlock: "0x" + hi.toString(16),
        topics: which === "from"
          ? [TRANSFER_TOPIC0, padded, null]
          : [TRANSFER_TOPIC0, null, padded],
      });

      const [outgoing, incoming] = await Promise.all([
        rpcCall<RpcLog[]>("eth_getLogs", [filter("from")], signal),
        rpcCall<RpcLog[]>("eth_getLogs", [filter("to")], signal),
      ]);

      for (const log of [...outgoing, ...incoming]) {
        if (log.removed) continue;
        if (log.topics.length < 3) continue;
        out.push({
          contract: log.address.toLowerCase(),
          from: "0x" + log.topics[1].slice(-40),
          to: "0x" + log.topics[2].slice(-40),
          value: hexToBigDecimal(log.data || "0x0"),
          txHash: log.transactionHash,
          blockNumber: hexToNumber(log.blockNumber),
          logIndex: hexToNumber(log.logIndex),
        });
      }
    }
    return out;
  }

  /**
   * Fetch native WAN transactions via Tokenview (if key) or by walking blocks via RPC.
   * Returns tx groups (already aggregated with receipt + no logs yet).
   *
   * NOTE: RPC block-walk is bounded by `maxBlocks` (default 20000 blocks ≈ 1 day on Wanchain's ~5s blocks).
   * Users with deep history should provide a Tokenview key.
   */
  async getNativeTxs(
    address: string,
    fromBlock: number,
    toBlock: number,
    signal?: AbortSignal,
    opts?: { maxBlocks?: number },
  ): Promise<WanchainTxGroup[]> {
    if (this.tokenviewApiKey) {
      return this.tokenviewNativeTxs(address, fromBlock, signal);
    }
    const maxBlocks = opts?.maxBlocks ?? 20000;
    const effectiveFrom = Math.max(fromBlock, toBlock - maxBlocks + 1);
    return this.rpcWalkBlocks(address, effectiveFrom, toBlock, signal);
  }

  private async rpcWalkBlocks(
    address: string,
    fromBlock: number,
    toBlock: number,
    signal?: AbortSignal,
  ): Promise<WanchainTxGroup[]> {
    const lower = address.toLowerCase();
    const groups: WanchainTxGroup[] = [];

    for (let n = toBlock; n >= fromBlock; n--) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const block = await this.getBlockByNumber(n, signal);
      if (!block) continue;

      for (const t of block.transactions) {
        const from = t.from?.toLowerCase();
        const to = t.to?.toLowerCase() ?? null;
        if (from !== lower && to !== lower) continue;
        if (BigInt(t.value || "0x0") === 0n) continue;

        const receipt = await this.getReceipt(t.hash, signal);
        groups.push({
          hash: t.hash,
          blockNumber: hexToNumber(t.blockNumber),
          timestamp: hexToNumber(block.timestamp),
          from: t.from,
          to: t.to,
          value: hexToBigDecimal(t.value),
          gasUsed: receipt ? hexToBigDecimal(receipt.gasUsed) : "0",
          gasPrice: hexToBigDecimal(t.gasPrice),
          success: !receipt || receipt.status === "0x1",
        tokenTransfers: [],
        });
      }
    }

    return groups;
  }

  private async tokenviewNativeTxs(
    address: string,
    fromBlock: number,
    signal?: AbortSignal,
  ): Promise<WanchainTxGroup[]> {
    const out: WanchainTxGroup[] = [];
    const pageSize = 50;
    let page = 1;

    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const resp = await tokenviewGet<TokenviewTxResp>(
        `/api/tx/wan/${address}/${page}/${pageSize}`,
        this.tokenviewApiKey!,
        signal,
      );
      const txs = resp.data?.txs ?? [];
      if (txs.length === 0) break;

      let keepGoing = true;
      for (const t of txs) {
        if (t.block_no < fromBlock) { keepGoing = false; continue; }
        out.push({
          hash: t.txid,
          blockNumber: t.block_no,
          timestamp: t.time,
          from: t.from,
          to: t.to || null,
          value: String(t.value),
          gasUsed: "0",
          gasPrice: "0",
          success: String(t.state ?? "1") !== "0",
          tokenTransfers: [],
        });
      }
      if (!keepGoing || txs.length < pageSize) break;
      page++;
    }

    return out;
  }

  /** Fetch WRC-20 token metadata (symbol, decimals). Cached per contract. */
  async getTokenMeta(contract: string, signal?: AbortSignal): Promise<TokenMeta> {
    const key = contract.toLowerCase();
    const cached = this.tokenCache.get(key);
    if (cached) return cached;

    // symbol() selector 0x95d89b41 → bytes32 or string
    // decimals() selector 0x313ce567 → uint8
    const [symHex, decHex] = await Promise.all([
      rpcCall<string>("eth_call", [{ to: key, data: "0x95d89b41" }, "latest"], signal).catch(() => "0x"),
      rpcCall<string>("eth_call", [{ to: key, data: "0x313ce567" }, "latest"], signal).catch(() => "0x"),
    ]);
    const symbol = decodeStringReturn(symHex) || key.slice(0, 8);
    const decimals = decHex && decHex !== "0x" ? parseInt(decHex, 16) : 18;
    const meta: TokenMeta = { address: key, symbol, decimals };
    this.tokenCache.set(key, meta);
    return meta;
  }
}

/** Decode an ABI-encoded string (dynamic) or bytes32 return value to UTF-8. */
function decodeStringReturn(hex: string): string {
  if (!hex || hex === "0x") return "";
  const raw = hex.replace(/^0x/, "");
  // Heuristic: dynamic string starts with 0x20 offset + length + data.
  if (raw.length >= 128 && raw.slice(0, 64) === "0".repeat(62) + "20") {
    const len = parseInt(raw.slice(64, 128), 16);
    if (!Number.isFinite(len) || len <= 0 || len > 64) return utf8FromHex(raw.slice(128));
    return utf8FromHex(raw.slice(128, 128 + len * 2));
  }
  // Fallback: bytes32 — strip trailing zeros.
  const stripped = raw.replace(/0+$/, "");
  const pad = stripped.length % 2 === 1 ? stripped + "0" : stripped;
  return utf8FromHex(pad);
}

function utf8FromHex(hex: string): string {
  try {
    const bytes = new Uint8Array(hex.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? []);
    const s = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return s.replace(/\0+$/g, "").trim();
  } catch {
    return "";
  }
}
