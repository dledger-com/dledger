import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";
import { hmacSha256Hex } from "./crypto-utils.js";

const POLONIEX_API = "https://api.poloniex.com";
const PROXY_PREFIX = "/api/poloniex";
const RATE_LIMIT_MS = 200;

interface PoloniexTrade {
  id: string;
  symbol: string;
  side: string;          // "BUY" | "SELL"
  price: string;
  quantity: string;
  amount: string;         // quote amount
  feeAmount: string;
  feeCurrency: string;
  createTime: number;     // ms
}

interface PoloniexDeposit {
  depositNumber: number;
  currency: string;
  amount: string;
  fee: string;
  txid: string;
  timestamp: number;      // ms
  status: string;
}

interface PoloniexWithdrawal {
  withdrawalNumber: number;
  currency: string;
  amount: string;
  fee: string;
  txid: string;
  timestamp: number;      // ms
  status: string;
}

interface PoloniexActivity {
  deposits: PoloniexDeposit[];
  withdrawals: PoloniexWithdrawal[];
}

async function poloniexFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, POLONIEX_API, PROXY_PREFIX, init, signal);
}

/**
 * Sign a Poloniex API request.
 * signature = hex(HMAC_SHA256(secret, "GET" + timestamp + "/path" + queryString))
 */
async function poloniexSign(
  method: string,
  path: string,
  queryString: string,
  timestamp: string,
  secret: string,
): Promise<string> {
  const signString = method + timestamp + path + queryString;
  return hmacSha256Hex(secret, signString);
}

function parseSymbol(symbol: string): { base: string; quote: string } | null {
  const parts = symbol.split("_");
  if (parts.length === 2) return { base: parts[0], quote: parts[1] };
  return null;
}

export class PoloniexAdapter implements CexAdapter {
  readonly exchangeId = "poloniex" as const;
  readonly exchangeName = "Poloniex";

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

    const transfers = await this.fetchTransfers(apiKey, apiSecret, since, signal);
    records.push(...transfers);

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
    const signature = await poloniexSign("GET", path, queryString, timestamp, apiSecret);

    const fullUrl = queryString
      ? `${POLONIEX_API}${path}?${queryString}`
      : `${POLONIEX_API}${path}`;

    return poloniexFetch(fullUrl, {
      method: "GET",
      headers: {
        "key": apiKey,
        "signTimestamp": timestamp,
        "signature": signature,
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
    const limit = 500;
    let from: string | undefined;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({
        limit: String(limit),
      });
      if (from) {
        params.set("from", from);
      }
      if (since) {
        params.set("startTime", String(Math.floor(since * 1000)));
      }

      const result = await this.signedGet("/trades", params, apiKey, apiSecret, signal);
      const trades = JSON.parse(result.body) as PoloniexTrade[];

      if (!Array.isArray(trades) || trades.length === 0) break;

      for (const trade of trades) {
        const parsed = parseSymbol(trade.symbol);
        if (!parsed) continue;

        const { base, quote } = parsed;
        const refid = `${trade.symbol}:${trade.id}`;
        const isBuy = trade.side === "BUY";
        const ts = trade.createTime / 1000;

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
          fee: trade.feeCurrency?.toUpperCase() === base ? trade.feeAmount : "0",
          timestamp: ts,
          txid: null,
          metadata: tradeMeta,
        });

        // Quote asset record
        records.push({
          refid,
          type: "trade",
          asset: this.normalizeAsset(quote),
          amount: isBuy ? `-${trade.amount}` : trade.amount,
          fee: trade.feeCurrency?.toUpperCase() === quote ? trade.feeAmount : "0",
          timestamp: ts,
          txid: null,
          metadata: tradeMeta,
        });

        // Fee in third currency
        if (trade.feeCurrency && trade.feeCurrency.toUpperCase() !== base && trade.feeCurrency.toUpperCase() !== quote) {
          records.push({
            refid,
            type: "trade",
            asset: this.normalizeAsset(trade.feeCurrency),
            amount: "0",
            fee: trade.feeAmount,
            timestamp: ts,
            txid: null,
            metadata: tradeMeta,
          });
        }
      }

      if (trades.length < limit) break;
      from = trades[trades.length - 1].id;
      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }

  private async fetchTransfers(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];

    // Fetch deposits
    {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams();
      if (since) {
        params.set("start", String(Math.floor(since * 1000)));
      }

      const result = await this.signedGet("/wallets/activity", params, apiKey, apiSecret, signal);
      const activity = JSON.parse(result.body) as PoloniexActivity;

      if (activity.deposits) {
        for (const dep of activity.deposits) {
          records.push({
            refid: `deposit:${dep.depositNumber}`,
            type: "deposit",
            asset: this.normalizeAsset(dep.currency),
            amount: dep.amount,
            fee: dep.fee || "0",
            timestamp: dep.timestamp / 1000,
            txid: dep.txid ? normalizeTxid(dep.txid) : null,
            metadata: {
              "deposit:status": dep.status,
            },
          });
        }
      }

      if (activity.withdrawals) {
        for (const wd of activity.withdrawals) {
          records.push({
            refid: `withdraw:${wd.withdrawalNumber}`,
            type: "withdrawal",
            asset: this.normalizeAsset(wd.currency),
            amount: `-${wd.amount}`,
            fee: wd.fee || "0",
            timestamp: wd.timestamp / 1000,
            txid: wd.txid ? normalizeTxid(wd.txid) : null,
            metadata: {
              "withdrawal:status": wd.status,
            },
          });
        }
      }
    }

    return records;
  }
}
