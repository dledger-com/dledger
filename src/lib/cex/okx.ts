import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";

const OKX_API = "https://www.okx.com";

async function okxFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, OKX_API, "/api/okx", init, signal);
}

/**
 * Sign an OKX API request.
 * Prehash = timestamp + method + requestPath + body
 * Signature = Base64(HMAC-SHA256(secret, prehash))
 */
async function okxSign(
  timestamp: string,
  method: string,
  requestPath: string,
  body: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const prehash = timestamp + method + requestPath + body;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(prehash));

  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

interface OkxFillEntry {
  billId: string;
  instId: string;
  side: string;
  fillSz: string;
  fillPx: string;
  fee: string;
  feeCcy: string;
  ts: string;
  tradeId: string;
  ordId: string;
}

interface OkxDepositEntry {
  depId: string;
  ccy: string;
  amt: string;
  txId: string;
  ts: string;
  state: string;
}

interface OkxWithdrawalEntry {
  wdId: string;
  ccy: string;
  amt: string;
  txId: string;
  fee: string;
  ts: string;
  state: string;
}

interface OkxResponse<T> {
  code: string;
  data: T[];
  msg?: string;
}

export class OkxAdapter implements CexAdapter {
  readonly exchangeId = "okx" as const;
  readonly exchangeName = "OKX";
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

    // 1. Fetch trades
    const tradeRecords = await this.fetchTrades(apiKey, apiSecret, since, signal, passphrase);
    records.push(...tradeRecords);

    // 2. Fetch deposits
    const depositRecords = await this.fetchDeposits(apiKey, apiSecret, signal, passphrase);
    records.push(...depositRecords);

    // 3. Fetch withdrawals
    const withdrawalRecords = await this.fetchWithdrawals(apiKey, apiSecret, signal, passphrase);
    records.push(...withdrawalRecords);

