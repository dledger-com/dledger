import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";
import { hmacSha384Hex } from "./crypto-utils.js";

const GEMINI_API = "https://api.gemini.com";
const PROXY_PREFIX = "/api/gemini";
const RATE_LIMIT_MS = 200;

interface GeminiTrade {
  tid: number;
  order_id: string;
  symbol: string;
  type: string;           // "Buy" | "Sell"
  price: string;
  amount: string;
  fee_currency: string;
  fee_amount: string;
  timestamp: number;       // seconds
  timestampms: number;
  aggressor: boolean;
}

interface GeminiTransfer {
  eid: number;
  type: string;           // "Deposit" | "Withdrawal"
  currency: string;
  amount: string;
  fee: string;
  method: string;
  txHash: string;
  timestamp: number;       // seconds
  timestampms: number;
  status: string;
  purpose: string;
}

async function geminiFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, GEMINI_API, PROXY_PREFIX, init, signal);
}

/**
 * Sign a Gemini API request.
 * payload = base64(JSON.stringify(request_obj))
 * signature = hex(HMAC_SHA384(secret, payload))
 */
async function geminiSign(
  payloadObj: Record<string, unknown>,
  secret: string,
): Promise<{ payload: string; signature: string }> {
  const payload = btoa(JSON.stringify(payloadObj));
  const signature = await hmacSha384Hex(secret, payload);
  return { payload, signature };
}

// Common Gemini trading pairs
const GEMINI_SYMBOLS = [
  "btcusd", "ethusd", "ethbtc", "solusd", "ltcusd", "dogeusd",
  "btceur", "etheur", "btcgbp", "ethgbp",
  "linkusd", "uniusd", "avaxusd", "maticusd", "dotusd", "adausd",
  "daiusd", "aaveusd",
];

const QUOTE_CURRENCIES = ["USD", "EUR", "GBP", "BTC", "ETH", "DAI", "USDT"];

function parseGeminiSymbol(symbol: string): { base: string; quote: string } | null {
  const upper = symbol.toUpperCase();
  for (const q of QUOTE_CURRENCIES) {
    if (upper.endsWith(q)) {
      const base = upper.slice(0, -q.length);
      if (base.length > 0) return { base, quote: q };
    }
  }
  return null;
}

export class GeminiAdapter implements CexAdapter {
  readonly exchangeId = "gemini" as const;
  readonly exchangeName = "Gemini";

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

  private async signedPost(
    path: string,
    extraPayload: Record<string, unknown>,
    apiKey: string,
    apiSecret: string,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: string }> {
    const nonce = Date.now();
    const payloadObj = {
      request: path,
      nonce,
      ...extraPayload,
    };

    const { payload, signature } = await geminiSign(payloadObj, apiSecret);

    return geminiFetch(`${GEMINI_API}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Content-Length": "0",
        "X-GEMINI-APIKEY": apiKey,
        "X-GEMINI-PAYLOAD": payload,
        "X-GEMINI-SIGNATURE": signature,
        "Cache-Control": "no-cache",
      },
      body: "",
    }, signal);
  }

  private async fetchTrades(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];

    for (const symbol of GEMINI_SYMBOLS) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const parsed = parseGeminiSymbol(symbol);
      if (!parsed) continue;

      const extraPayload: Record<string, unknown> = {
        symbol,
        limit_trades: 500,
      };
      if (since) {
        extraPayload.timestamp = Math.floor(since);
      }

      try {
        const result = await this.signedPost("/v1/mytrades", extraPayload, apiKey, apiSecret, signal);
        const trades = JSON.parse(result.body) as GeminiTrade[];

        if (!Array.isArray(trades)) continue;

        for (const trade of trades) {
          const { base, quote } = parsed;
          const refid = `${symbol}:${trade.tid}`;
          const isBuy = trade.type === "Buy";
          const ts = trade.timestampms / 1000;
          const quoteAmount = (parseFloat(trade.price) * parseFloat(trade.amount)).toString();

          const tradeMeta: Record<string, string> = {
            "trade:symbol": symbol,
            "trade:side": trade.type.toLowerCase(),
            "trade:price": trade.price,
          };

          // Base asset record
          records.push({
            refid,
            type: "trade",
            asset: this.normalizeAsset(base),
            amount: isBuy ? trade.amount : `-${trade.amount}`,
            fee: trade.fee_currency.toUpperCase() === base ? trade.fee_amount : "0",
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
            fee: trade.fee_currency.toUpperCase() === quote ? trade.fee_amount : "0",
            timestamp: ts,
            txid: null,
            metadata: tradeMeta,
          });

          // Fee in third currency
          if (trade.fee_currency.toUpperCase() !== base && trade.fee_currency.toUpperCase() !== quote) {
            records.push({
              refid,
              type: "trade",
              asset: this.normalizeAsset(trade.fee_currency),
              amount: "0",
              fee: trade.fee_amount,
              timestamp: ts,
              txid: null,
              metadata: tradeMeta,
            });
          }
        }
      } catch {
        // Symbol not available — skip silently
      }

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

    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const extraPayload: Record<string, unknown> = {
      limit_transfers: 50,
    };
    if (since) {
      extraPayload.timestamp = Math.floor(since * 1000);
    }

    const result = await this.signedPost("/v1/transfers", extraPayload, apiKey, apiSecret, signal);
    const transfers = JSON.parse(result.body) as GeminiTransfer[];

    if (!Array.isArray(transfers)) return records;

    for (const tx of transfers) {
      const isDeposit = tx.type === "Deposit";
      const isWithdrawal = tx.type === "Withdrawal";

      if (!isDeposit && !isWithdrawal) continue;

      records.push({
        refid: `${tx.type.toLowerCase()}:${tx.eid}`,
        type: isDeposit ? "deposit" : "withdrawal",
        asset: this.normalizeAsset(tx.currency),
        amount: isWithdrawal ? `-${tx.amount}` : tx.amount,
        fee: tx.fee || "0",
        timestamp: tx.timestampms / 1000,
        txid: tx.txHash ? normalizeTxid(tx.txHash) : null,
        metadata: {
          [`${tx.type.toLowerCase()}:method`]: tx.method,
          [`${tx.type.toLowerCase()}:status`]: tx.status,
        },
      });
    }

    return records;
  }
}
