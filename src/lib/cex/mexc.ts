import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";
import { hmacSha256Hex } from "./crypto-utils.js";

const MEXC_API = "https://api.mexc.com";
const RATE_LIMIT_MS = 100;

// 90 days in milliseconds (max window for deposit/withdrawal queries)
const MS_90_DAYS = 90 * 24 * 60 * 60 * 1000;

const QUOTE_CURRENCIES = ["USDT", "USDC", "BTC", "ETH", "EUR"];

async function mexcFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, MEXC_API, "/api/mexc", init, signal);
}

/**
 * Sign a MEXC API request (Binance V3 compatible).
 * Signature = hex(HMAC-SHA256(secret, queryString))
 */
async function mexcSign(queryString: string, secret: string): Promise<string> {
  return hmacSha256Hex(secret, queryString);
}

// --- API response types ---

interface MexcTrade {
  id: string;
  symbol: string;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
  orderId: string;
}

interface MexcDeposit {
  id: string;
  amount: string;
  coin: string;
  network: string;
  txId: string;
  status: string;
  insertTime: number;
}

interface MexcWithdrawal {
  id: string;
  amount: string;
  coin: string;
  network: string;
  txId: string;
  transactionFee: string;
  applyTime: string;
  status: string;
}

interface MexcCoinConfig {
  coin: string;
}

function parseSymbol(symbol: string): { base: string; quote: string } | null {
  for (const q of QUOTE_CURRENCIES) {
    if (symbol.endsWith(q)) {
      const base = symbol.slice(0, -q.length);
      if (base.length > 0) return { base, quote: q };
    }
  }
  return null;
}

export class MexcAdapter implements CexAdapter {
  readonly exchangeId = "mexc" as const;
  readonly exchangeName = "MEXC";

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

    const tradeRecords = await this.fetchTrades(apiKey, apiSecret, since, signal);
    records.push(...tradeRecords);

    const depositRecords = await this.fetchDeposits(apiKey, apiSecret, since, signal);
    records.push(...depositRecords);

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
    params.set("timestamp", String(Date.now()));
    const queryString = params.toString();
    const signature = await mexcSign(queryString, apiSecret);
    const url = `${MEXC_API}${path}?${queryString}&signature=${signature}`;

