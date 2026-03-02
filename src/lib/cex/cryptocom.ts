import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";

const CRYPTOCOM_API = "https://api.crypto.com";
const RATE_LIMIT_MS = 1000;

async function cryptocomFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, CRYPTOCOM_API, "/api/cryptocom", init, signal);
}

/**
 * Build a sorted parameter string for Crypto.com API signature.
 * Takes the params object, sorts keys alphabetically, and concatenates
 * as `key1value1key2value2...` (no separators).
 */
export function buildParamString(params: Record<string, unknown>): string {
  const keys = Object.keys(params).sort();
  return keys.map((k) => `${k}${params[k]}`).join("");
}

/**
 * Sign a Crypto.com API request.
 * Prehash = method + id + apiKey + sortedParamString + nonce
 * Signature = hex(HMAC-SHA256(secret, prehash))
 */
export async function cryptocomSign(
  method: string,
  id: number,
  apiKey: string,
  params: Record<string, unknown>,
  nonce: number,
  secret: string,
): Promise<string> {
  const paramString = buildParamString(params);
  const prehash = method + id + apiKey + paramString + nonce;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(prehash));

  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

interface CryptocomTrade {
  trade_id: string;
  instrument_name: string;
  side: "BUY" | "SELL";
  traded_price: string;
  traded_quantity: string;
  fee: string;
  fee_instrument_name: string;
  create_time: number;
}

interface CryptocomTradesResponse {
  code: number;
  result: {
    data: CryptocomTrade[];
  };
}

interface CryptocomDeposit {
  id: string;
  currency: string;
  amount: string;
  fee: string;
  txid: string;
  create_time: number;
  status: string;
}

interface CryptocomDepositResponse {
  code: number;
  result: {
    deposit_list: CryptocomDeposit[];
  };
}

interface CryptocomWithdrawal {
  id: string;
  currency: string;
  amount: string;
  fee: string;
  txid: string;
  create_time: number;
  status: string;
}

interface CryptocomWithdrawalResponse {
  code: number;
  result: {
    withdrawal_list: CryptocomWithdrawal[];
  };
}

// ---------------------------------------------------------------------------
// Signed POST helper
// ---------------------------------------------------------------------------

