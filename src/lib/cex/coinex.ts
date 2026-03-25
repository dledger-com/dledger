import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";
import { hmacSha256Hex } from "./crypto-utils.js";

const COINEX_API = "https://api.coinex.com";
const PROXY_PREFIX = "/api/coinex";
const RATE_LIMIT_MS = 150;

interface CoinexResponse<T> {
  code: number;
  message: string;
  data: T;
}

interface CoinexTrade {
  deal_id: number;
  market: string;
  side: string;          // "buy" | "sell"
  price: string;
  amount: string;        // base quantity
  deal_money: string;    // quote quantity
  fee: string;
  fee_asset: string;
  created_at: number;    // ms
}

interface CoinexTradeData {
  data: CoinexTrade[];
  has_next: boolean;
}

interface CoinexDeposit {
  deposit_id: number;
  coin_type: string;
  actual_amount: string;
  tx_id: string;
  created_at: number;    // ms
  status: string;
}

interface CoinexDepositData {
  data: CoinexDeposit[];
  has_next: boolean;
  total: number;
}

interface CoinexWithdrawal {
  withdraw_id: number;
  coin_type: string;
  actual_amount: string;
  tx_fee: string;
  tx_id: string;
  created_at: number;    // ms
  status: string;
}

interface CoinexWithdrawalData {
  data: CoinexWithdrawal[];
  has_next: boolean;
  total: number;
}

async function coinexFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, COINEX_API, PROXY_PREFIX, init, signal);
}

/**
 * Sign a CoinEx V2 API request.
 * signature = lowercase_hex(HMAC_SHA256(secret, method + path + body + timestamp))
 * For GET requests, body is empty string.
 */
async function coinexSign(
  method: string,
  path: string,
  body: string,
  timestamp: string,
  secret: string,
): Promise<string> {
  const signString = method + path + body + timestamp;
  return hmacSha256Hex(secret, signString);
}

function parseMarket(market: string): { base: string; quote: string } | null {
  // CoinEx markets are like "BTCUSDT", "ETHBTC"
  const quotes = ["USDT", "USDC", "BTC", "ETH", "EUR"];
  for (const q of quotes) {
    if (market.endsWith(q)) {
      const base = market.slice(0, -q.length);
      if (base.length > 0) return { base, quote: q };
    }
  }
  return null;
}

export class CoinexAdapter implements CexAdapter {
  readonly exchangeId = "coinex" as const;
  readonly exchangeName = "CoinEx";

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
    const fullPath = queryString ? `${path}?${queryString}` : path;

    const signature = await coinexSign("GET", fullPath, "", timestamp, apiSecret);
    const url = `${COINEX_API}${fullPath}`;

    return coinexFetch(url, {
      method: "GET",
      headers: {
        "X-COINEX-KEY": apiKey,
        "X-COINEX-SIGN": signature,
        "X-COINEX-TIMESTAMP": timestamp,
        "Content-Type": "application/json",
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
    let page = 1;
    const limit = 100;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      if (since) {
        params.set("start_time", String(Math.floor(since * 1000)));
      }

      const result = await this.signedGet("/v2/spot/user-deals", params, apiKey, apiSecret, signal);
      const json = JSON.parse(result.body) as CoinexResponse<CoinexTradeData>;

      if (json.code !== 0) throw new Error(`CoinEx API error: ${json.message}`);

      const items = json.data?.data;
      if (!items || items.length === 0) break;

      for (const trade of items) {
        const parsed = parseMarket(trade.market);
        if (!parsed) continue;

        const { base, quote } = parsed;
        const refid = `${trade.market}:${trade.deal_id}`;
        const isBuy = trade.side === "buy";
        const ts = trade.created_at / 1000;

        const tradeMeta: Record<string, string> = {
          "trade:symbol": trade.market,
          "trade:side": trade.side,
          "trade:price": trade.price,
        };

        // Base asset record
        records.push({
          refid,
          type: "trade",
          asset: this.normalizeAsset(base),
          amount: isBuy ? trade.amount : `-${trade.amount}`,
          fee: trade.fee_asset?.toUpperCase() === base ? trade.fee : "0",
          timestamp: ts,
          txid: null,
          metadata: tradeMeta,
        });

        // Quote asset record
        records.push({
          refid,
          type: "trade",
          asset: this.normalizeAsset(quote),
          amount: isBuy ? `-${trade.deal_money}` : trade.deal_money,
          fee: trade.fee_asset?.toUpperCase() === quote ? trade.fee : "0",
          timestamp: ts,
          txid: null,
          metadata: tradeMeta,
        });

        // Fee in third currency
        if (trade.fee_asset && trade.fee_asset.toUpperCase() !== base && trade.fee_asset.toUpperCase() !== quote) {
          records.push({
            refid,
            type: "trade",
            asset: this.normalizeAsset(trade.fee_asset),
            amount: "0",
            fee: trade.fee,
            timestamp: ts,
            txid: null,
            metadata: tradeMeta,
          });
        }
      }

      if (!json.data.has_next) break;
      page++;
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
    let page = 1;
    const limit = 100;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      if (since) {
        params.set("start_time", String(Math.floor(since * 1000)));
      }

      const result = await this.signedGet("/v2/assets/deposit-history", params, apiKey, apiSecret, signal);
      const json = JSON.parse(result.body) as CoinexResponse<CoinexDepositData>;

      if (json.code !== 0) throw new Error(`CoinEx API error: ${json.message}`);

      const items = json.data?.data;
      if (!items || items.length === 0) break;

      for (const dep of items) {
        records.push({
          refid: `deposit:${dep.deposit_id}`,
          type: "deposit",
          asset: this.normalizeAsset(dep.coin_type),
          amount: dep.actual_amount,
          fee: "0",
          timestamp: dep.created_at / 1000,
          txid: dep.tx_id ? normalizeTxid(dep.tx_id) : null,
          metadata: {
            "deposit:status": dep.status,
          },
        });
      }

      if (!json.data.has_next) break;
      page++;
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
    let page = 1;
    const limit = 100;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      if (since) {
        params.set("start_time", String(Math.floor(since * 1000)));
      }

      const result = await this.signedGet("/v2/assets/withdraw-history", params, apiKey, apiSecret, signal);
      const json = JSON.parse(result.body) as CoinexResponse<CoinexWithdrawalData>;

      if (json.code !== 0) throw new Error(`CoinEx API error: ${json.message}`);

      const items = json.data?.data;
      if (!items || items.length === 0) break;

      for (const wd of items) {
        records.push({
          refid: `withdraw:${wd.withdraw_id}`,
          type: "withdrawal",
          asset: this.normalizeAsset(wd.coin_type),
          amount: `-${wd.actual_amount}`,
          fee: wd.tx_fee || "0",
          timestamp: wd.created_at / 1000,
          txid: wd.tx_id ? normalizeTxid(wd.tx_id) : null,
          metadata: {
            "withdrawal:status": wd.status,
          },
        });
      }

      if (!json.data.has_next) break;
      page++;
      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }
}
