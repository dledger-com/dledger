import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";
import { hmacSha256Hex } from "./crypto-utils.js";

const XTCOM_API = "https://sapi.xt.com";
const PROXY_PREFIX = "/api/xtcom";
const RATE_LIMIT_MS = 150;

interface XtcomResponse<T> {
  rc: number;
  mc: string;
  result: T;
}

interface XtcomTrade {
  tradeId: string;
  symbol: string;
  side: string;         // "BUY" | "SELL"
  price: string;
  quantity: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
}

interface XtcomTradeResult {
  items: XtcomTrade[];
  total: number;
}

interface XtcomDeposit {
  id: string;
  coin: string;
  amount: string;
  fee: string;
  txId: string;
  network: string;
  status: string;
  createdAt: number;
}

interface XtcomDepositResult {
  items: XtcomDeposit[];
  total: number;
}

interface XtcomWithdrawal {
  id: string;
  coin: string;
  amount: string;
  fee: string;
  txId: string;
  network: string;
  status: string;
  createdAt: number;
}

interface XtcomWithdrawalResult {
  items: XtcomWithdrawal[];
  total: number;
}

async function xtcomFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, XTCOM_API, PROXY_PREFIX, init, signal);
}

/**
 * Sign an XT.COM API request.
 * signature = hex(HMAC_SHA256(secret, METHOD + path + sortedQueryParams))
 */
async function xtcomSign(
  method: string,
  path: string,
  params: URLSearchParams,
  secret: string,
): Promise<string> {
  const sorted = new URLSearchParams([...params.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  const queryString = sorted.toString();
  const signString = method.toUpperCase() + path + queryString;
  return hmacSha256Hex(secret, signString);
}

function parseSymbol(symbol: string): { base: string; quote: string } | null {
  const parts = symbol.split("_");
  if (parts.length === 2) return { base: parts[0].toUpperCase(), quote: parts[1].toUpperCase() };
  return null;
}

export class XtcomAdapter implements CexAdapter {
  readonly exchangeId = "xtcom" as const;
  readonly exchangeName = "XT.COM";

  normalizeAsset(raw: string): string {
    return raw.toUpperCase();
  }

  async fetchLedgerRecords(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];

    const trades = await this.fetchTrades(apiKey, apiSecret, since, signal);
    records.push(...trades);

    const deposits = await this.fetchDeposits(apiKey, apiSecret, since, signal);
    records.push(...deposits);

    const withdrawals = await this.fetchWithdrawals(apiKey, apiSecret, since, signal);
    records.push(...withdrawals);

    return records;
  }

  private async signedGet(
    path: string,
    params: URLSearchParams,
    apiKey: string,
    apiSecret: string,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: string }> {
    const timestamp = String(Date.now());
    params.set("timestamp", timestamp);

    const signature = await xtcomSign("GET", path, params, apiSecret);
    const queryString = params.toString();
    const url = `${XTCOM_API}${path}?${queryString}`;

    return xtcomFetch(url, {
      method: "GET",
      headers: {
        "validate-appkey": apiKey,
        "validate-timestamp": timestamp,
        "xt-validate-signature": signature,
        "validate-algorithms": "HmacSHA256",
      },
    }, signal);
  }

  private async fetchTrades(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let offset = 0;
    const limit = 500;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
      });
      if (since) {
        params.set("startTime", String(Math.floor(since * 1000)));
      }

      const result = await this.signedGet("/v4/order/trade", params, apiKey, apiSecret, signal);
      const json = JSON.parse(result.body) as XtcomResponse<XtcomTradeResult>;

      if (json.rc !== 0) throw new Error(`XT.COM API error: ${json.mc}`);

      const items = json.result?.items;
      if (!items || items.length === 0) break;

      for (const trade of items) {
        const parsed = parseSymbol(trade.symbol);
        if (!parsed) continue;

        const { base, quote } = parsed;
        const refid = `${trade.symbol}:${trade.tradeId}`;
        const isBuy = trade.side === "BUY";
        const ts = trade.time / 1000;

        const tradeMeta: Record<string, string> = {
          "trade:symbol": trade.symbol,
          "trade:side": trade.side.toLowerCase(),
          "trade:price": trade.price,
        };

        // Base asset record
        records.push({
          refid,
          type: "trade",
          asset: this.normalizeAsset(base),
          amount: isBuy ? trade.quantity : `-${trade.quantity}`,
          fee: trade.commissionAsset?.toUpperCase() === base ? trade.commission : "0",
          timestamp: ts,
          txid: null,
          metadata: tradeMeta,
        });

        // Quote asset record
        records.push({
          refid,
          type: "trade",
          asset: this.normalizeAsset(quote),
          amount: isBuy ? `-${trade.quoteQty}` : trade.quoteQty,
          fee: trade.commissionAsset?.toUpperCase() === quote ? trade.commission : "0",
          timestamp: ts,
          txid: null,
          metadata: tradeMeta,
        });

        // Fee in third currency
        if (trade.commissionAsset && trade.commissionAsset.toUpperCase() !== base && trade.commissionAsset.toUpperCase() !== quote) {
          records.push({
            refid,
            type: "trade",
            asset: this.normalizeAsset(trade.commissionAsset),
            amount: "0",
            fee: trade.commission,
            timestamp: ts,
            txid: null,
            metadata: tradeMeta,
          });
        }
      }

      if (items.length < limit) break;
      offset += items.length;
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
    let offset = 0;
    const limit = 500;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
      });
      if (since) {
        params.set("startTime", String(Math.floor(since * 1000)));
      }

      const result = await this.signedGet("/v4/balance/deposit/history", params, apiKey, apiSecret, signal);
      const json = JSON.parse(result.body) as XtcomResponse<XtcomDepositResult>;

      if (json.rc !== 0) throw new Error(`XT.COM API error: ${json.mc}`);

      const items = json.result?.items;
      if (!items || items.length === 0) break;

      for (const dep of items) {
        records.push({
          refid: `deposit:${dep.id}`,
          type: "deposit",
          asset: this.normalizeAsset(dep.coin),
          amount: dep.amount,
          fee: dep.fee || "0",
          timestamp: dep.createdAt / 1000,
          txid: dep.txId ? normalizeTxid(dep.txId) : null,
          metadata: {
            "deposit:network": dep.network,
            "deposit:status": dep.status,
          },
        });
      }

      if (items.length < limit) break;
      offset += items.length;
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
    let offset = 0;
    const limit = 500;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
      });
      if (since) {
        params.set("startTime", String(Math.floor(since * 1000)));
      }

      const result = await this.signedGet("/v4/balance/withdraw/history", params, apiKey, apiSecret, signal);
      const json = JSON.parse(result.body) as XtcomResponse<XtcomWithdrawalResult>;

      if (json.rc !== 0) throw new Error(`XT.COM API error: ${json.mc}`);

      const items = json.result?.items;
      if (!items || items.length === 0) break;

      for (const wd of items) {
        records.push({
          refid: `withdraw:${wd.id}`,
          type: "withdrawal",
          asset: this.normalizeAsset(wd.coin),
          amount: `-${wd.amount}`,
          fee: wd.fee || "0",
          timestamp: wd.createdAt / 1000,
          txid: wd.txId ? normalizeTxid(wd.txId) : null,
          metadata: {
            "withdrawal:network": wd.network,
            "withdrawal:status": wd.status,
          },
        });
      }

      if (items.length < limit) break;
      offset += items.length;
      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }
}
