import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";
import { hmacSha512Hex } from "./crypto-utils.js";

const BITHUMB_API = "https://api.bithumb.com";

async function bithumbFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, BITHUMB_API, "/api/bithumb", init, signal);
}

/**
 * Sign a Bithumb API request.
 * Signature = hex(HMAC-SHA512(secret, path + "\0" + encodedParams + "\0" + nonce))
 * where "\0" is the null character.
 */
async function bithumbSign(
  secret: string,
  path: string,
  encodedParams: string,
  nonce: string,
): Promise<string> {
  const prehash = path + String.fromCharCode(0) + encodedParams + String.fromCharCode(0) + nonce;
  return hmacSha512Hex(secret, prehash);
}

interface BithumbResponse<T> {
  status: string;
  message?: string;
  data: T;
}

interface BithumbOrder {
  order_id: string;
  order_currency: string;
  payment_currency: string;
  type: string; // "bid" (buy) or "ask" (sell)
  units: string;
  price: string;
  fee: string;
  total: string;
  date_completed: string; // timestamp in microseconds
}

interface BithumbTransaction {
  search: string; // "0"=all, "1"=buy, "2"=sell, "3"=deposit, "4"=withdraw, "5"=interest
  transfer_date: number; // timestamp in microseconds
  units: string;
  price: string;
  fee: string;
  order_balance: string;
  payment_balance: string;
  [key: string]: unknown;
}

function mapBithumbSearchType(search: string): CexLedgerRecord["type"] {
  switch (search) {
    case "1":
    case "2":
      return "trade";
    case "3":
      return "deposit";
    case "4":
      return "withdrawal";
    case "5":
      return "staking";
    default:
      return "other";
  }
}

export class BithumbAdapter implements CexAdapter {
  readonly exchangeId = "bithumb" as const;
  readonly exchangeName = "Bithumb";

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

    // 1. Fetch user transactions (includes trades, deposits, withdrawals)
    const txRecords = await this.fetchUserTransactions(apiKey, apiSecret, since, signal);
    records.push(...txRecords);

    return records;
  }

  private async signedPost(
    path: string,
    params: URLSearchParams,
    apiKey: string,
    apiSecret: string,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: string }> {
    const nonce = String(Date.now());
    const encodedParams = params.toString();
    const signature = await bithumbSign(apiSecret, path, encodedParams, nonce);

    return bithumbFetch(
      `${BITHUMB_API}${path}`,
      {
        method: "POST",
        headers: {
          "Api-Key": apiKey,
          "Api-Sign": signature,
          "Api-Nonce": nonce,
          "Api-Timestamp": nonce,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: encodedParams,
      },
      signal,
    );
  }

  /**
   * Fetch user transactions. Includes all types: trades, deposits, withdrawals.
   * POST /info/user_transactions with searchGb=0 (all types).
   * Paginated by offset + count.
   */
  private async fetchUserTransactions(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];

    // Query for major currencies
    const currencies = [
      "BTC", "ETH", "XRP", "SOL", "ADA", "DOGE", "DOT", "AVAX", "LINK",
      "MATIC", "ATOM", "LTC", "NEAR", "UNI", "APT", "ARB", "OP", "SUI",
      "EOS", "TRX", "XLM",
    ];

    for (const currency of currencies) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      let offset = 0;
      const count = 50;
      let hasMore = true;

      while (hasMore) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const params = new URLSearchParams({
          order_currency: currency,
          payment_currency: "KRW",
          searchGb: "0", // all types
          offset: String(offset),
          count: String(count),
        });

        const result = await this.signedPost(
          "/info/user_transactions",
          params,
          apiKey,
          apiSecret,
          signal,
        );

        const json = JSON.parse(result.body) as BithumbResponse<BithumbTransaction[]>;

        if (json.status !== "0000") {
          // Currency may not be supported — skip silently
          break;
        }

        const transactions = json.data;
        if (!Array.isArray(transactions) || transactions.length === 0) {
          hasMore = false;
          break;
        }

        for (const tx of transactions) {
          const type = mapBithumbSearchType(tx.search);
          // transfer_date is in microseconds
          const timestamp = tx.transfer_date / 1000000;

          // Skip entries before since
          if (since && timestamp < since) continue;

          const units = tx.units;
          const absUnits = Math.abs(parseFloat(units));
          if (absUnits === 0) continue;

          if (type === "trade") {
            const isBuy = tx.search === "1";
            const refid = `trade:${currency}:${tx.transfer_date}`;
            const quoteAmount = tx.price;

            const tradeMeta: Record<string, string> = {
              "trade:currency": currency,
              "trade:side": isBuy ? "buy" : "sell",
              "trade:quantity": units,
              "trade:price": tx.price,
            };

            // Base asset record
            records.push({
              refid,
              type: "trade",
              asset: this.normalizeAsset(currency),
              amount: isBuy ? String(absUnits) : `-${absUnits}`,
              fee: tx.fee,
              timestamp,
              txid: null,
              metadata: tradeMeta,
            });

            // Quote asset record (KRW)
            records.push({
              refid,
              type: "trade",
              asset: "KRW",
              amount: isBuy ? `-${Math.abs(parseFloat(quoteAmount))}` : String(Math.abs(parseFloat(quoteAmount))),
              fee: "0",
              timestamp,
              txid: null,
              metadata: tradeMeta,
            });
          } else if (type === "deposit") {
            records.push({
              refid: `deposit:${currency}:${tx.transfer_date}`,
              type: "deposit",
              asset: this.normalizeAsset(currency),
              amount: String(absUnits),
              fee: tx.fee,
              timestamp,
              txid: null,
            });
          } else if (type === "withdrawal") {
            records.push({
              refid: `withdraw:${currency}:${tx.transfer_date}`,
              type: "withdrawal",
              asset: this.normalizeAsset(currency),
              amount: `-${absUnits}`,
              fee: tx.fee,
              timestamp,
              txid: null,
            });
          } else if (type === "staking") {
            records.push({
              refid: `staking:${currency}:${tx.transfer_date}`,
              type: "staking",
              asset: this.normalizeAsset(currency),
              amount: units,
              fee: tx.fee,
              timestamp,
              txid: null,
            });
          } else {
            records.push({
              refid: `other:${currency}:${tx.transfer_date}`,
              type: "other",
              asset: this.normalizeAsset(currency),
              amount: units,
              fee: tx.fee,
              timestamp,
              txid: null,
            });
          }
        }

        if (transactions.length < count) {
          hasMore = false;
        } else {
          offset += transactions.length;
        }

        await abortableDelay(100, signal);
      }

      await abortableDelay(100, signal);
    }

    return records;
  }
}

// Re-export for tests
export { bithumbSign };