async function signedPost(
  path: string,
  method: string,
  params: Record<string, unknown>,
  apiKey: string,
  apiSecret: string,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  const nonce = Date.now();
  const id = nonce;
  const sig = await cryptocomSign(method, id, apiKey, params, nonce, apiSecret);

  const body = JSON.stringify({
    id,
    method,
    api_key: apiKey,
    params,
    nonce,
    sig,
  });

  return cryptocomFetch(
    `${CRYPTOCOM_API}${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    },
    signal,
  );
}

// ---------------------------------------------------------------------------
// CryptocomAdapter
// ---------------------------------------------------------------------------

export class CryptocomAdapter implements CexAdapter {
  readonly exchangeId = "cryptocom" as const;
  readonly exchangeName = "Crypto.com";

  normalizeAsset(raw: string): string {
    // Crypto.com uses standard asset codes; no special mapping needed
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

    await abortableDelay(RATE_LIMIT_MS, signal);

    // 2. Fetch deposits
    const depositRecords = await this.fetchDeposits(apiKey, apiSecret, since, signal);
    records.push(...depositRecords);

    await abortableDelay(RATE_LIMIT_MS, signal);

    // 3. Fetch withdrawals
    const withdrawalRecords = await this.fetchWithdrawals(apiKey, apiSecret, since, signal);
    records.push(...withdrawalRecords);

    return records;
  }

  // -------------------------------------------------------------------------
  // Trades
  // -------------------------------------------------------------------------

  private async fetchTrades(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let page = 0;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params: Record<string, unknown> = {
        page_size: 100,
        page,
      };
      if (since) {
        params.start_ts = since * 1000;
      }

      const result = await signedPost(
        "/exchange/v1/private/get-trades",
        "private/get-trades",
        params,
        apiKey,
        apiSecret,
        signal,
      );

      const json = JSON.parse(result.body) as CryptocomTradesResponse;
      if (json.code !== 0) {
        throw new Error(`Crypto.com API error (code ${json.code}): ${result.body}`);
      }

      const trades = json.result?.data ?? [];
      if (trades.length === 0) break;

      for (const trade of trades) {
        const [base, quote] = trade.instrument_name.split("_");
        const refid = `${trade.instrument_name}:${trade.trade_id}`;
        const isBuy = trade.side === "BUY";
        const quantity = trade.traded_quantity;
        const price = parseFloat(trade.traded_price);
        const qty = parseFloat(quantity);
        const quoteAmount = (qty * price).toString();
        const timestamp = trade.create_time / 1000;

        const tradeMeta: Record<string, string> = {
          "trade:symbol": trade.instrument_name,
          "trade:side": trade.side.toLowerCase(),
          "trade:price": trade.traded_price,
          "trade:quantity": quantity,
          "trade:commission": trade.fee,
          "trade:commission_asset": trade.fee_instrument_name,
        };

        // Base asset record
        records.push({
          refid,
          type: "trade",
          asset: this.normalizeAsset(base),
          amount: isBuy ? quantity : `-${quantity}`,
          fee: trade.fee_instrument_name === base ? trade.fee : "0",
          timestamp,
          txid: null,
          metadata: tradeMeta,
        });

        // Quote asset record
        records.push({
          refid,
          type: "trade",
          asset: this.normalizeAsset(quote),
          amount: isBuy ? `-${quoteAmount}` : quoteAmount,
          fee: trade.fee_instrument_name === quote ? trade.fee : "0",
          timestamp,
          txid: null,
          metadata: tradeMeta,
        });
      }

      page += 1;

      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }

  // -------------------------------------------------------------------------
  // Deposits
  // -------------------------------------------------------------------------

  private async fetchDeposits(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let page = 0;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params: Record<string, unknown> = {
        page_size: 100,
        page,
      };
      if (since) {
        params.start_ts = since * 1000;
      }

      const result = await signedPost(
        "/exchange/v1/private/get-deposit-history",
        "private/get-deposit-history",
        params,
        apiKey,
        apiSecret,
        signal,
      );

      const json = JSON.parse(result.body) as CryptocomDepositResponse;
      if (json.code !== 0) {
        throw new Error(`Crypto.com API error (code ${json.code}): ${result.body}`);
      }

      const deposits = json.result?.deposit_list ?? [];
      if (deposits.length === 0) break;

      for (const dep of deposits) {
        // Only include successful deposits (status "1")
        if (dep.status !== "1") continue;

        records.push({
          refid: `deposit:${dep.id}`,
          type: "deposit",
          asset: this.normalizeAsset(dep.currency),
          amount: dep.amount,
          fee: dep.fee,
          timestamp: dep.create_time / 1000,
          txid: dep.txid ? normalizeTxid(dep.txid) : null,
        });
      }

      page += 1;

      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }

  // -------------------------------------------------------------------------
  // Withdrawals
  // -------------------------------------------------------------------------

  private async fetchWithdrawals(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let page = 0;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params: Record<string, unknown> = {
        page_size: 100,
        page,
      };
      if (since) {
        params.start_ts = since * 1000;
      }

      const result = await signedPost(
        "/exchange/v1/private/get-withdrawal-history",
        "private/get-withdrawal-history",
        params,
        apiKey,
        apiSecret,
        signal,
      );

      const json = JSON.parse(result.body) as CryptocomWithdrawalResponse;
      if (json.code !== 0) {
        throw new Error(`Crypto.com API error (code ${json.code}): ${result.body}`);
      }

      const withdrawals = json.result?.withdrawal_list ?? [];
      if (withdrawals.length === 0) break;

      for (const wd of withdrawals) {
        records.push({
          refid: `withdraw:${wd.id}`,
          type: "withdrawal",
          asset: this.normalizeAsset(wd.currency),
          amount: `-${wd.amount}`,
          fee: wd.fee,
          timestamp: wd.create_time / 1000,
          txid: wd.txid ? normalizeTxid(wd.txid) : null,
        });
      }

      page += 1;

      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }
}