    return mexcFetch(
      url,
      {
        method: "GET",
        headers: { "X-MEXC-APIKEY": apiKey },
      },
      signal,
    );
  }

  /**
   * Discover user coins via /api/v3/capital/config/getall to build candidate trade pairs.
   */
  private async fetchUserCoins(
    apiKey: string,
    apiSecret: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    try {
      const params = new URLSearchParams();
      const result = await this.signedGet("/api/v3/capital/config/getall", params, apiKey, apiSecret, signal);
      const json = JSON.parse(result.body) as MexcCoinConfig[];
      if (!Array.isArray(json)) return [];
      return json.map((c) => c.coin);
    } catch {
      return [];
    }
  }

  private deriveCandidatePairs(coins: string[]): string[] {
    const pairs: string[] = [];
    for (const coin of coins) {
      for (const quote of QUOTE_CURRENCIES) {
        if (coin !== quote) {
          pairs.push(coin + quote);
        }
      }
    }
    return pairs;
  }

  private async fetchTrades(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];

    const coins = await this.fetchUserCoins(apiKey, apiSecret, signal);
    if (coins.length === 0) return records;
    await abortableDelay(RATE_LIMIT_MS, signal);

    const candidatePairs = this.deriveCandidatePairs(coins);

    for (const symbol of candidatePairs) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const parsed = parseSymbol(symbol);
      if (!parsed) continue;

      let fromId: string | undefined;
      let hasMore = true;

      while (hasMore) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const params = new URLSearchParams({
          symbol,
          limit: "1000",
        });
        if (fromId) {
          params.set("fromId", fromId);
        } else if (since) {
          params.set("startTime", String(since * 1000));
        }

        const result = await this.signedGet("/api/v3/myTrades", params, apiKey, apiSecret, signal);
        const trades = JSON.parse(result.body) as MexcTrade[];

        if (!Array.isArray(trades) || trades.length === 0) {
          hasMore = false;
          break;
        }

        for (const trade of trades) {
          const { base, quote } = parsed;
          const refid = `${trade.symbol}:${trade.id}`;

          const tradeMeta: Record<string, string> = {
            "trade:symbol": trade.symbol,
            "trade:side": trade.isBuyer ? "buy" : "sell",
            "trade:price": trade.price,
            "trade:quantity": trade.qty,
            "trade:quote_amount": trade.quoteQty,
            "trade:commission": trade.commission,
            "trade:commission_asset": trade.commissionAsset,
            "trade:order_id": trade.orderId,
          };

          // Base asset record
          records.push({
            refid,
            type: "trade",
            asset: this.normalizeAsset(base),
            amount: trade.isBuyer ? trade.qty : `-${trade.qty}`,
            fee: trade.commissionAsset === base ? trade.commission : "0",
            timestamp: trade.time / 1000,
            txid: null,
            metadata: tradeMeta,
          });

          // Quote asset record
          records.push({
            refid,
            type: "trade",
            asset: this.normalizeAsset(quote),
            amount: trade.isBuyer ? `-${trade.quoteQty}` : trade.quoteQty,
            fee: trade.commissionAsset === quote ? trade.commission : "0",
            timestamp: trade.time / 1000,
            txid: null,
            metadata: tradeMeta,
          });

          // If commission asset is neither base nor quote
          if (trade.commissionAsset !== base && trade.commissionAsset !== quote) {
            records.push({
              refid,
              type: "trade",
              asset: this.normalizeAsset(trade.commissionAsset),
              amount: "0",
              fee: trade.commission,
              timestamp: trade.time / 1000,
              txid: null,
              metadata: tradeMeta,
            });
          }
        }

        if (trades.length < 1000) {
          hasMore = false;
        } else {
          fromId = trades[trades.length - 1].id;
        }

        await abortableDelay(RATE_LIMIT_MS, signal);
      }

      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }

  /**
   * Fetch deposits using 90-day rolling windows from `since` to now.
   */
  private async fetchDeposits(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    const now = Date.now();
    let windowStart = since ? since * 1000 : now - MS_90_DAYS;

    while (windowStart < now) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const windowEnd = Math.min(windowStart + MS_90_DAYS, now);
      const params = new URLSearchParams({
        startTime: String(windowStart),
        endTime: String(windowEnd),
      });

      const result = await this.signedGet("/api/v3/capital/deposit/hisrec", params, apiKey, apiSecret, signal);
      const deposits = JSON.parse(result.body) as MexcDeposit[];

      if (Array.isArray(deposits)) {
        for (const dep of deposits) {
          records.push({
            refid: `deposit:${dep.id}`,
            type: "deposit",
            asset: this.normalizeAsset(dep.coin),
            amount: dep.amount,
            fee: "0",
            timestamp: dep.insertTime / 1000,
            txid: dep.txId ? normalizeTxid(dep.txId) : null,
            metadata: {
              "deposit:network": dep.network,
              "deposit:status": dep.status,
            },
          });
        }
      }

      windowStart = windowEnd;
      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }

  /**
   * Fetch withdrawals using 90-day rolling windows from `since` to now.
   */
  private async fetchWithdrawals(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    const now = Date.now();
    let windowStart = since ? since * 1000 : now - MS_90_DAYS;

    while (windowStart < now) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const windowEnd = Math.min(windowStart + MS_90_DAYS, now);
      const params = new URLSearchParams({
        startTime: String(windowStart),
        endTime: String(windowEnd),
      });

      const result = await this.signedGet("/api/v3/capital/withdraw/history", params, apiKey, apiSecret, signal);
      const withdrawals = JSON.parse(result.body) as MexcWithdrawal[];

      if (Array.isArray(withdrawals)) {
        for (const wd of withdrawals) {
          records.push({
            refid: `withdraw:${wd.id}`,
            type: "withdrawal",
            asset: this.normalizeAsset(wd.coin),
            amount: `-${wd.amount}`,
            fee: wd.transactionFee,
            timestamp: Date.parse(wd.applyTime) / 1000,
            txid: wd.txId ? normalizeTxid(wd.txId) : null,
            metadata: {
              "withdrawal:network": wd.network,
              "withdrawal:fee": wd.transactionFee,
              "withdrawal:status": wd.status,
            },
          });
        }
      }

      windowStart = windowEnd;
      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }
}

// Re-export for tests
export { mexcSign };
