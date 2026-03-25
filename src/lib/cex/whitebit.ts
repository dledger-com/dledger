import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";
import { hmacSha512Hex } from "./crypto-utils.js";

const WHITEBIT_API = "https://whitebit.com";
const PROXY_PREFIX = "/api/whitebit";
const RATE_LIMIT_MS = 100;

interface WhitebitTradeRecord {
  id: number;
  clientOrderId: string;
  market: string;
  side: string;           // "buy" | "sell"
  price: string;
  amount: string;          // base quantity
  dealMoney: string;       // quote quantity
  fee: string;
  feeCurrency: string;
  time: number;            // seconds (unix)
}

interface WhitebitTradeResponse {
  records: WhitebitTradeRecord[];
  offset: number;
  limit: number;
  total: number;
}

interface WhitebitHistoryRecord {
  address: string;
  uniqueId: string | null;
  createdAt: number;       // seconds
  currency: string;
  ticker: string;
  method: number;          // 1 = deposit, 2 = withdrawal
  amount: string;
  fee: string;
  status: number;
  transactionHash: string | null;
  confirmations: Record<string, unknown>;
}

interface WhitebitHistoryResponse {
  records: WhitebitHistoryRecord[];
  offset: number;
  limit: number;
  total: number;
}

async function whitebitFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, WHITEBIT_API, PROXY_PREFIX, init, signal);
}

/**
 * Sign a WhiteBIT API request.
 * payload = base64(JSON.stringify(body))
 * signature = hex(HMAC_SHA512(secret, payload))
 */
async function whitebitSign(
  bodyObj: Record<string, unknown>,
  secret: string,
): Promise<{ payload: string; signature: string }> {
  const payload = btoa(JSON.stringify(bodyObj));
  const signature = await hmacSha512Hex(secret, payload);
  return { payload, signature };
}

function parseMarket(market: string): { base: string; quote: string } | null {
  const parts = market.split("_");
  if (parts.length === 2) return { base: parts[0], quote: parts[1] };
  return null;
}

export class WhitebitAdapter implements CexAdapter {
  readonly exchangeId = "whitebit" as const;
  readonly exchangeName = "WhiteBIT";

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

  private async signedPost(
    path: string,
    extraBody: Record<string, unknown>,
    apiKey: string,
    apiSecret: string,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: string }> {
    const nonce = Date.now();
    const bodyObj = {
      request: path,
      nonce,
      ...extraBody,
    };

    const { payload, signature } = await whitebitSign(bodyObj, apiSecret);

    return whitebitFetch(`${WHITEBIT_API}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-TXC-APIKEY": apiKey,
        "X-TXC-PAYLOAD": payload,
        "X-TXC-SIGNATURE": signature,
      },
      body: JSON.stringify(bodyObj),
    }, signal);
  }

  private async fetchTrades(
    apiKey: string,
    apiSecret: string,
    _since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let offset = 0;
    const limit = 100;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const extraBody: Record<string, unknown> = {
        limit,
        offset,
      };

      const result = await this.signedPost("/api/v4/trade-account/executed-history", extraBody, apiKey, apiSecret, signal);
      const json = JSON.parse(result.body) as WhitebitTradeResponse;

      const items = json.records;
      if (!items || items.length === 0) break;

      for (const trade of items) {
        const parsed = parseMarket(trade.market);
        if (!parsed) continue;

        const { base, quote } = parsed;
        const refid = `${trade.market}:${trade.id}`;
        const isBuy = trade.side === "buy";
        const ts = trade.time;

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
          amount: isBuy ? `-${trade.dealMoney}` : trade.dealMoney,
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

      if (offset + items.length >= json.total) break;
      offset += items.length;
      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }

  private async fetchDeposits(
    apiKey: string,
    apiSecret: string,
    _since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let offset = 0;
    const limit = 100;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const extraBody: Record<string, unknown> = {
        transactionMethod: 1,
        limit,
        offset,
      };

      const result = await this.signedPost("/api/v4/main-account/history", extraBody, apiKey, apiSecret, signal);
      const json = JSON.parse(result.body) as WhitebitHistoryResponse;

      const items = json.records;
      if (!items || items.length === 0) break;

      for (const dep of items) {
        records.push({
          refid: `deposit:${dep.uniqueId || dep.createdAt}`,
          type: "deposit",
          asset: this.normalizeAsset(dep.ticker || dep.currency),
          amount: dep.amount,
          fee: dep.fee || "0",
          timestamp: dep.createdAt,
          txid: dep.transactionHash ? normalizeTxid(dep.transactionHash) : null,
          metadata: {
            "deposit:status": String(dep.status),
          },
        });
      }

      if (offset + items.length >= json.total) break;
      offset += items.length;
      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }

  private async fetchWithdrawals(
    apiKey: string,
    apiSecret: string,
    _since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let offset = 0;
    const limit = 100;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const extraBody: Record<string, unknown> = {
        transactionMethod: 2,
        limit,
        offset,
      };

      const result = await this.signedPost("/api/v4/main-account/history", extraBody, apiKey, apiSecret, signal);
      const json = JSON.parse(result.body) as WhitebitHistoryResponse;

      const items = json.records;
      if (!items || items.length === 0) break;

      for (const wd of items) {
        records.push({
          refid: `withdraw:${wd.uniqueId || wd.createdAt}`,
          type: "withdrawal",
          asset: this.normalizeAsset(wd.ticker || wd.currency),
          amount: `-${wd.amount}`,
          fee: wd.fee || "0",
          timestamp: wd.createdAt,
          txid: wd.transactionHash ? normalizeTxid(wd.transactionHash) : null,
          metadata: {
            "withdrawal:status": String(wd.status),
          },
        });
      }

      if (offset + items.length >= json.total) break;
      offset += items.length;
      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }
}
