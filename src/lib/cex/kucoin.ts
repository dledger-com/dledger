import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";
import { hmacSha256Base64 } from "./crypto-utils.js";

const KUCOIN_API = "https://api.kucoin.com";
const RATE_LIMIT_MS = 200;

// 7 days in milliseconds (max window for fills endpoint)
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
// Default lookback: 1 year
const DEFAULT_LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000;

async function kucoinFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, KUCOIN_API, "/api/kucoin", init, signal);
}

/**
 * Sign a KuCoin API request.
 * Prehash = timestamp + METHOD + endpoint + body
 * Signature = Base64(HMAC-SHA256(secret, prehash))
 */
async function kucoinSign(
  timestamp: string,
  method: string,
  endpoint: string,
  body: string,
  secret: string,
): Promise<string> {
  const prehash = timestamp + method + endpoint + body;
  return hmacSha256Base64(secret, prehash);
}

/**
 * Encrypt the passphrase for KuCoin API v2.
 * KC-API-PASSPHRASE = Base64(HMAC-SHA256(secret, passphrase))
 */
async function encryptPassphrase(
  secret: string,
  passphrase: string,
): Promise<string> {
  return hmacSha256Base64(secret, passphrase);
}

// --- API response types ---

interface KucoinResponse<T> {
  code: string;
  data: T;
}

interface KucoinPageData<T> {
  currentPage: number;
  pageSize: number;
  totalNum: number;
  totalPage: number;
  items: T[];
}

interface KucoinFill {
  tradeId: string;
  symbol: string;
  side: string;
  price: string;
  size: string;
  funds: string;
  fee: string;
  feeCurrency: string;
  createdAt: number;
  orderId: string;
}

interface KucoinDeposit {
  id: string;
  currency: string;
  amount: string;
  walletTxId: string;
  createdAt: number;
  status: string;
  chain: string;
  fee: string;
}

interface KucoinWithdrawal {
  id: string;
  currency: string;
  amount: string;
  walletTxId: string;
  fee: string;
  createdAt: number;
  status: string;
  chain: string;
}

export class KucoinAdapter implements CexAdapter {
  readonly exchangeId = "kucoin" as const;
  readonly exchangeName = "KuCoin";
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
    const records: CexLedgerRecord[] = [];

    const tradeRecords = await this.fetchTrades(apiKey, apiSecret, since, signal, passphrase);
    records.push(...tradeRecords);

    const depositRecords = await this.fetchDeposits(apiKey, apiSecret, since, signal, passphrase);
    records.push(...depositRecords);

    const withdrawalRecords = await this.fetchWithdrawals(apiKey, apiSecret, since, signal, passphrase);
    records.push(...withdrawalRecords);

