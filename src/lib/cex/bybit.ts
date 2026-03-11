import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";
import { hmacSha256Hex } from "./crypto-utils.js";

const BYBIT_API = "https://api.bybit.com";
const RECV_WINDOW = "5000";
const RATE_LIMIT_MS = 100;

// 7 days in milliseconds (max window for execution/list)
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
// 30 days in milliseconds (max window for deposit/withdrawal queries)
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
// Default lookback: 1 year
const DEFAULT_LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000;

async function bybitFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, BYBIT_API, "/api/bybit", init, signal);
}

/**
 * Sign a Bybit API request (GET).
 * Prehash = timestamp + apiKey + recvWindow + queryString
 * Signature = hex(HMAC-SHA256(secret, prehash))
 */
export async function bybitSign(
  timestamp: string,
  apiKey: string,
  recvWindow: string,
  queryString: string,
  secret: string,
): Promise<string> {
  const prehash = timestamp + apiKey + recvWindow + queryString;
  return hmacSha256Hex(secret, prehash);
}

/**
 * Known quote currencies for Bybit spot symbols.
 * Ordered longest-first so "USDT" matches before "T", etc.
 */
const KNOWN_QUOTES = ["USDT", "USDC", "BTC", "ETH", "EUR", "DAI"];

/**
 * Parse a Bybit spot symbol (e.g. "BTCUSDT") into base and quote assets.
 * Tries known quote suffixes longest-first.
 */
export function parseBybitSymbol(symbol: string): { base: string; quote: string } | null {
  for (const quote of KNOWN_QUOTES) {
    if (symbol.endsWith(quote) && symbol.length > quote.length) {
      return {
        base: symbol.slice(0, symbol.length - quote.length),
        quote,
      };
    }
  }
  return null;
}

// ---- Response types ----

interface BybitExecution {
  execId: string;
  symbol: string;
  side: string; // "Buy" | "Sell"
  execQty: string;
  execPrice: string;
  execFee: string;
  feeCurrency: string;
  execTime: string; // milliseconds as string
  orderId: string;
}

interface BybitExecutionResponse {
  retCode: number;
  retMsg: string;
  result: {
    list: BybitExecution[];
    nextPageCursor: string;
  };
}

interface BybitDeposit {
  coin: string;
  amount: string;
  txID: string;
  status: number;
  successAt: string; // milliseconds as string
}

interface BybitDepositResponse {
  retCode: number;
  retMsg: string;
  result: {
    rows: BybitDeposit[];
    nextPageCursor: string;
  };
}

interface BybitWithdrawal {
  coin: string;
  amount: string;
  txID: string;
  withdrawFee: string;
  createTime: string; // milliseconds as string
  status: string;
}

interface BybitWithdrawalResponse {
  retCode: number;
  retMsg: string;
  result: {
    rows: BybitWithdrawal[];
    nextPageCursor: string;
  };
}

// ---- Helpers ----

async function signedGet(
  path: string,
  queryString: string,
  apiKey: string,
  apiSecret: string,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  const timestamp = String(Date.now());
  const signature = await bybitSign(timestamp, apiKey, RECV_WINDOW, queryString, apiSecret);

  const url = `${BYBIT_API}${path}?${queryString}`;
  return bybitFetch(
    url,
    {
      method: "GET",
      headers: {
        "X-BAPI-API-KEY": apiKey,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-SIGN": signature,
        "X-BAPI-RECV-WINDOW": RECV_WINDOW,
      },
    },
    signal,
  );
}

// ---- Adapter ----

export class BybitAdapter implements CexAdapter {
  readonly exchangeId = "bybit" as const;
  readonly exchangeName = "Bybit";

  normalizeAsset(raw: string): string {
    // Bybit uses standard asset codes; no transformation needed
    return raw;
  }

  async fetchLedgerRecords(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];

    // Fetch trades, deposits, and withdrawals
    const trades = await this.fetchTrades(apiKey, apiSecret, since, signal);
    records.push(...trades);

    await abortableDelay(RATE_LIMIT_MS, signal);

    const deposits = await this.fetchDeposits(apiKey, apiSecret, since, signal);
    records.push(...deposits);

    await abortableDelay(RATE_LIMIT_MS, signal);

    const withdrawals = await this.fetchWithdrawals(apiKey, apiSecret, since, signal);
    records.push(...withdrawals);

