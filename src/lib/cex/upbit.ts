import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";
import { sha512Hex } from "./crypto-utils.js";

const UPBIT_API = "https://api.upbit.com";

async function upbitFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, UPBIT_API, "/api/upbit", init, signal);
}

/**
 * Base64url encode a buffer (no padding, URL-safe characters).
 */
function base64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Base64url encode a string.
 */
function base64urlStr(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * HMAC-SHA256 returning raw ArrayBuffer (for JWT signature).
 */
async function hmacSha256Raw(secret: string, data: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
}

/**
 * Build a JWT token for Upbit API authentication.
 * - Without query: payload has access_key, nonce, timestamp
 * - With query: additionally includes query_hash (SHA-512 of query string) and query_hash_alg
 */
async function buildJwt(
  apiKey: string,
  apiSecret: string,
  queryString?: string,
): Promise<string> {
  const header = base64urlStr(JSON.stringify({ alg: "HS256", typ: "JWT" }));

  const payload: Record<string, string | number> = {
    access_key: apiKey,
    nonce: crypto.randomUUID(),
    timestamp: Date.now(),
  };

  if (queryString) {
    payload.query_hash = await sha512Hex(queryString);
    payload.query_hash_alg = "SHA512";
  }

  const payloadEncoded = base64urlStr(JSON.stringify(payload));
  const sigInput = `${header}.${payloadEncoded}`;
  const sigBuffer = await hmacSha256Raw(apiSecret, sigInput);
  const signature = base64url(sigBuffer);

  return `${header}.${payloadEncoded}.${signature}`;
}

interface UpbitOrder {
  uuid: string;
  side: string; // "bid" (buy) or "ask" (sell)
  ord_type: string;
  price: string | null;
  state: string;
  market: string;
  volume: string;
  remaining_volume: string;
  executed_volume: string;
  trades_count: number;
  paid_fee: string;
  created_at: string;
  trades?: UpbitOrderTrade[];
}

interface UpbitOrderTrade {
  market: string;
  uuid: string;
  price: string;
  volume: string;
  funds: string;
  side: string;
  created_at: string;
}

interface UpbitDeposit {
  type: string;
  uuid: string;
  currency: string;
  txid: string | null;
  state: string;
  amount: string;
  fee: string;
  created_at: string;
  done_at: string | null;
}

interface UpbitWithdrawal {
  type: string;
  uuid: string;
  currency: string;
  txid: string | null;
  state: string;
  amount: string;
  fee: string;
  created_at: string;
  done_at: string | null;
}

function parseMarket(market: string): { base: string; quote: string } | null {
  // Upbit uses "KRW-BTC" format: quote-base
  const parts = market.split("-");
  if (parts.length === 2 && parts[0].length > 0 && parts[1].length > 0) {
    return { base: parts[1], quote: parts[0] };
  }
  return null;
}

export class UpbitAdapter implements CexAdapter {
  readonly exchangeId = "upbit" as const;
  readonly exchangeName = "Upbit";

  normalizeAsset(raw: string): string {
    return raw;
  }

  async fetchLedgerRecords(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];

    // 1. Fetch trades (closed orders)
    const tradeRecords = await this.fetchTrades(apiKey, apiSecret, since, signal);
    records.push(...tradeRecords);

    // 2. Fetch deposits
    const depositRecords = await this.fetchDeposits(apiKey, apiSecret, since, signal);
    records.push(...depositRecords);

    // 3. Fetch withdrawals
    const withdrawalRecords = await this.fetchWithdrawals(apiKey, apiSecret, since, signal);
    records.push(...withdrawalRecords);

    return records;
  }

  private async signedGet(
    path: string,
    params: URLSearchParams,
    apiKey: string,
    apiSecret: string,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: string }> {
    const queryString = params.toString();
    const token = await buildJwt(apiKey, apiSecret, queryString || undefined);
    const url = queryString
      ? `${UPBIT_API}${path}?${queryString}`
      : `${UPBIT_API}${path}`;

    return upbitFetch(
      url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      signal,
    );
  }

  /**
   * Fetch closed orders. Paginated by page number.
   */
  private async fetchTrades(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let page = 1;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({
        state: "done",
        page: String(page),
        limit: "100",
        order_by: "asc",
      });

      const result = await this.signedGet("/v1/orders/closed", params, apiKey, apiSecret, signal);
      const orders = JSON.parse(result.body) as UpbitOrder[];

      if (!Array.isArray(orders) || orders.length === 0) break;

      for (const order of orders) {
        const parsed = parseMarket(order.market);
        if (!parsed) continue;

        const orderTime = new Date(order.created_at).getTime() / 1000;

        // Skip orders before since
        if (since && orderTime < since) continue;

        const executedVolume = parseFloat(order.executed_volume);
        if (executedVolume === 0) continue;

        const { base, quote } = parsed;
        const isBuy = order.side === "bid";
        const refid = `order:${order.uuid}`;
        const price = order.price ? parseFloat(order.price) : 0;
        const quoteAmount = String(executedVolume * price);

        const tradeMeta: Record<string, string> = {
          "trade:market": order.market,
          "trade:side": isBuy ? "buy" : "sell",
          "trade:price": order.price ?? "0",
          "trade:quantity": order.executed_volume,
          "trade:quote_amount": quoteAmount,
          "trade:order_type": order.ord_type,
          "trade:paid_fee": order.paid_fee,
        };

        // Base asset record
        records.push({
          refid,
          type: "trade",
          asset: this.normalizeAsset(base),
          amount: isBuy ? order.executed_volume : `-${order.executed_volume}`,
          fee: "0",
          timestamp: orderTime,
          txid: null,
          metadata: tradeMeta,
        });

        // Quote asset record (fee is charged on quote side)
        records.push({
          refid,
          type: "trade",
          asset: this.normalizeAsset(quote),
          amount: isBuy ? `-${quoteAmount}` : quoteAmount,
          fee: order.paid_fee,
          timestamp: orderTime,
          txid: null,
          metadata: tradeMeta,
        });
      }

      if (orders.length < 100) break;
      page++;

      await abortableDelay(200, signal);
    }

    return records;
  }

  /**
   * Fetch deposit history. Paginated by page number (descending order).
   */
  private async fetchDeposits(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let page = 1;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({
        page: String(page),
        limit: "100",
        order: "desc",
      });

      const result = await this.signedGet("/v1/deposits", params, apiKey, apiSecret, signal);
      const deposits = JSON.parse(result.body) as UpbitDeposit[];

      if (!Array.isArray(deposits) || deposits.length === 0) break;

      let allBeforeSince = true;

      for (const dep of deposits) {
        // Only include accepted deposits
        if (dep.state !== "accepted") continue;

        const ts = new Date(dep.done_at ?? dep.created_at).getTime() / 1000;
        if (since && ts < since) continue;
        allBeforeSince = false;

        records.push({
          refid: `deposit:${dep.uuid}`,
          type: "deposit",
          asset: this.normalizeAsset(dep.currency),
          amount: dep.amount,
          fee: dep.fee,
          timestamp: ts,
          txid: dep.txid ? normalizeTxid(dep.txid) : null,
        });
      }

      // If all entries are before since, stop early (desc order)
      if (since && allBeforeSince) break;
      if (deposits.length < 100) break;
      page++;

      await abortableDelay(200, signal);
    }

    return records;
  }

  /**
   * Fetch withdrawal history. Paginated by page number.
   */
  private async fetchWithdrawals(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let page = 1;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({
        page: String(page),
        limit: "100",
      });

      const result = await this.signedGet("/v1/withdraws", params, apiKey, apiSecret, signal);
      const withdrawals = JSON.parse(result.body) as UpbitWithdrawal[];

      if (!Array.isArray(withdrawals) || withdrawals.length === 0) break;

      for (const wd of withdrawals) {
        // Only include completed withdrawals
        if (wd.state !== "done") continue;

        const ts = new Date(wd.done_at ?? wd.created_at).getTime() / 1000;
        if (since && ts < since) continue;

        records.push({
          refid: `withdraw:${wd.uuid}`,
          type: "withdrawal",
          asset: this.normalizeAsset(wd.currency),
          amount: `-${wd.amount}`,
          fee: wd.fee,
          timestamp: ts,
          txid: wd.txid ? normalizeTxid(wd.txid) : null,
        });
      }

      if (withdrawals.length < 100) break;
      page++;

      await abortableDelay(200, signal);
    }

    return records;
  }
}

// Re-export for tests
export { buildJwt };
