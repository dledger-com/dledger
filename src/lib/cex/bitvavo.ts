import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";
import { hmacSha256Hex } from "./crypto-utils.js";

const BITVAVO_API = "https://api.bitvavo.com";
const PROXY_PREFIX = "/api/bitvavo";
const RATE_LIMIT_MS = 100;

interface BitvavoTrade {
  id: string;
  orderId: string;
  timestamp: number;       // ms
  market: string;
  side: string;            // "buy" | "sell"
  amount: string;          // base quantity
  price: string;
  fee: string;
  feeCurrency: string;
  settled: boolean;
}

interface BitvavoDeposit {
  timestamp: number;       // ms
  symbol: string;
  amount: string;
  fee: string;
  txId: string;
  status: string;
}

interface BitvavoWithdrawal {
  timestamp: number;       // ms
  symbol: string;
  amount: string;
  fee: string;
  txId: string;
  status: string;
}

interface BitvavoMarket {
  market: string;
  status: string;
  base: string;
  quote: string;
}

async function bitvavoFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, BITVAVO_API, PROXY_PREFIX, init, signal);
}

/**
 * Sign a Bitvavo API request.
 * signature = hex(HMAC_SHA256(secret, timestamp + method + "/v2/endpoint" + body))
 */
async function bitvavoSign(
  timestamp: string,
  method: string,
  urlPath: string,
  body: string,
  secret: string,
): Promise<string> {
  const signString = timestamp + method + urlPath + body;
  return hmacSha256Hex(secret, signString);
}

export class BitvavoAdapter implements CexAdapter {
  readonly exchangeId = "bitvavo" as const;
  readonly exchangeName = "Bitvavo";

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
    const queryString = params.toString();
    const urlPath = queryString ? `${path}?${queryString}` : path;

    const signature = await bitvavoSign(timestamp, "GET", urlPath, "", apiSecret);
    const url = `${BITVAVO_API}${urlPath}`;

    return bitvavoFetch(url, {
      method: "GET",
      headers: {
        "Bitvavo-Access-Key": apiKey,
        "Bitvavo-Access-Timestamp": timestamp,
        "Bitvavo-Access-Signature": signature,
        "Bitvavo-Access-Window": "10000",
      },
    }, signal);
  }

  /**
   * Fetch active markets to know which trading pairs to query for trades.
   */
  private async fetchMarkets(signal?: AbortSignal): Promise<BitvavoMarket[]> {
    try {
      const result = await bitvavoFetch(`${BITVAVO_API}/v2/markets`, { method: "GET" }, signal);
      const markets = JSON.parse(result.body) as BitvavoMarket[];
      if (Array.isArray(markets)) return markets.filter((m) => m.status === "trading");
    } catch {
      // Fallback — return empty
    }
    return [];
  }

  private async fetchTrades(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];

    // Fetch available markets first
    const markets = await this.fetchMarkets(signal);
    await abortableDelay(RATE_LIMIT_MS, signal);

    for (const market of markets) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      let tradeIdFrom: string | undefined;

      for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const params = new URLSearchParams({
          market: market.market,
          limit: "1000",
        });
        if (tradeIdFrom) {
          params.set("tradeIdFrom", tradeIdFrom);
        }
        if (since && !tradeIdFrom) {
          params.set("start", String(Math.floor(since * 1000)));
        }

        const result = await this.signedGet("/v2/trades", params, apiKey, apiSecret, signal);
        const trades = JSON.parse(result.body) as BitvavoTrade[];

        if (!Array.isArray(trades) || trades.length === 0) break;

        for (const trade of trades) {
          const base = market.base;
          const quote = market.quote;
          const refid = `${market.market}:${trade.id}`;
          const isBuy = trade.side === "buy";
          const ts = trade.timestamp / 1000;
          const quoteAmount = (parseFloat(trade.price) * parseFloat(trade.amount)).toString();

          const tradeMeta: Record<string, string> = {
            "trade:symbol": market.market,
            "trade:side": trade.side,
            "trade:price": trade.price,
          };

          // Base asset record
          records.push({
            refid,
            type: "trade",
            asset: this.normalizeAsset(base),
            amount: isBuy ? trade.amount : `-${trade.amount}`,
            fee: trade.feeCurrency?.toUpperCase() === base.toUpperCase() ? trade.fee : "0",
            timestamp: ts,
            txid: null,
            metadata: tradeMeta,
          });

          // Quote asset record
          records.push({
            refid,
            type: "trade",
            asset: this.normalizeAsset(quote),
            amount: isBuy ? `-${quoteAmount}` : quoteAmount,
            fee: trade.feeCurrency?.toUpperCase() === quote.toUpperCase() ? trade.fee : "0",
            timestamp: ts,
            txid: null,
            metadata: tradeMeta,
          });

          // Fee in third currency
          if (trade.feeCurrency && trade.feeCurrency.toUpperCase() !== base.toUpperCase() && trade.feeCurrency.toUpperCase() !== quote.toUpperCase()) {
            records.push({
              refid,
              type: "trade",
              asset: this.normalizeAsset(trade.feeCurrency),
              amount: "0",
              fee: trade.fee,
              timestamp: ts,
              txid: null,
              metadata: tradeMeta,
            });
          }
        }

        if (trades.length < 1000) break;
        tradeIdFrom = trades[trades.length - 1].id;
        await abortableDelay(RATE_LIMIT_MS, signal);
      }

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

    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const params = new URLSearchParams();
    if (since) {
      params.set("start", String(Math.floor(since * 1000)));
    }

    const result = await this.signedGet("/v2/depositHistory", params, apiKey, apiSecret, signal);
    const deposits = JSON.parse(result.body) as BitvavoDeposit[];

    if (!Array.isArray(deposits)) return records;

    for (const dep of deposits) {
      records.push({
        refid: `deposit:${dep.txId || dep.timestamp}`,
        type: "deposit",
        asset: this.normalizeAsset(dep.symbol),
        amount: dep.amount,
        fee: dep.fee || "0",
        timestamp: dep.timestamp / 1000,
        txid: dep.txId ? normalizeTxid(dep.txId) : null,
        metadata: {
          "deposit:status": dep.status,
        },
      });
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

    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const params = new URLSearchParams();
    if (since) {
      params.set("start", String(Math.floor(since * 1000)));
    }

    const result = await this.signedGet("/v2/withdrawalHistory", params, apiKey, apiSecret, signal);
    const withdrawals = JSON.parse(result.body) as BitvavoWithdrawal[];

    if (!Array.isArray(withdrawals)) return records;

    for (const wd of withdrawals) {
      records.push({
        refid: `withdraw:${wd.txId || wd.timestamp}`,
        type: "withdrawal",
        asset: this.normalizeAsset(wd.symbol),
        amount: `-${wd.amount}`,
        fee: wd.fee || "0",
        timestamp: wd.timestamp / 1000,
        txid: wd.txId ? normalizeTxid(wd.txId) : null,
        metadata: {
          "withdrawal:status": wd.status,
        },
      });
    }

    return records;
  }
}
