import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";
import { hmacSha256Hex } from "./crypto-utils.js";

const BINANCE_API = "https://api.binance.com";

async function binanceFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, BINANCE_API, "/api/binance", init, signal);
}

// Binance asset code → standard code mapping.
// Binance mostly uses standard ticker symbols already.
const BINANCE_ASSET_MAP: Record<string, string> = {
  IOTA: "MIOTA",
  YOOSHI: "YOOSHI",
};

const QUOTE_CURRENCIES = ["USDT", "BTC", "ETH", "BNB", "FDUSD", "EUR"];

/**
 * Sign a Binance API request.
 * Signature = hex(HMAC-SHA256(secret, queryString))
 */
async function binanceSign(queryString: string, secret: string): Promise<string> {
  return hmacSha256Hex(secret, queryString);
}

interface BinanceTrade {
  id: number;
  symbol: string;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
}

interface BinanceDeposit {
  id: string;
  amount: string;
  coin: string;
  network: string;
  txId: string;
  status: number;
  insertTime: number;
}

interface BinanceWithdrawal {
  id: string;
  amount: string;
  coin: string;
  network: string;
  txId: string;
  transactionFee: string;
  applyTime: string;
  status: number;
}

interface BinanceAssetConfig {
  coin: string;
  free: string;
  locked: string;
  freeze: string;
  withdrawing: string;
}

/**
 * Extract base and quote assets from a trading symbol given a list of known quote currencies.
 * Returns null if no known quote is found.
 */
function parseSymbol(symbol: string): { base: string; quote: string } | null {
  for (const q of QUOTE_CURRENCIES) {
    if (symbol.endsWith(q)) {
      const base = symbol.slice(0, -q.length);
      if (base.length > 0) return { base, quote: q };
    }
  }
  return null;
}

export class BinanceAdapter implements CexAdapter {
  readonly exchangeId = "binance" as const;
  readonly exchangeName = "Binance";

  normalizeAsset(raw: string): string {
    if (BINANCE_ASSET_MAP[raw]) return BINANCE_ASSET_MAP[raw];
    return raw;
  }

  async fetchLedgerRecords(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];

    // 1. Fetch trades
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
    params.set("timestamp", String(Date.now()));
    const queryString = params.toString();
    const signature = await binanceSign(queryString, apiSecret);
    const url = `${BINANCE_API}${path}?${queryString}&signature=${signature}`;

    return binanceFetch(
      url,
      {
        method: "GET",
        headers: { "X-MBX-APIKEY": apiKey },
      },
      signal,
    );
  }

  /**
   * Fetch user assets to discover which trading pairs to query.
   */
  private async fetchUserAssets(
    apiKey: string,
    apiSecret: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const params = new URLSearchParams();
    const result = await this.signedGet("/sapi/v1/capital/config/getall", params, apiKey, apiSecret, signal);
    const json = JSON.parse(result.body) as BinanceAssetConfig[];

    // Return coins that have any balance (free, locked, freeze, withdrawing)
    const coins: string[] = [];
    for (const entry of json) {
      const hasBalance =
        parseFloat(entry.free) > 0 ||
        parseFloat(entry.locked) > 0 ||
        parseFloat(entry.freeze) > 0 ||
        parseFloat(entry.withdrawing) > 0;
      if (hasBalance) {
        coins.push(entry.coin);
      }
    }
    return coins;
  }

  /**
   * Derive candidate trading pair symbols from user assets.
   */
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

    // Discover user assets and derive candidate pairs
    const coins = await this.fetchUserAssets(apiKey, apiSecret, signal);
    await abortableDelay(100, signal);

    const candidatePairs = this.deriveCandidatePairs(coins);

    for (const symbol of candidatePairs) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const parsed = parseSymbol(symbol);
      if (!parsed) continue;

      let fromId: number | undefined;
      let hasMore = true;

      while (hasMore) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const params = new URLSearchParams({
          symbol,
          limit: "1000",
        });
        if (fromId !== undefined) {
          params.set("fromId", String(fromId));
        } else if (since) {
          // For the first page, use startTime to filter by since
          params.set("startTime", String(since * 1000));
        }

        const result = await this.signedGet("/api/v3/myTrades", params, apiKey, apiSecret, signal);
        const trades = JSON.parse(result.body) as BinanceTrade[];

        if (!Array.isArray(trades) || trades.length === 0) {
          hasMore = false;
          break;
        }

        for (const trade of trades) {
          const refid = `${trade.symbol}:${trade.id}`;
          const { base, quote } = parsed;

          const tradeMeta: Record<string, string> = {
            "trade:symbol": trade.symbol,
            "trade:side": trade.isBuyer ? "buy" : "sell",
            "trade:price": trade.price,
            "trade:quantity": trade.qty,
            "trade:quote_amount": trade.quoteQty,
            "trade:commission": trade.commission,
            "trade:commission_asset": trade.commissionAsset,
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

          // If commission asset is neither base nor quote, add a 3rd record
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

        // Pagination: if we got a full page, continue from the last id + 1
        if (trades.length < 1000) {
          hasMore = false;
        } else {
          fromId = trades[trades.length - 1].id + 1;
        }

        await abortableDelay(100, signal);
      }

      await abortableDelay(100, signal);
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
    const MS_90_DAYS = 90 * 24 * 60 * 60 * 1000;
    let windowStart = since ? since * 1000 : now - MS_90_DAYS;

    while (windowStart < now) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const windowEnd = Math.min(windowStart + MS_90_DAYS, now);
      let offset = 0;

      for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const params = new URLSearchParams({
          startTime: String(windowStart),
          endTime: String(windowEnd),
          limit: "1000",
          offset: String(offset),
        });

        const result = await this.signedGet("/sapi/v1/capital/deposit/hisrec", params, apiKey, apiSecret, signal);
        const deposits = JSON.parse(result.body) as BinanceDeposit[];

        if (!Array.isArray(deposits) || deposits.length === 0) break;

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
              "deposit:status": String(dep.status),
            },
          });
        }

        if (deposits.length < 1000) break;
        offset += deposits.length;

        await abortableDelay(100, signal);
      }

      windowStart = windowEnd;
      await abortableDelay(100, signal);
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
    const MS_90_DAYS = 90 * 24 * 60 * 60 * 1000;
    let windowStart = since ? since * 1000 : now - MS_90_DAYS;

    while (windowStart < now) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const windowEnd = Math.min(windowStart + MS_90_DAYS, now);
      let offset = 0;

      for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const params = new URLSearchParams({
          startTime: String(windowStart),
          endTime: String(windowEnd),
          limit: "1000",
          offset: String(offset),
        });

        const result = await this.signedGet("/sapi/v1/capital/withdraw/history", params, apiKey, apiSecret, signal);
        const withdrawals = JSON.parse(result.body) as BinanceWithdrawal[];

        if (!Array.isArray(withdrawals) || withdrawals.length === 0) break;

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
              "withdrawal:status": String(wd.status),
            },
          });
        }

        if (withdrawals.length < 1000) break;
        offset += withdrawals.length;

        await abortableDelay(100, signal);
      }

      windowStart = windowEnd;
      await abortableDelay(100, signal);
    }

    return records;
  }
}

// Re-export for tests
export { binanceSign, BINANCE_ASSET_MAP };
