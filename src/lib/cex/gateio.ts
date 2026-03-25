import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";
import { hmacSha512Hex, sha512Hex } from "./crypto-utils.js";

const GATEIO_API = "https://api.gateio.ws";
const RATE_LIMIT_MS = 50;

async function gateioFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, GATEIO_API, "/api/gateio", init, signal);
}

/**
 * Sign a Gate.io API request.
 * Payload = METHOD\n/path\nqueryString\nSHA512(body)\ntimestamp
 * Signature = HexEncode(HMAC-SHA512(secret, payload))
 */
async function gateioSign(
  method: string,
  path: string,
  queryString: string,
  body: string,
  timestamp: string,
  secret: string,
): Promise<string> {
  const bodyHash = await sha512Hex(body);
  const payload = `${method}\n${path}\n${queryString}\n${bodyHash}\n${timestamp}`;
  return hmacSha512Hex(secret, payload);
}

// --- API response types ---

interface GateioTrade {
  id: string;
  currency_pair: string;
  side: string;
  amount: string;
  price: string;
  fee: string;
  fee_currency: string;
  create_time: string;
  create_time_ms: string;
  order_id: string;
}

interface GateioDeposit {
  id: string;
  currency: string;
  amount: string;
  txid: string;
  timestamp: string;
  status: string;
  chain: string;
}

interface GateioWithdrawal {
  id: string;
  currency: string;
  amount: string;
  fee: string;
  txid: string;
  timestamp: string;
  status: string;
  chain: string;
}

export class GateioAdapter implements CexAdapter {
  readonly exchangeId = "gateio" as const;
  readonly exchangeName = "Gate.io";

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

    const tradeRecords = await this.fetchTrades(apiKey, apiSecret, since, signal);
    records.push(...tradeRecords);

    const depositRecords = await this.fetchDeposits(apiKey, apiSecret, since, signal);
    records.push(...depositRecords);

    const withdrawalRecords = await this.fetchWithdrawals(apiKey, apiSecret, since, signal);
    records.push(...withdrawalRecords);

    return records;
  }

  private async signedGet(
    path: string,
    params: URLSearchParams,
    apiKey: string,
    apiSecret: string,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: string }> {
    const queryString = params.toString();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await gateioSign("GET", path, queryString, "", timestamp, apiSecret);
    const fullUrl = queryString ? `${GATEIO_API}${path}?${queryString}` : `${GATEIO_API}${path}`;

    return gateioFetch(
      fullUrl,
      {
        method: "GET",
        headers: {
          KEY: apiKey,
          Timestamp: timestamp,
          SIGN: signature,
        },
      },
      signal,
    );
  }

  private async fetchTrades(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let offset = 0;
    const limit = 1000;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
      });
      if (since) {
        params.set("from", String(since));
      }

      const result = await this.signedGet(
        "/api/v4/spot/my_trades",
        params,
        apiKey,
        apiSecret,
        signal,
      );

      const trades = JSON.parse(result.body) as GateioTrade[];
      if (!Array.isArray(trades) || trades.length === 0) break;

      for (const trade of trades) {
        const parts = trade.currency_pair.split("_");
        const base = parts[0];
        const quote = parts[1];
        const refid = `${trade.currency_pair}:${trade.id}`;
        const isBuy = trade.side === "buy";
        const quoteAmount = String(parseFloat(trade.amount) * parseFloat(trade.price));
        const absFee = String(Math.abs(parseFloat(trade.fee)));

        const tradeMeta: Record<string, string> = {
          "trade:symbol": trade.currency_pair,
          "trade:side": trade.side,
          "trade:price": trade.price,
          "trade:quantity": trade.amount,
          "trade:quote_amount": quoteAmount,
          "trade:commission": absFee,
          "trade:commission_asset": trade.fee_currency,
          "trade:order_id": trade.order_id,
        };

        // Base asset record
        records.push({
          refid,
          type: "trade",
          asset: this.normalizeAsset(base),
          amount: isBuy ? trade.amount : `-${trade.amount}`,
          fee: trade.fee_currency === base ? absFee : "0",
          timestamp: Number(trade.create_time_ms) / 1000,
          txid: null,
          metadata: tradeMeta,
        });

        // Quote asset record
        records.push({
          refid,
          type: "trade",
          asset: this.normalizeAsset(quote),
          amount: isBuy ? `-${quoteAmount}` : quoteAmount,
          fee: trade.fee_currency === quote ? absFee : "0",
          timestamp: Number(trade.create_time_ms) / 1000,
          txid: null,
          metadata: tradeMeta,
        });

        // If commission asset is neither base nor quote
        if (trade.fee_currency !== base && trade.fee_currency !== quote) {
          records.push({
            refid,
            type: "trade",
            asset: this.normalizeAsset(trade.fee_currency),
            amount: "0",
            fee: absFee,
            timestamp: Number(trade.create_time_ms) / 1000,
            txid: null,
            metadata: tradeMeta,
          });
        }
      }

      if (trades.length < limit) break;
      offset += trades.length;

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
    const limit = 100;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
      });
      if (since) {
        params.set("from", String(since));
      }

      const result = await this.signedGet(
        "/api/v4/wallet/deposits",
        params,
        apiKey,
        apiSecret,
        signal,
      );

      const deposits = JSON.parse(result.body) as GateioDeposit[];
      if (!Array.isArray(deposits) || deposits.length === 0) break;

      for (const dep of deposits) {
        // Only include successful deposits
        if (dep.status !== "DONE") continue;

        records.push({
          refid: `deposit:${dep.id}`,
          type: "deposit",
          asset: this.normalizeAsset(dep.currency),
          amount: dep.amount,
          fee: "0",
          timestamp: Number(dep.timestamp),
          txid: dep.txid ? normalizeTxid(dep.txid) : null,
          metadata: {
            "deposit:chain": dep.chain,
            "deposit:status": dep.status,
          },
        });
      }

      if (deposits.length < limit) break;
      offset += deposits.length;

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
    const limit = 100;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
      });
      if (since) {
        params.set("from", String(since));
      }

      const result = await this.signedGet(
        "/api/v4/wallet/withdrawals",
        params,
        apiKey,
        apiSecret,
        signal,
      );

      const withdrawals = JSON.parse(result.body) as GateioWithdrawal[];
      if (!Array.isArray(withdrawals) || withdrawals.length === 0) break;

      for (const wd of withdrawals) {
        // Only include completed withdrawals
        if (wd.status !== "DONE") continue;

        records.push({
          refid: `withdraw:${wd.id}`,
          type: "withdrawal",
          asset: this.normalizeAsset(wd.currency),
          amount: `-${wd.amount}`,
          fee: wd.fee,
          timestamp: Number(wd.timestamp),
          txid: wd.txid ? normalizeTxid(wd.txid) : null,
          metadata: {
            "withdrawal:chain": wd.chain,
            "withdrawal:fee": wd.fee,
            "withdrawal:status": wd.status,
          },
        });
      }

      if (withdrawals.length < limit) break;
      offset += withdrawals.length;

      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }
}

// Re-export for tests
export { gateioSign };