    return records;
  }

  // ---- Trades (7-day windows, cursor pagination) ----

  private async fetchTrades(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    const now = Date.now();
    const startTime = since ? since * 1000 : now - DEFAULT_LOOKBACK_MS;

    // Iterate backward from now in 7-day chunks
    let chunkEnd = now;
    while (chunkEnd > startTime) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const chunkStart = Math.max(chunkEnd - SEVEN_DAYS_MS, startTime);
      let cursor = "";

      for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const params = new URLSearchParams({
          category: "spot",
          startTime: String(chunkStart),
          endTime: String(chunkEnd),
          limit: "100",
        });
        if (cursor) params.set("cursor", cursor);

        const result = await signedGet(
          "/v5/execution/list",
          params.toString(),
          apiKey,
          apiSecret,
          signal,
        );

        const json = JSON.parse(result.body) as BybitExecutionResponse;
        if (json.retCode !== 0) {
          throw new Error(`Bybit API error: ${json.retMsg}`);
        }

        const executions = json.result.list;
        if (executions.length === 0) break;

        for (const exec of executions) {
          const parsed = parseBybitSymbol(exec.symbol);
          if (!parsed) continue; // Skip unparseable symbols

          const { base, quote } = parsed;
          const qty = exec.execQty;
          const price = exec.execPrice;
          const isBuy = exec.side === "Buy";
          const ts = Number(exec.execTime) / 1000;

          // Compute quote amount = execQty * execPrice
          const quoteAmount = (parseFloat(qty) * parseFloat(price)).toString();

          const tradeMeta: Record<string, string> = {
            "trade:symbol": exec.symbol,
            "trade:side": exec.side.toLowerCase(),
            "trade:price": price,
            "trade:quantity": qty,
            "trade:commission": exec.execFee,
            "trade:commission_asset": exec.feeCurrency,
            "trade:order_id": exec.orderId,
          };

          // Base leg
          records.push({
            refid: exec.execId,
            type: "trade",
            asset: this.normalizeAsset(base),
            amount: isBuy ? qty : `-${qty}`,
            fee: exec.feeCurrency === base ? exec.execFee : "0",
            timestamp: ts,
            txid: null,
            metadata: tradeMeta,
          });

          // Quote leg
          records.push({
            refid: exec.execId,
            type: "trade",
            asset: this.normalizeAsset(quote),
            amount: isBuy ? `-${quoteAmount}` : quoteAmount,
            fee: exec.feeCurrency === quote ? exec.execFee : "0",
            timestamp: ts,
            txid: null,
            metadata: tradeMeta,
          });
        }

        cursor = json.result.nextPageCursor;
        if (!cursor) break;

        await abortableDelay(RATE_LIMIT_MS, signal);
      }

      chunkEnd = chunkEnd - SEVEN_DAYS_MS;
      if (chunkEnd > startTime) {
        await abortableDelay(RATE_LIMIT_MS, signal);
      }
    }

    return records;
  }

  // ---- Deposits (30-day windows, cursor pagination) ----

  private async fetchDeposits(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    const now = Date.now();
    const startTime = since ? since * 1000 : now - DEFAULT_LOOKBACK_MS;

    let chunkEnd = now;
    while (chunkEnd > startTime) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const chunkStart = Math.max(chunkEnd - THIRTY_DAYS_MS, startTime);
      let cursor = "";

      for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const params = new URLSearchParams({
          startTime: String(chunkStart),
          endTime: String(chunkEnd),
          limit: "50",
        });
        if (cursor) params.set("cursor", cursor);

        const result = await signedGet(
          "/v5/asset/deposit/query-record",
          params.toString(),
          apiKey,
          apiSecret,
          signal,
        );

        const json = JSON.parse(result.body) as BybitDepositResponse;
        if (json.retCode !== 0) {
          throw new Error(`Bybit API error: ${json.retMsg}`);
        }

        const rows = json.result.rows ?? [];
        if (rows.length === 0) break;

        for (const dep of rows) {
          const txid = dep.txID ? normalizeTxid(dep.txID) : null;
          const refid = dep.txID
            ? `deposit:${dep.txID}`
            : `${dep.coin}:${dep.successAt}`;

          records.push({
            refid,
            type: "deposit",
            asset: this.normalizeAsset(dep.coin),
            amount: dep.amount,
            fee: "0",
            timestamp: Number(dep.successAt) / 1000,
            txid,
          });
        }

        cursor = json.result.nextPageCursor;
        if (!cursor) break;

        await abortableDelay(RATE_LIMIT_MS, signal);
      }

      chunkEnd = chunkEnd - THIRTY_DAYS_MS;
      if (chunkEnd > startTime) {
        await abortableDelay(RATE_LIMIT_MS, signal);
      }
    }

    return records;
  }

  // ---- Withdrawals (30-day windows, cursor pagination) ----

  private async fetchWithdrawals(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    const now = Date.now();
    const startTime = since ? since * 1000 : now - DEFAULT_LOOKBACK_MS;

    let chunkEnd = now;
    while (chunkEnd > startTime) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const chunkStart = Math.max(chunkEnd - THIRTY_DAYS_MS, startTime);
      let cursor = "";

      for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const params = new URLSearchParams({
          startTime: String(chunkStart),
          endTime: String(chunkEnd),
          limit: "50",
        });
        if (cursor) params.set("cursor", cursor);

        const result = await signedGet(
          "/v5/asset/withdraw/query-record",
          params.toString(),
          apiKey,
          apiSecret,
          signal,
        );

        const json = JSON.parse(result.body) as BybitWithdrawalResponse;
        if (json.retCode !== 0) {
          throw new Error(`Bybit API error: ${json.retMsg}`);
        }

        const rows = json.result.rows ?? [];
        if (rows.length === 0) break;

        for (const wd of rows) {
          const txid = wd.txID ? normalizeTxid(wd.txID) : null;

          records.push({
            refid: `withdraw:${wd.txID}`,
            type: "withdrawal",
            asset: this.normalizeAsset(wd.coin),
            amount: `-${wd.amount}`,
            fee: wd.withdrawFee,
            timestamp: Number(wd.createTime) / 1000,
            txid,
          });
        }

        cursor = json.result.nextPageCursor;
        if (!cursor) break;

        await abortableDelay(RATE_LIMIT_MS, signal);
      }

      chunkEnd = chunkEnd - THIRTY_DAYS_MS;
      if (chunkEnd > startTime) {
        await abortableDelay(RATE_LIMIT_MS, signal);
      }
    }

    return records;
  }
}
