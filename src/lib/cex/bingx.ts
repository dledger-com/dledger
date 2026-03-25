import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";
import { hmacSha256Hex } from "./crypto-utils.js";

const BINGX_API = "https://open-api.bingx.com";

async function bingxFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, BINGX_API, "/api/bingx", init, signal);
}

/**
 * Sign a BingX API request.
 * Signature = hex(HMAC-SHA256(secret, sorted-query-params-string))
 */
async function bingxSign(params: URLSearchParams, secret: string): Promise<string> {
  // Sort params alphabetically by key
  const sorted = new URLSearchParams([...params.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  return hmacSha256Hex(secret, sorted.toString());
}

interface BingxResponse<T> {
  code: number;
  msg?: string;
  data: T;
}

interface BingxTrade {
  orderId: string;
  symbol: string;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
}

interface BingxTradesData {
  orders: BingxTrade[];
}

interface BingxDeposit {
  id: string;
  coin: string;
  amount: string;
  network: string;
  txId: string;
  status: number;
  insertTime: number;
}

interface BingxWithdrawal {
  id: string;
  coin: string;
  amount: string;
  network: string;
  txId: string;
  transactionFee: string;
  applyTime: number;
  status: number;
}

const QUOTE_CURRENCIES = ["USDT", "USDC", "BTC", "ETH", "BNB", "EUR"];

function parseSymbol(symbol: string): { base: string; quote: string } | null {
  // BingX uses dash-separated symbols like "BTC-USDT"
  const parts = symbol.split("-");
  if (parts.length === 2 && parts[0].length > 0 && parts[1].length > 0) {
    return { base: parts[0], quote: parts[1] };
  }
  return null;
}

export class BingxAdapter implements CexAdapter {
  readonly exchangeId = "bingx" as const;
  readonly exchangeName = "BingX";

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
    const signature = await bingxSign(params, apiSecret);
    params.set("signature", signature);
    const url = `${BINGX_API}${path}?${params.toString()}`;

    return bingxFetch(
      url,
      {
        method: "GET",
        headers: { "X-BX-APIKEY": apiKey },
      },
      signal,
    );
  }

  /**
   * Fetch trades for common quote currencies.
   * BingX requires a symbol param, so we iterate over common pairs.
   * Paginate by orderId.
   */
  private async fetchTrades(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];

    // We need to query per-symbol; fetch common pairs
    // BingX uses "BTC-USDT" format
    const symbols = await this.fetchTradedSymbols(apiKey, apiSecret, signal);

    for (const symbol of symbols) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const parsed = parseSymbol(symbol);
      if (!parsed) continue;

      let lastOrderId: string | undefined;
      let hasMore = true;

      while (hasMore) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const params = new URLSearchParams({
          symbol,
          limit: "500",
        });
        if (lastOrderId) {
          params.set("orderId", lastOrderId);
        }
        if (since) {
          params.set("startTime", String(since * 1000));
        }

        const result = await this.signedGet("/openApi/spot/v1/trade/query", params, apiKey, apiSecret, signal);
        const json = JSON.parse(result.body) as BingxResponse<BingxTradesData>;

        if (json.code !== 0) {
          // Symbol may not exist — skip silently
          break;
        }

        const trades = json.data?.orders;
        if (!Array.isArray(trades) || trades.length === 0) {
          hasMore = false;
          break;
        }

        for (const trade of trades) {
          const refid = `${trade.symbol}:${trade.orderId}`;
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

          // Commission in a third asset
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

        if (trades.length < 500) {
          hasMore = false;
        } else {
          lastOrderId = trades[trades.length - 1].orderId;
        }

        await abortableDelay(150, signal);
      }

      await abortableDelay(150, signal);
    }

    return records;
  }

  /**
   * Derive candidate symbols from common quote currencies.
   * Returns dash-separated symbols like "BTC-USDT".
   */
  private async fetchTradedSymbols(
    _apiKey: string,
    _apiSecret: string,
    _signal?: AbortSignal,
  ): Promise<string[]> {
    // BingX doesn't provide a user-assets endpoint easily,
    // so we use common base/quote combinations
    const bases = [
      "BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "AVAX", "DOT", "LINK",
      "MATIC", "UNI", "ATOM", "LTC", "NEAR", "APT", "ARB", "OP", "SUI",
    ];
    const symbols: string[] = [];
    for (const base of bases) {
      for (const quote of QUOTE_CURRENCIES) {
        if (base !== quote) {
          symbols.push(`${base}-${quote}`);
        }
      }
    }
    return symbols;
  }

  /**
   * Fetch deposit history using time-windowed pagination.
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

        const result = await this.signedGet(
          "/openApi/wallets/v1/capital/deposit/hisrec",
          params,
          apiKey,
          apiSecret,
          signal,
        );

        const json = JSON.parse(result.body) as BingxResponse<BingxDeposit[]>;
        if (json.code !== 0) {
          throw new Error(`BingX API error: ${json.msg ?? json.code}`);
        }

        const deposits = json.data;
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

        await abortableDelay(150, signal);
      }

      windowStart = windowEnd;
      await abortableDelay(150, signal);
    }

    return records;
  }

  /**
   * Fetch withdrawal history using time-windowed pagination.
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

        const result = await this.signedGet(
          "/openApi/wallets/v1/capital/withdraw/history",
          params,
          apiKey,
          apiSecret,
          signal,
        );

        const json = JSON.parse(result.body) as BingxResponse<BingxWithdrawal[]>;
        if (json.code !== 0) {
          throw new Error(`BingX API error: ${json.msg ?? json.code}`);
        }

        const withdrawals = json.data;
        if (!Array.isArray(withdrawals) || withdrawals.length === 0) break;

        for (const wd of withdrawals) {
          records.push({
            refid: `withdraw:${wd.id}`,
            type: "withdrawal",
            asset: this.normalizeAsset(wd.coin),
            amount: `-${wd.amount}`,
            fee: wd.transactionFee,
            timestamp: wd.applyTime / 1000,
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

        await abortableDelay(150, signal);
      }

      windowStart = windowEnd;
      await abortableDelay(150, signal);
    }

    return records;
  }
}

// Re-export for tests
export { bingxSign };