    return records;
  }

  private async signedGet(
    requestPath: string,
    params: URLSearchParams,
    apiKey: string,
    apiSecret: string,
    signal?: AbortSignal,
    passphrase?: string,
  ): Promise<{ status: number; body: string }> {
    const queryString = params.toString();
    const fullPath = queryString ? `${requestPath}?${queryString}` : requestPath;
    const timestamp = new Date().toISOString();
    const signature = await okxSign(timestamp, "GET", fullPath, "", apiSecret);

    return okxFetch(
      `${OKX_API}${fullPath}`,
      {
        method: "GET",
        headers: {
          "OK-ACCESS-KEY": apiKey,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": passphrase ?? "",
        },
      },
      signal,
    );
  }

  /**
   * Fetch trade fills using 3-month rolling windows from `since` to now.
   * OKX /api/v5/trade/fills-history has a 3-month lookback max per call.
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
    const MS_3_MONTHS = 90 * 24 * 60 * 60 * 1000;

    // Start from `since` or 3 months ago
    let windowStart = since ? since * 1000 : now - MS_3_MONTHS;

    while (windowStart < now) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const windowEnd = Math.min(windowStart + MS_3_MONTHS, now);
      let afterBillId: string | undefined;

      for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const params = new URLSearchParams({
          instType: "SPOT",
          begin: String(windowStart),
          end: String(windowEnd),
        });
        if (afterBillId) {
          params.set("after", afterBillId);
        }

        const result = await this.signedGet(
          "/api/v5/trade/fills-history",
          params,
          apiKey,
          apiSecret,
          signal,
          passphrase,
        );

        const json = JSON.parse(result.body) as OkxResponse<OkxFillEntry>;
        if (json.code !== "0") {
          throw new Error(`OKX API error: ${json.msg ?? json.code}`);
        }

        if (!json.data || json.data.length === 0) break;

        for (const fill of json.data) {
          const parts = fill.instId.split("-");
          const base = parts[0];
          const quote = parts[1];
          const refid = `${fill.instId}:${fill.tradeId}`;
          const isBuy = fill.side === "buy";
          const fillSz = fill.fillSz;
          const fillPx = fill.fillPx;
          // OKX fee is negative; negate it to get a positive fee value
          const absFee = String(Math.abs(parseFloat(fill.fee)));
          const quoteAmount = String(parseFloat(fillSz) * parseFloat(fillPx));

          // Base asset record
          records.push({
            refid,
            type: "trade",
            asset: this.normalizeAsset(base),
            amount: isBuy ? fillSz : `-${fillSz}`,
            fee: fill.feeCcy === base ? absFee : "0",
            timestamp: Number(fill.ts) / 1000,
            txid: null,
          });

          // Quote asset record
          records.push({
            refid,
            type: "trade",
            asset: this.normalizeAsset(quote),
            amount: isBuy ? `-${quoteAmount}` : quoteAmount,
            fee: fill.feeCcy === quote ? absFee : "0",
            timestamp: Number(fill.ts) / 1000,
            txid: null,
          });
        }

        // Pagination: use the last entry's billId as `after` param
        afterBillId = json.data[json.data.length - 1].billId;

        // Less than 100 entries means no more pages
        if (json.data.length < 100) break;

        await abortableDelay(200, signal);
      }

      windowStart = windowEnd;
      await abortableDelay(200, signal);
    }

    return records;
  }

  /**
   * Fetch deposit history. Cursor pagination via `after` (depId).
   * Only includes successful deposits (state == "2").
   */
  private async fetchDeposits(
    apiKey: string,
    apiSecret: string,
    signal?: AbortSignal,
    passphrase?: string,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let afterDepId: string | undefined;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams();
      if (afterDepId) {
        params.set("after", afterDepId);
      }

      const result = await this.signedGet(
        "/api/v5/asset/deposit-history",
        params,
        apiKey,
        apiSecret,
        signal,
        passphrase,
      );

      const json = JSON.parse(result.body) as OkxResponse<OkxDepositEntry>;
      if (json.code !== "0") {
        throw new Error(`OKX API error: ${json.msg ?? json.code}`);
      }

      if (!json.data || json.data.length === 0) break;

      for (const dep of json.data) {
        // Only include successful deposits
        if (dep.state !== "2") continue;

        records.push({
          refid: `deposit:${dep.depId}`,
          type: "deposit",
          asset: this.normalizeAsset(dep.ccy),
          amount: dep.amt,
          fee: "0",
          timestamp: Number(dep.ts) / 1000,
          txid: dep.txId ? normalizeTxid(dep.txId) : null,
        });
      }

      afterDepId = json.data[json.data.length - 1].depId;

      if (json.data.length < 100) break;

      await abortableDelay(200, signal);
    }

    return records;
  }

  /**
   * Fetch withdrawal history. Cursor pagination via `after` (wdId).
   * Filters out cancelled withdrawals (state == "-3").
   */
  private async fetchWithdrawals(
    apiKey: string,
    apiSecret: string,
    signal?: AbortSignal,
    passphrase?: string,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let afterWdId: string | undefined;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams();
      if (afterWdId) {
        params.set("after", afterWdId);
      }

      const result = await this.signedGet(
        "/api/v5/asset/withdrawal-history",
        params,
        apiKey,
        apiSecret,
        signal,
        passphrase,
      );

      const json = JSON.parse(result.body) as OkxResponse<OkxWithdrawalEntry>;
      if (json.code !== "0") {
        throw new Error(`OKX API error: ${json.msg ?? json.code}`);
      }

      if (!json.data || json.data.length === 0) break;

      for (const wd of json.data) {
        // Skip cancelled withdrawals
        if (wd.state === "-3") continue;

        records.push({
          refid: `withdraw:${wd.wdId}`,
          type: "withdrawal",
          asset: this.normalizeAsset(wd.ccy),
          amount: `-${wd.amt}`,
          fee: wd.fee,
          timestamp: Number(wd.ts) / 1000,
          txid: wd.txId ? normalizeTxid(wd.txId) : null,
        });
      }

      afterWdId = json.data[json.data.length - 1].wdId;

      if (json.data.length < 100) break;

      await abortableDelay(200, signal);
    }

    return records;
  }
}

// Re-export for tests
export { okxSign };