    return records;
  }

  private async signedGet(
    endpoint: string,
    apiKey: string,
    apiSecret: string,
    signal?: AbortSignal,
    passphrase?: string,
  ): Promise<{ status: number; body: string }> {
    const timestamp = String(Date.now());
    const signature = await kucoinSign(timestamp, "GET", endpoint, "", apiSecret);
    const encPassphrase = await encryptPassphrase(apiSecret, passphrase ?? "");

    return kucoinFetch(
      `${KUCOIN_API}${endpoint}`,
      {
        method: "GET",
        headers: {
          "KC-API-KEY": apiKey,
          "KC-API-SIGN": signature,
          "KC-API-TIMESTAMP": timestamp,
          "KC-API-PASSPHRASE": encPassphrase,
          "KC-API-KEY-VERSION": "2",
          "Content-Type": "application/json",
        },
      },
      signal,
    );
  }

  /**
   * Fetch trade fills using 7-day rolling windows backward from now to `since`.
   * KuCoin fills endpoint only allows a 7-day window per request.
   */
  private async fetchTrades(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
    passphrase?: string,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    const now = Date.now();
    const startMs = since ? since * 1000 : now - DEFAULT_LOOKBACK_MS;

    // Iterate in 7-day windows from startMs to now
    let windowStart = startMs;

    while (windowStart < now) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const windowEnd = Math.min(windowStart + SEVEN_DAYS_MS, now);
      let currentPage = 1;

      for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const params = new URLSearchParams({
          startAt: String(windowStart),
          endAt: String(windowEnd),
          currentPage: String(currentPage),
          pageSize: "50",
          tradeType: "TRADE",
        });

        const endpoint = `/api/v1/fills?${params.toString()}`;
        const result = await this.signedGet(endpoint, apiKey, apiSecret, signal, passphrase);

        const json = JSON.parse(result.body) as KucoinResponse<KucoinPageData<KucoinFill>>;
        if (json.code !== "200000") {
          throw new Error(`KuCoin API error: ${json.code}`);
        }

        const page = json.data;
        if (!page.items || page.items.length === 0) break;

        for (const fill of page.items) {
          const parts = fill.symbol.split("-");
          const base = parts[0];
          const quote = parts[1];
          const refid = `${fill.symbol}:${fill.tradeId}`;
          const isBuy = fill.side === "buy";
          const absFee = String(Math.abs(parseFloat(fill.fee)));

          const tradeMeta: Record<string, string> = {
            "trade:symbol": fill.symbol,
            "trade:side": fill.side,
            "trade:price": fill.price,
            "trade:quantity": fill.size,
            "trade:quote_amount": fill.funds,
            "trade:commission": absFee,
            "trade:commission_asset": fill.feeCurrency,
            "trade:order_id": fill.orderId,
          };

          // Base asset record
          records.push({
            refid,
            type: "trade",
            asset: this.normalizeAsset(base),
            amount: isBuy ? fill.size : `-${fill.size}`,
            fee: fill.feeCurrency === base ? absFee : "0",
            timestamp: fill.createdAt / 1000,
            txid: null,
            metadata: tradeMeta,
          });

          // Quote asset record
          records.push({
            refid,
            type: "trade",
            asset: this.normalizeAsset(quote),
            amount: isBuy ? `-${fill.funds}` : fill.funds,
            fee: fill.feeCurrency === quote ? absFee : "0",
            timestamp: fill.createdAt / 1000,
            txid: null,
            metadata: tradeMeta,
          });

          // If commission asset is neither base nor quote
          if (fill.feeCurrency !== base && fill.feeCurrency !== quote) {
            records.push({
              refid,
              type: "trade",
              asset: this.normalizeAsset(fill.feeCurrency),
              amount: "0",
              fee: absFee,
              timestamp: fill.createdAt / 1000,
              txid: null,
              metadata: tradeMeta,
            });
          }
        }

        if (currentPage >= page.totalPage) break;
        currentPage++;

        await abortableDelay(RATE_LIMIT_MS, signal);
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
    passphrase?: string,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let currentPage = 1;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({
        currentPage: String(currentPage),
        pageSize: "50",
      });
      if (since) {
        params.set("startAt", String(since * 1000));
      }

      const endpoint = `/api/v1/deposits?${params.toString()}`;
      const result = await this.signedGet(endpoint, apiKey, apiSecret, signal, passphrase);

      const json = JSON.parse(result.body) as KucoinResponse<KucoinPageData<KucoinDeposit>>;
      if (json.code !== "200000") {
        throw new Error(`KuCoin API error: ${json.code}`);
      }

      const page = json.data;
      if (!page.items || page.items.length === 0) break;

      for (const dep of page.items) {
        // Only include successful deposits
        if (dep.status !== "SUCCESS") continue;

        records.push({
          refid: `deposit:${dep.id}`,
          type: "deposit",
          asset: this.normalizeAsset(dep.currency),
          amount: dep.amount,
          fee: dep.fee || "0",
          timestamp: dep.createdAt / 1000,
          txid: dep.walletTxId ? normalizeTxid(dep.walletTxId) : null,
          metadata: {
            "deposit:chain": dep.chain,
            "deposit:status": dep.status,
          },
        });
      }

      if (currentPage >= page.totalPage) break;
      currentPage++;

      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }

  private async fetchWithdrawals(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
    passphrase?: string,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let currentPage = 1;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({
        currentPage: String(currentPage),
        pageSize: "50",
      });
      if (since) {
        params.set("startAt", String(since * 1000));
      }

      const endpoint = `/api/v1/withdrawals?${params.toString()}`;
      const result = await this.signedGet(endpoint, apiKey, apiSecret, signal, passphrase);

      const json = JSON.parse(result.body) as KucoinResponse<KucoinPageData<KucoinWithdrawal>>;
      if (json.code !== "200000") {
        throw new Error(`KuCoin API error: ${json.code}`);
      }

      const page = json.data;
      if (!page.items || page.items.length === 0) break;

      for (const wd of page.items) {
        // Only include completed withdrawals
        if (wd.status !== "SUCCESS") continue;

        records.push({
          refid: `withdraw:${wd.id}`,
          type: "withdrawal",
          asset: this.normalizeAsset(wd.currency),
          amount: `-${wd.amount}`,
          fee: wd.fee,
          timestamp: wd.createdAt / 1000,
          txid: wd.walletTxId ? normalizeTxid(wd.walletTxId) : null,
          metadata: {
            "withdrawal:chain": wd.chain,
            "withdrawal:fee": wd.fee,
            "withdrawal:status": wd.status,
          },
        });
      }

      if (currentPage >= page.totalPage) break;
      currentPage++;

      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }
}

// Re-export for tests
export { kucoinSign, encryptPassphrase };
