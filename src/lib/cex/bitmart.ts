import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";
import { hmacSha256Hex } from "./crypto-utils.js";

const BITMART_API = "https://api-cloud.bitmart.com";

async function bitmartFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, BITMART_API, "/api/bitmart", init, signal);
}

/**
 * Sign a BitMart API request.
 * Signature = hex(HMAC-SHA256(secret, timestamp + "#" + memo + "#" + queryString))
 */
async function bitmartSign(
  secret: string,
  timestamp: string,
  memo: string,
  queryString: string,
): Promise<string> {
  const prehash = `${timestamp}#${memo}#${queryString}`;
  return hmacSha256Hex(secret, prehash);
}

interface BitmartResponse<T> {
  code: number;
  message: string;
  data: T;
}

interface BitmartTrade {
  order_id: string;
  symbol: string;
  side: string;
  price: string;
  size: string;
  notional: string;
  fee: string;
  fee_coin_name: string;
  create_time: number;
  detail_id: string;
}

interface BitmartTradesData {
  trades: BitmartTrade[];
  current_page: number;
  total: number;
}

interface BitmartDeposit {
  deposit_id: string;
  currency: string;
  amount: string;
  tx_id: string;
  arrival_amount: string;
  status: number;
  created_at: number;
}

interface BitmartDepositData {
  records: BitmartDeposit[];
  current_page: number;
  total: number;
}

interface BitmartWithdrawal {
  withdraw_id: string;
  currency: string;
  amount: string;
  tx_id: string;
  fee: string;
  status: number;
  created_at: number;
}

interface BitmartWithdrawalData {
  records: BitmartWithdrawal[];
  current_page: number;
  total: number;
}

function parseSymbol(symbol: string): { base: string; quote: string } | null {
  // BitMart uses underscore-separated symbols like "BTC_USDT"
  const parts = symbol.split("_");
  if (parts.length === 2 && parts[0].length > 0 && parts[1].length > 0) {
    return { base: parts[0], quote: parts[1] };
  }
  return null;
}

export class BitmartAdapter implements CexAdapter {
  readonly exchangeId = "bitmart" as const;
  readonly exchangeName = "BitMart";
  readonly requiresPassphrase = true;

  normalizeAsset(raw: string): string {
    return raw;
  }

  async fetchLedgerRecords(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
    passphrase?: string,
  ): Promise<CexLedgerRecord[]> {
    const memo = passphrase ?? "";
    const records: CexLedgerRecord[] = [];

    // 1. Fetch trades
    const tradeRecords = await this.fetchTrades(apiKey, apiSecret, memo, since, signal);
    records.push(...tradeRecords);

    // 2. Fetch deposits
    const depositRecords = await this.fetchDeposits(apiKey, apiSecret, memo, signal);
    records.push(...depositRecords);

    // 3. Fetch withdrawals
    const withdrawalRecords = await this.fetchWithdrawals(apiKey, apiSecret, memo, signal);
    records.push(...withdrawalRecords);

    return records;
  }

  private async signedGet(
    path: string,
    params: URLSearchParams,
    apiKey: string,
    apiSecret: string,
    memo: string,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: string }> {
    const timestamp = String(Date.now());
    const queryString = params.toString();
    const signature = await bitmartSign(apiSecret, timestamp, memo, queryString);
    const url = queryString
      ? `${BITMART_API}${path}?${queryString}`
      : `${BITMART_API}${path}`;

    return bitmartFetch(
      url,
      {
        method: "GET",
        headers: {
          "X-BM-KEY": apiKey,
          "X-BM-TIMESTAMP": timestamp,
          "X-BM-SIGN": signature,
        },
      },
      signal,
    );
  }

  /**
   * Fetch trades. BitMart requires a symbol parameter.
   * WARNING: Only 3 months of history available.
   */
  private async fetchTrades(
    apiKey: string,
    apiSecret: string,
    memo: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];

    // Common trading pairs to query
    const symbols = [
      "BTC_USDT", "ETH_USDT", "SOL_USDT", "XRP_USDT", "ADA_USDT",
      "DOGE_USDT", "AVAX_USDT", "DOT_USDT", "LINK_USDT", "MATIC_USDT",
      "UNI_USDT", "ATOM_USDT", "LTC_USDT", "NEAR_USDT", "APT_USDT",
      "ARB_USDT", "OP_USDT", "SUI_USDT", "BTC_USDC", "ETH_USDC",
      "ETH_BTC", "SOL_BTC",
    ];

    for (const symbol of symbols) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const parsed = parseSymbol(symbol);
      if (!parsed) continue;

      let page = 1;
      let hasMore = true;

      while (hasMore) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const params = new URLSearchParams({
          symbol,
          limit: "100",
          offset: String(page),
        });
        if (since) {
          params.set("startTime", String(since * 1000));
        }

        const result = await this.signedGet(
          "/spot/v4/query/trades",
          params,
          apiKey,
          apiSecret,
          memo,
          signal,
        );

