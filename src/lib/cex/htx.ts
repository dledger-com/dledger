import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";
import { hmacSha256Base64 } from "./crypto-utils.js";

const HTX_API = "https://api.huobi.pro";
const HTX_HOST = "api.huobi.pro";
const RATE_LIMIT_MS = 100;

// 48 hours in milliseconds (max window for trade queries)
const MS_48_HOURS = 48 * 60 * 60 * 1000;
// Default lookback: 180 days
const DEFAULT_LOOKBACK_MS = 180 * 24 * 60 * 60 * 1000;

async function htxFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, HTX_API, "/api/htx", init, signal);
}

/**
 * Sign an HTX API request.
 * Payload = "GET\napi.huobi.pro\n/path\nURL-encoded-sorted-params"
 * Signature = Base64(HMAC-SHA256(secret, payload))
 */
async function htxSign(
  method: string,
  path: string,
  params: URLSearchParams,
  secret: string,
): Promise<string> {
  // Sort params alphabetically
  const sorted = new URLSearchParams([...params.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  const payload = `${method}\n${HTX_HOST}\n${path}\n${sorted.toString()}`;
  return hmacSha256Base64(secret, payload);
}

/**
 * Build a signed URL for HTX API.
 * Auth params go in the query string, not headers.
 */
async function buildSignedUrl(
  path: string,
  extraParams: URLSearchParams,
  apiKey: string,
  apiSecret: string,
): Promise<string> {
  // Timestamp format: ISO UTC without milliseconds (2024-01-01T00:00:00)
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "");

  const params = new URLSearchParams(extraParams);
  params.set("AccessKeyId", apiKey);
  params.set("SignatureMethod", "HmacSHA256");
  params.set("SignatureVersion", "2");
  params.set("Timestamp", timestamp);

  const signature = await htxSign("GET", path, params, apiSecret);
  params.set("Signature", signature);

  return `${HTX_API}${path}?${params.toString()}`;
}

// --- API response types ---

interface HtxResponse<T> {
  status: string;
  data: T;
  "err-code"?: string;
  "err-msg"?: string;
}

interface HtxTrade {
  id: number;
  symbol: string;
  "order-id": number;
  "match-id": number;
  type: string; // "buy-market", "sell-limit", etc.
  price: string;
  "filled-amount": string;
  "filled-fees": string;
  "fee-currency": string;
  "created-at": number;
  role: string;
}

interface HtxDepositWithdrawal {
  id: number;
  type: string; // "deposit" or "withdraw"
  currency: string;
  amount: number;
  fee: number;
  "tx-hash": string;
  chain: string;
  state: string;
  "created-at": number;
  "updated-at": number;
}

const KNOWN_QUOTES = ["usdt", "btc", "eth", "husd", "usdc", "eur"];

function parseSymbol(symbol: string): { base: string; quote: string } | null {
  for (const q of KNOWN_QUOTES) {
    if (symbol.endsWith(q)) {
      const base = symbol.slice(0, -q.length);
      if (base.length > 0) return { base: base.toUpperCase(), quote: q.toUpperCase() };
    }
  }
  return null;
}

function parseTradeType(type: string): "buy" | "sell" {
  // HTX types: "buy-market", "buy-limit", "sell-market", "sell-limit", etc.
  return type.startsWith("buy") ? "buy" : "sell";
}

export class HtxAdapter implements CexAdapter {
  readonly exchangeId = "htx" as const;
  readonly exchangeName = "HTX";

  normalizeAsset(raw: string): string {
    // HTX returns asset names in lowercase
    return raw.toUpperCase();
  }

  async fetchLedgerRecords(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];

    const tradeRecords = await this.fetchTrades(apiKey, apiSecret, since, signal);
    records.push(...tradeRecords);

    const depositRecords = await this.fetchDeposits(apiKey, apiSecret, since, signal);
    records.push(...depositRecords);

    const withdrawalRecords = await this.fetchWithdrawals(apiKey, apiSecret, since, signal);
    records.push(...withdrawalRecords);

    return records;
  }

  /**
   * Fetch trade match results using 48-hour rolling windows.
   * HTX /v1/order/matchresults has a 48-hour max window per request.
   */
  private async fetchTrades(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    const now = Date.now();
    const startMs = since ? since * 1000 : now - DEFAULT_LOOKBACK_MS;

    let windowStart = startMs;

    while (windowStart < now) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const windowEnd = Math.min(windowStart + MS_48_HOURS, now);

      const params = new URLSearchParams({
        "start-time": String(windowStart),
        "end-time": String(windowEnd),
        size: "500",
      });

      const url = await buildSignedUrl("/v1/order/matchresults", params, apiKey, apiSecret);
      const result = await htxFetch(url, { method: "GET" }, signal);

      const json = JSON.parse(result.body) as HtxResponse<HtxTrade[]>;
      if (json.status !== "ok") {
        throw new Error(`HTX API error: ${json["err-msg"] ?? json["err-code"]}`);
      }

      if (json.data && json.data.length > 0) {
        for (const trade of json.data) {
          const parsed = parseSymbol(trade.symbol);
          if (!parsed) continue;

          const { base, quote } = parsed;
          const refid = `${trade.symbol}:${trade["match-id"]}`;
          const side = parseTradeType(trade.type);
          const isBuy = side === "buy";
          const qty = trade["filled-amount"];
          const quoteAmount = String(parseFloat(qty) * parseFloat(trade.price));
          const feeCurrency = this.normalizeAsset(trade["fee-currency"]);
          const absFee = String(Math.abs(parseFloat(trade["filled-fees"])));

          const tradeMeta: Record<string, string> = {
            "trade:symbol": trade.symbol,
            "trade:side": side,
            "trade:price": trade.price,
            "trade:quantity": qty,
            "trade:quote_amount": quoteAmount,
            "trade:commission": absFee,
            "trade:commission_asset": feeCurrency,
            "trade:order_id": String(trade["order-id"]),
            "trade:role": trade.role,
          };

          // Base asset record
          records.push({
            refid,
            type: "trade",
            asset: base,
            amount: isBuy ? qty : `-${qty}`,
            fee: feeCurrency === base ? absFee : "0",
            timestamp: trade["created-at"] / 1000,
            txid: null,
            metadata: tradeMeta,
          });

          // Quote asset record
          records.push({
            refid,
            type: "trade",
            asset: quote,
            amount: isBuy ? `-${quoteAmount}` : quoteAmount,
            fee: feeCurrency === quote ? absFee : "0",
            timestamp: trade["created-at"] / 1000,
            txid: null,
            metadata: tradeMeta,
          });

          // If commission asset is neither base nor quote
          if (feeCurrency !== base && feeCurrency !== quote) {
            records.push({
              refid,
              type: "trade",
              asset: feeCurrency,
              amount: "0",
              fee: absFee,
              timestamp: trade["created-at"] / 1000,
              txid: null,
              metadata: tradeMeta,
            });
          }
        }
      }

      windowStart = windowEnd;
      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }

  private async fetchDeposits(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let fromId: number | undefined;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({
        type: "deposit",
        size: "500",
      });
      if (fromId !== undefined) {
        params.set("from", String(fromId));
      }

      const url = await buildSignedUrl("/v1/query/deposit-withdraw", params, apiKey, apiSecret);
      const result = await htxFetch(url, { method: "GET" }, signal);

      const json = JSON.parse(result.body) as HtxResponse<HtxDepositWithdrawal[]>;
      if (json.status !== "ok") {
        throw new Error(`HTX API error: ${json["err-msg"] ?? json["err-code"]}`);
      }

      if (!json.data || json.data.length === 0) break;

      for (const dep of json.data) {
        // Filter by since timestamp
        if (since && dep["created-at"] / 1000 < since) continue;

        // Only include confirmed deposits
        if (dep.state !== "safe" && dep.state !== "confirmed") continue;

        records.push({
          refid: `deposit:${dep.id}`,
          type: "deposit",
          asset: this.normalizeAsset(dep.currency),
          amount: String(dep.amount),
          fee: String(dep.fee),
          timestamp: dep["created-at"] / 1000,
          txid: dep["tx-hash"] ? normalizeTxid(dep["tx-hash"]) : null,
          metadata: {
            "deposit:chain": dep.chain,
            "deposit:state": dep.state,
          },
        });
      }

      if (json.data.length < 500) break;
      fromId = json.data[json.data.length - 1].id;

      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }

  private async fetchWithdrawals(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let fromId: number | undefined;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({
        type: "withdraw",
        size: "500",
      });
      if (fromId !== undefined) {
        params.set("from", String(fromId));
      }

      const url = await buildSignedUrl("/v1/query/deposit-withdraw", params, apiKey, apiSecret);
      const result = await htxFetch(url, { method: "GET" }, signal);

      const json = JSON.parse(result.body) as HtxResponse<HtxDepositWithdrawal[]>;
      if (json.status !== "ok") {
        throw new Error(`HTX API error: ${json["err-msg"] ?? json["err-code"]}`);
      }

      if (!json.data || json.data.length === 0) break;

      for (const wd of json.data) {
        // Filter by since timestamp
        if (since && wd["created-at"] / 1000 < since) continue;

        // Only include confirmed withdrawals
        if (wd.state !== "confirmed") continue;

        records.push({
          refid: `withdraw:${wd.id}`,
          type: "withdrawal",
          asset: this.normalizeAsset(wd.currency),
          amount: `-${wd.amount}`,
          fee: String(wd.fee),
          timestamp: wd["created-at"] / 1000,
          txid: wd["tx-hash"] ? normalizeTxid(wd["tx-hash"]) : null,
          metadata: {
            "withdrawal:chain": wd.chain,
            "withdrawal:fee": String(wd.fee),
            "withdrawal:state": wd.state,
          },
        });
      }

      if (json.data.length < 500) break;
      fromId = json.data[json.data.length - 1].id;

      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }
}

// Re-export for tests
export { htxSign, buildSignedUrl };
