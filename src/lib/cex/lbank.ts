import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";
import { hmacSha256Hex } from "./crypto-utils.js";

const LBANK_API = "https://api.lbank.info";
const PROXY_PREFIX = "/api/lbank";
const RATE_LIMIT_MS = 150;

interface LbankResponse<T> {
  result: boolean;
  error_code?: number;
  data: T;
}

interface LbankTrade {
  date_utc: string;
  trade_id: string;
  symbol: string;
  type: string;       // "buy" | "sell"
  price: string;
  amount: string;      // base quantity
  total: string;       // quote quantity
  fee: string;
  fee_currency: string;
}

interface LbankDeposit {
  id: string;
  asset: string;
  amount: string;
  fee: string;
  time: number;        // ms
  txId: string;
  status: string;
}

interface LbankWithdrawal {
  id: string;
  asset: string;
  amount: string;
  fee: string;
  time: number;        // ms
  txId: string;
  status: string;
}

async function lbankFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, LBANK_API, PROXY_PREFIX, init, signal);
}

/**
 * Sign an LBank API request.
 * sign = hex(HMAC_SHA256(secret, sorted_param_string))
 */
async function lbankSign(params: Record<string, string>, secret: string): Promise<string> {
  const sorted = Object.keys(params).sort();
  const paramString = sorted.map((k) => `${k}=${params[k]}`).join("&");
  return hmacSha256Hex(secret, paramString);
}

function parseSymbol(symbol: string): { base: string; quote: string } | null {
  const parts = symbol.split("_");
  if (parts.length === 2) return { base: parts[0].toUpperCase(), quote: parts[1].toUpperCase() };
  return null;
}

export class LbankAdapter implements CexAdapter {
  readonly exchangeId = "lbank" as const;
  readonly exchangeName = "LBank";

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
    params: Record<string, string>,
    apiKey: string,
    apiSecret: string,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: string }> {
    const allParams: Record<string, string> = { ...params, api_key: apiKey };
    const signature = await lbankSign(allParams, apiSecret);
    allParams.sign = signature;

    const body = new URLSearchParams(allParams).toString();

    return lbankFetch(`${LBANK_API}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }, signal);
  }

  private async fetchTrades(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    // LBank requires a symbol — we need to query known pairs
    // Fetch trade history across common pairs
    const symbols = ["btc_usdt", "eth_usdt", "eth_btc"];

    for (const symbol of symbols) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const parsed = parseSymbol(symbol);
      if (!parsed) continue;

      let page = 1;
      for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const params: Record<string, string> = {
          symbol,
          current_page: String(page),
          page_length: "200",
        };
        if (since) {
          params.since = String(Math.floor(since * 1000));
        }

        const result = await this.signedPost("/v2/transaction_history.do", params, apiKey, apiSecret, signal);
        const json = JSON.parse(result.body) as LbankResponse<LbankTrade[]>;

        if (!json.result || !Array.isArray(json.data) || json.data.length === 0) break;

        for (const trade of json.data) {
          const { base, quote } = parsed;
          const refid = `${symbol}:${trade.trade_id}`;
          const isBuy = trade.type === "buy";
          const ts = new Date(trade.date_utc).getTime() / 1000;

          const tradeMeta: Record<string, string> = {
            "trade:symbol": symbol,
            "trade:side": trade.type,
            "trade:price": trade.price,
          };

          // Base asset record
          records.push({
            refid,
            type: "trade",
            asset: this.normalizeAsset(base),
            amount: isBuy ? trade.amount : `-${trade.amount}`,
            fee: trade.fee_currency?.toUpperCase() === base ? trade.fee : "0",
            timestamp: ts,
            txid: null,
            metadata: tradeMeta,
          });

          // Quote asset record
          records.push({
            refid,
            type: "trade",
            asset: this.normalizeAsset(quote),
            amount: isBuy ? `-${trade.total}` : trade.total,
            fee: trade.fee_currency?.toUpperCase() === quote ? trade.fee : "0",
            timestamp: ts,
            txid: null,
            metadata: tradeMeta,
          });
        }

        if (json.data.length < 200) break;
        page++;
        await abortableDelay(RATE_LIMIT_MS, signal);
      }

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

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params: Record<string, string> = {
        current_page: String(page),
        page_length: "200",
      };
      if (since) {
        params.start_time = String(Math.floor(since * 1000));
      }

      const result = await this.signedPost("/v2/deposit_history.do", params, apiKey, apiSecret, signal);
      const json = JSON.parse(result.body) as LbankResponse<LbankDeposit[]>;

      if (!json.result || !Array.isArray(json.data) || json.data.length === 0) break;

      for (const dep of json.data) {
        records.push({
          refid: `deposit:${dep.id}`,
          type: "deposit",
          asset: this.normalizeAsset(dep.asset),
          amount: dep.amount,
          fee: dep.fee || "0",
          timestamp: dep.time / 1000,
          txid: dep.txId ? normalizeTxid(dep.txId) : null,
        });
      }

      if (json.data.length < 200) break;
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

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params: Record<string, string> = {
        current_page: String(page),
        page_length: "200",
      };
      if (since) {
        params.start_time = String(Math.floor(since * 1000));
      }

      const result = await this.signedPost("/v2/withdraw_history.do", params, apiKey, apiSecret, signal);
      const json = JSON.parse(result.body) as LbankResponse<LbankWithdrawal[]>;

      if (!json.result || !Array.isArray(json.data) || json.data.length === 0) break;

      for (const wd of json.data) {
        records.push({
          refid: `withdraw:${wd.id}`,
          type: "withdrawal",
          asset: this.normalizeAsset(wd.asset),
          amount: `-${wd.amount}`,
          fee: wd.fee || "0",
          timestamp: wd.time / 1000,
          txid: wd.txId ? normalizeTxid(wd.txId) : null,
        });
      }

      if (json.data.length < 200) break;
      page++;
      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }
}
