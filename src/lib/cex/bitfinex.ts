import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";
import { hmacSha384Hex } from "./crypto-utils.js";

const BITFINEX_API = "https://api.bitfinex.com";
const PROXY_PREFIX = "/api/bitfinex";
const RATE_LIMIT_MS = 200;

// Bitfinex API v2 returns arrays, not objects

/** [ID, PAIR, MTS_CREATE, ORDER_ID, EXEC_AMOUNT, EXEC_PRICE, ORDER_TYPE, ORDER_PRICE, MAKER, FEE, FEE_CURRENCY] */
type BfxTrade = [number, string, number, number, number, number, string | null, number | null, number, number, string];

/** [ID, CURRENCY, _, _, MTS_STARTED, MTS_UPDATED, _, _, _, STATUS, _, _, AMOUNT, FEE, _, _, DESTINATION_ADDRESS, _, _, _, TRANSACTION_ID, WITHDRAW_TRANSACTION_NOTE] */
type BfxMovement = [
  number, string, unknown, unknown, number, number, unknown, unknown, unknown, string,
  unknown, unknown, number, number, unknown, unknown, string | null, unknown, unknown, unknown, string | null,
];

async function bfxFetch(
  path: string,
  apiKey: string,
  apiSecret: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  const nonce = Date.now().toString();
  const bodyStr = JSON.stringify(body);
  const sigPayload = `/api/v2${path}${nonce}${bodyStr}`;
  const signature = await hmacSha384Hex(apiSecret, sigPayload);

  return cexFetch(`${BITFINEX_API}/v2${path}`, BITFINEX_API, PROXY_PREFIX, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "bfx-nonce": nonce,
      "bfx-apikey": apiKey,
      "bfx-signature": signature,
    },
    body: bodyStr,
  }, signal);
}

function normalizeCurrency(raw: string): string {
  // Bitfinex uses "UST" for USDT, "IOT" for IOTA, etc.
  const map: Record<string, string> = {
    UST: "USDT", IOT: "IOTA", DSH: "DASH", QTM: "QTUM",
    DAT: "DATA", QSH: "QASH", YYW: "YOYOW", MNA: "MANA",
  };
  const upper = raw.replace(/^t/, "").toUpperCase();
  return map[upper] ?? upper;
}

function parsePair(pair: string): { base: string; quote: string } | null {
  // "tBTCUSD" or "tETH:UST" style
  const cleaned = pair.replace(/^t/, "");
  if (cleaned.includes(":")) {
    const [base, quote] = cleaned.split(":");
    return { base: normalizeCurrency(base), quote: normalizeCurrency(quote) };
  }
  // Fixed-length: 6 chars → 3+3
  if (cleaned.length === 6) {
    return { base: normalizeCurrency(cleaned.slice(0, 3)), quote: normalizeCurrency(cleaned.slice(3)) };
  }
  // Variable-length: try common quotes
  for (const q of ["USDT", "USD", "BTC", "ETH", "EUR", "GBP", "JPY"]) {
    if (cleaned.endsWith(q) && cleaned.length > q.length) {
      return { base: normalizeCurrency(cleaned.slice(0, -q.length)), quote: normalizeCurrency(q) };
    }
  }
  return null;
}

export class BitfinexAdapter implements CexAdapter {
  readonly exchangeId = "bitfinex" as const;
  readonly exchangeName = "Bitfinex";

  normalizeAsset(raw: string): string {
    return normalizeCurrency(raw);
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

    const movements = await this.fetchMovements(apiKey, apiSecret, since, signal);
    records.push(...movements);

    return records;
  }

  private async fetchTrades(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let end: number | undefined;
    const start = since ? Math.floor(since * 1000) : 0;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const body: Record<string, unknown> = { limit: 2500, sort: 1 };
      if (start) body.start = start;
      if (end) body.end = end;

      const result = await bfxFetch("/auth/r/trades/hist", apiKey, apiSecret, body, signal);
      const trades = JSON.parse(result.body) as BfxTrade[];

      if (!Array.isArray(trades) || trades.length === 0) break;

      for (const t of trades) {
        const [id, pair, mts, , execAmount, execPrice, , , , fee, feeCurrency] = t;
        const parsed = parsePair(pair);
        if (!parsed) continue;

        const ts = mts / 1000;
        const isBuy = execAmount > 0;
        const absBase = Math.abs(execAmount);
        const absQuote = absBase * execPrice;
        const refid = `trade:${id}`;
        const normalizedFeeCurr = normalizeCurrency(feeCurrency);

        const tradeMeta: Record<string, string> = {
          "trade:symbol": pair,
          "trade:side": isBuy ? "buy" : "sell",
          "trade:price": execPrice.toString(),
        };

        records.push({
          refid,
          type: "trade",
          asset: parsed.base,
          amount: isBuy ? absBase.toString() : `-${absBase}`,
          fee: normalizedFeeCurr === parsed.base ? Math.abs(fee).toString() : "0",
          timestamp: ts,
          txid: null,
          metadata: tradeMeta,
        });

        records.push({
          refid,
          type: "trade",
          asset: parsed.quote,
          amount: isBuy ? `-${absQuote}` : absQuote.toString(),
          fee: normalizedFeeCurr === parsed.quote ? Math.abs(fee).toString() : "0",
          timestamp: ts,
          txid: null,
          metadata: tradeMeta,
        });
      }

      if (trades.length < 2500) break;
      end = trades[trades.length - 1][2] - 1; // mts of last trade
      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }

  private async fetchMovements(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let end: number | undefined;
    const start = since ? Math.floor(since * 1000) : 0;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const body: Record<string, unknown> = { limit: 1000 };
      if (start) body.start = start;
      if (end) body.end = end;

      const result = await bfxFetch("/auth/r/movements/hist", apiKey, apiSecret, body, signal);
      const movements = JSON.parse(result.body) as BfxMovement[];

      if (!Array.isArray(movements) || movements.length === 0) break;

      for (const m of movements) {
        const [id, currency, , , mtsStarted, , , , , status, , , amount, fee, , , , , , , txid] = m;

        // Only include completed movements
        if (!status?.startsWith("COMPLETED")) continue;

        const asset = normalizeCurrency(currency);
        const isDeposit = amount > 0;

        records.push({
          refid: `${isDeposit ? "deposit" : "withdraw"}:${id}`,
          type: isDeposit ? "deposit" : "withdrawal",
          asset,
          amount: amount.toString(),
          fee: Math.abs(fee).toString(),
          timestamp: mtsStarted / 1000,
          txid: txid ? normalizeTxid(txid) : null,
        });
      }

      if (movements.length < 1000) break;
      end = movements[movements.length - 1][4] - 1;
      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }
}
