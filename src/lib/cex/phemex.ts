import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";
import { hmacSha256Hex } from "./crypto-utils.js";

const PHEMEX_API = "https://api.phemex.com";
const PROXY_PREFIX = "/api/phemex";
const RATE_LIMIT_MS = 200;

/** Phemex scales crypto amounts by 10^8, fiat by 10^4. */
const CRYPTO_SCALE = 1e8;
const FIAT_SCALE = 1e4;

const FIAT_CURRENCIES = new Set(["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "KRW", "BRL", "TRY"]);

interface PhemexResponse<T> {
  code: number;
  msg: string;
  data: T;
}

interface PhemexTrade {
  tradeId: string;
  symbol: string;
  side: string;         // "Buy" | "Sell"
  priceEp: number;
  baseQtyEv: number;
  quoteQtyEv: number;
  feeAmountEv: number;
  feeCurrency: string;
  execTimestamp: number; // ns
}

interface PhemexTradeData {
  rows: PhemexTrade[];
  total: number;
}

interface PhemexDeposit {
  id: number;
  currency: string;
  amountEv: number;
  txHash: string;
  createdAt: number;     // ms
  status: string;
}

interface PhemexDepositData {
  rows: PhemexDeposit[];
  total: number;
}

interface PhemexWithdrawal {
  id: number;
  currency: string;
  amountEv: number;
  feeEv: number;
  txHash: string;
  createdAt: number;     // ms
  status: string;
}

interface PhemexWithdrawalData {
  rows: PhemexWithdrawal[];
  total: number;
}

async function phemexFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, PHEMEX_API, PROXY_PREFIX, init, signal);
}

/**
 * Sign a Phemex API request.
 * signature = hex(HMAC_SHA256(secret, path + queryString + expiry + body))
 */
async function phemexSign(
  path: string,
  queryString: string,
  expiry: string,
  body: string,
  secret: string,
): Promise<string> {
  const signString = path + queryString + expiry + body;
  return hmacSha256Hex(secret, signString);
}

function scaleDown(value: number, currency: string): string {
  const scale = FIAT_CURRENCIES.has(currency.toUpperCase()) ? FIAT_SCALE : CRYPTO_SCALE;
  return (value / scale).toString();
}

function parseSymbol(symbol: string): { base: string; quote: string } | null {
  // Phemex spot symbols: "sBTCUSDT", "sETHUSDT" (prefixed with 's')
  const raw = symbol.startsWith("s") ? symbol.slice(1) : symbol;
  const quotes = ["USDT", "USDC", "BTC", "ETH", "USD"];
  for (const q of quotes) {
    if (raw.endsWith(q)) {
      const base = raw.slice(0, -q.length);
      if (base.length > 0) return { base, quote: q };
    }
  }
  return null;
}

export class PhemexAdapter implements CexAdapter {
  readonly exchangeId = "phemex" as const;
  readonly exchangeName = "Phemex";

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
    const expiry = String(Math.floor(Date.now() / 1000) + 60);
    const queryString = params.toString();

    const signature = await phemexSign(path, queryString, expiry, "", apiSecret);
    const fullUrl = queryString
      ? `${PHEMEX_API}${path}?${queryString}`
      : `${PHEMEX_API}${path}`;

    return phemexFetch(fullUrl, {
      method: "GET",
      headers: {
        "x-phemex-access-token": apiKey,
        "x-phemex-request-expiry": expiry,
        "x-phemex-request-signature": signature,
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
    let offset = 0;
    const limit = 200;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({
        offset: String(offset),
        limit: String(limit),
      });
      if (since) {
        params.set("start", String(Math.floor(since * 1000)));
      }

      const result = await this.signedGet("/exchange/spot/order/trades", params, apiKey, apiSecret, signal);
      const json = JSON.parse(result.body) as PhemexResponse<PhemexTradeData>;

      if (json.code !== 0) throw new Error(`Phemex API error: ${json.msg}`);

      const rows = json.data?.rows;
      if (!rows || rows.length === 0) break;

      for (const trade of rows) {
        const parsed = parseSymbol(trade.symbol);
        if (!parsed) continue;

        const { base, quote } = parsed;
        const refid = `${trade.symbol}:${trade.tradeId}`;
        const isBuy = trade.side === "Buy";
        const ts = trade.execTimestamp / 1e9; // ns to seconds

        const baseAmount = scaleDown(trade.baseQtyEv, base);
        const quoteAmount = scaleDown(trade.quoteQtyEv, quote);
        const feeAmount = scaleDown(trade.feeAmountEv, trade.feeCurrency || base);

        const tradeMeta: Record<string, string> = {
          "trade:symbol": trade.symbol,
          "trade:side": trade.side.toLowerCase(),
        };

        // Base asset record
        records.push({
          refid,
          type: "trade",
          asset: this.normalizeAsset(base),
          amount: isBuy ? baseAmount : `-${baseAmount}`,
          fee: trade.feeCurrency?.toUpperCase() === base ? feeAmount : "0",
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
          fee: trade.feeCurrency?.toUpperCase() === quote ? feeAmount : "0",
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
            fee: feeAmount,
            timestamp: ts,
            txid: null,
            metadata: tradeMeta,
          });
        }
      }

      if (rows.length < limit) break;
      offset += rows.length;
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
    let offset = 0;
    const limit = 200;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({
        offset: String(offset),
        limit: String(limit),
      });
      if (since) {
        params.set("start", String(Math.floor(since * 1000)));
      }

      const result = await this.signedGet("/exchange/wallets/depositList", params, apiKey, apiSecret, signal);
      const json = JSON.parse(result.body) as PhemexResponse<PhemexDepositData>;

      if (json.code !== 0) throw new Error(`Phemex API error: ${json.msg}`);

      const rows = json.data?.rows;
      if (!rows || rows.length === 0) break;

      for (const dep of rows) {
        const amount = scaleDown(dep.amountEv, dep.currency);
        records.push({
          refid: `deposit:${dep.id}`,
          type: "deposit",
          asset: this.normalizeAsset(dep.currency),
          amount,
          fee: "0",
          timestamp: dep.createdAt / 1000,
          txid: dep.txHash ? normalizeTxid(dep.txHash) : null,
          metadata: {
            "deposit:status": dep.status,
          },
        });
      }

      if (rows.length < limit) break;
      offset += rows.length;
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
    let offset = 0;
    const limit = 200;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({
        offset: String(offset),
        limit: String(limit),
      });
      if (since) {
        params.set("start", String(Math.floor(since * 1000)));
      }

      const result = await this.signedGet("/exchange/wallets/withdrawList", params, apiKey, apiSecret, signal);
      const json = JSON.parse(result.body) as PhemexResponse<PhemexWithdrawalData>;

      if (json.code !== 0) throw new Error(`Phemex API error: ${json.msg}`);

      const rows = json.data?.rows;
      if (!rows || rows.length === 0) break;

      for (const wd of rows) {
        const amount = scaleDown(wd.amountEv, wd.currency);
        const fee = scaleDown(wd.feeEv, wd.currency);
        records.push({
          refid: `withdraw:${wd.id}`,
          type: "withdrawal",
          asset: this.normalizeAsset(wd.currency),
          amount: `-${amount}`,
          fee,
          timestamp: wd.createdAt / 1000,
          txid: wd.txHash ? normalizeTxid(wd.txHash) : null,
          metadata: {
            "withdrawal:status": wd.status,
          },
        });
      }

      if (rows.length < limit) break;
      offset += rows.length;
      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }
}