        const json = JSON.parse(result.body) as BitmartResponse<BitmartTradesData>;
        if (json.code !== 1000) {
          // Symbol may not exist — skip silently
          break;
        }

        const trades = json.data?.trades;
        if (!Array.isArray(trades) || trades.length === 0) {
          hasMore = false;
          break;
        }

        for (const trade of trades) {
          const refid = `${trade.symbol}:${trade.detail_id}`;
          const { base, quote } = parsed;
          const isBuy = trade.side === "buy";

          const tradeMeta: Record<string, string> = {
            "trade:symbol": trade.symbol,
            "trade:side": trade.side,
            "trade:price": trade.price,
            "trade:quantity": trade.size,
            "trade:quote_amount": trade.notional,
            "trade:commission": trade.fee,
            "trade:commission_asset": trade.fee_coin_name,
            "trade:order_id": trade.order_id,
          };

          // Base asset record
          records.push({
            refid,
            type: "trade",
            asset: this.normalizeAsset(base),
            amount: isBuy ? trade.size : `-${trade.size}`,
            fee: trade.fee_coin_name === base ? trade.fee : "0",
            timestamp: trade.create_time / 1000,
            txid: null,
            metadata: tradeMeta,
          });

          // Quote asset record
          records.push({
            refid,
            type: "trade",
            asset: this.normalizeAsset(quote),
            amount: isBuy ? `-${trade.notional}` : trade.notional,
            fee: trade.fee_coin_name === quote ? trade.fee : "0",
            timestamp: trade.create_time / 1000,
            txid: null,
            metadata: tradeMeta,
          });

          // Commission in a third asset
          if (trade.fee_coin_name !== base && trade.fee_coin_name !== quote) {
            records.push({
              refid,
              type: "trade",
              asset: this.normalizeAsset(trade.fee_coin_name),
              amount: "0",
              fee: trade.fee,
              timestamp: trade.create_time / 1000,
              txid: null,
              metadata: tradeMeta,
            });
          }
        }

        if (trades.length < 100) {
          hasMore = false;
        } else {
          page++;
        }

        await abortableDelay(150, signal);
      }

      await abortableDelay(150, signal);
    }

    return records;
  }

  /**
   * Fetch deposit history. Paginated by page number.
   */
  private async fetchDeposits(
    apiKey: string,
    apiSecret: string,
    memo: string,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let page = 1;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({
        offset: String(page),
        limit: "100",
      });

      const result = await this.signedGet(
        "/account/v1/deposit-withdraw-history/deposit",
        params,
        apiKey,
        apiSecret,
        memo,
        signal,
      );

      const json = JSON.parse(result.body) as BitmartResponse<BitmartDepositData>;
      if (json.code !== 1000) {
        throw new Error(`BitMart API error: ${json.message ?? json.code}`);
      }

      const deposits = json.data?.records;
      if (!Array.isArray(deposits) || deposits.length === 0) break;

      for (const dep of deposits) {
        records.push({
          refid: `deposit:${dep.deposit_id}`,
          type: "deposit",
          asset: this.normalizeAsset(dep.currency),
          amount: dep.arrival_amount,
          fee: "0",
          timestamp: dep.created_at / 1000,
          txid: dep.tx_id ? normalizeTxid(dep.tx_id) : null,
          metadata: {
            "deposit:status": String(dep.status),
          },
        });
      }

      if (deposits.length < 100) break;
      page++;

      await abortableDelay(150, signal);
    }

    return records;
  }

  /**
   * Fetch withdrawal history. Paginated by page number.
   */
  private async fetchWithdrawals(
    apiKey: string,
    apiSecret: string,
    memo: string,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let page = 1;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({
        offset: String(page),
        limit: "100",
      });

      const result = await this.signedGet(
        "/account/v1/deposit-withdraw-history/withdraw",
        params,
        apiKey,
        apiSecret,
        memo,
        signal,
      );

      const json = JSON.parse(result.body) as BitmartResponse<BitmartWithdrawalData>;
      if (json.code !== 1000) {
        throw new Error(`BitMart API error: ${json.message ?? json.code}`);
      }

      const withdrawals = json.data?.records;
      if (!Array.isArray(withdrawals) || withdrawals.length === 0) break;

      for (const wd of withdrawals) {
        records.push({
          refid: `withdraw:${wd.withdraw_id}`,
          type: "withdrawal",
          asset: this.normalizeAsset(wd.currency),
          amount: `-${wd.amount}`,
          fee: wd.fee,
          timestamp: wd.created_at / 1000,
          txid: wd.tx_id ? normalizeTxid(wd.tx_id) : null,
          metadata: {
            "withdrawal:fee": wd.fee,
            "withdrawal:status": String(wd.status),
          },
        });
      }

      if (withdrawals.length < 100) break;
      page++;

      await abortableDelay(150, signal);
    }

    return records;
  }
}

// Re-export for tests
export { bitmartSign };
