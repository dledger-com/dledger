import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";
import { hmacSha256Base64 } from "./crypto-utils.js";

const BITGET_API = "https://api.bitget.com";
const RATE_LIMIT_MS = 150;

async function bitgetFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, BITGET_API, "/api/bitget", init, signal);
}

/**
 * Sign a Bitget API request.
 * Prehash = timestamp + METHOD + requestPath (including ?queryString) + body
 * Signature = Base64(HMAC-SHA256(secret, prehash))
 */
async function bitgetSign(
  timestamp: string,
  method: string,
  requestPath: string,
  body: string,
  secret: string,
): Promise<string> {
  const prehash = timestamp + method.toUpperCase() + requestPath + body;
  return hmacSha256Base64(secret, prehash);
}

// --- API response types ---

interface BitgetResponse<T> {
  code: string;
  msg: string;
  data: T[];
}

interface BitgetTrade {
  tradeId: string;
  symbol: string;
  side: string;
  priceAvg: string;
  size: string;
  amount: string;
  fee: string;
  feeCurrency: string;
  cTime: string;
  orderId: string;
}

interface BitgetDeposit {
  orderId: string;
  coin: string;
  size: string;
  txId: string;
  cTime: string;
  status: string;
  chain: string;
}

interface BitgetWithdrawal {
  orderId: string;
  coin: string;
  size: string;
  fee: string;
  txId: string;
  cTime: string;
  status: string;
  chain: string;
}

const KNOWN_QUOTES = ["USDT", "USDC", "BTC", "ETH", "EUR"];

function parseSymbol(symbol: string): { base: string; quote: string } | null {
  for (const q of KNOWN_QUOTES) {
    if (symbol.endsWith(q)) {
      const base = symbol.slice(0, -q.length);
      if (base.length > 0) return { base, quote: q };
    }
  }
  return null;
}

export class BitgetAdapter implements CexAdapter {
  readonly exchangeId = "bitget" as const;
  readonly exchangeName = "Bitget";
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

    const tradeRecords = await this.fetchTrades(apiKey, apiSecret, since, signal, passphrase);
    records.push(...tradeRecords);

    const depositRecords = await this.fetchDeposits(apiKey, apiSecret, since, signal, passphrase);
    records.push(...depositRecords);

    const withdrawalRecords = await this.fetchWithdrawals(apiKey, apiSecret, since, signal, passphrase);
    records.push(...withdrawalRecords);

    return records;
  }

  private async signedGet(
    path: string,
    params: URLSearchParams,
    apiKey: string,
    apiSecret: string,
    signal?: AbortSignal,
    passphrase?: string,
  ): Promise<{ status: number; body: string }> {
    const queryString = params.toString();
    const requestPath = queryString ? `${path}?${queryString}` : path;
    const timestamp = String(Date.now());
    const signature = await bitgetSign(timestamp, "GET", requestPath, "", apiSecret);

    return bitgetFetch(
      `${BITGET_API}${requestPath}`,
      {
        method: "GET",
        headers: {
          "ACCESS-KEY": apiKey,
          "ACCESS-SIGN": signature,
          "ACCESS-TIMESTAMP": timestamp,
          "ACCESS-PASSPHRASE": passphrase ?? "",
          "Content-Type": "application/json",
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
    passphrase?: string,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let endId: string | undefined;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({ limit: "100" });
      if (endId) {
        params.set("endId", endId);
      }
      if (since) {
        params.set("startTime", String(since * 1000));
      }

      const result = await this.signedGet(
        "/api/v2/spot/trade/fills",
        params,
        apiKey,
        apiSecret,
        signal,
        passphrase,
      );

      const json = JSON.parse(result.body) as BitgetResponse<BitgetTrade>;
      if (json.code !== "00000") {
        throw new Error(`Bitget API error: ${json.msg ?? json.code}`);
      }

      if (!json.data || json.data.length === 0) break;

      for (const trade of json.data) {
        const parsed = parseSymbol(trade.symbol);
        if (!parsed) continue;

        const { base, quote } = parsed;
        const refid = `${trade.symbol}:${trade.tradeId}`;
        const isBuy = trade.side === "buy";
        const absFee = String(Math.abs(parseFloat(trade.fee)));

        const tradeMeta: Record<string, string> = {
          "trade:symbol": trade.symbol,
          "trade:side": trade.side,
          "trade:price": trade.priceAvg,
          "trade:quantity": trade.size,
          "trade:quote_amount": trade.amount,
          "trade:commission": absFee,
          "trade:commission_asset": trade.feeCurrency,
          "trade:order_id": trade.orderId,
        };

        // Base asset record
        records.push({
          refid,
          type: "trade",
          asset: this.normalizeAsset(base),
          amount: isBuy ? trade.size : `-${trade.size}`,
          fee: trade.feeCurrency === base ? absFee : "0",
          timestamp: Number(trade.cTime) / 1000,
          txid: null,
          metadata: tradeMeta,
        });

        // Quote asset record
        records.push({
          refid,
          type: "trade",
          asset: this.normalizeAsset(quote),
          amount: isBuy ? `-${trade.amount}` : trade.amount,
          fee: trade.feeCurrency === quote ? absFee : "0",
          timestamp: Number(trade.cTime) / 1000,
          txid: null,
          metadata: tradeMeta,
        });

        // If commission asset is neither base nor quote
        if (trade.feeCurrency !== base && trade.feeCurrency !== quote) {
          records.push({
            refid,
            type: "trade",
            asset: this.normalizeAsset(trade.feeCurrency),
            amount: "0",
            fee: absFee,
            timestamp: Number(trade.cTime) / 1000,
            txid: null,
            metadata: tradeMeta,
          });
        }
      }

      // Pagination: use the last entry's tradeId as endId
      if (json.data.length < 100) break;
      endId = json.data[json.data.length - 1].tradeId;

      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }

  private async fetchDeposits(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
    passphrase?: string,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let endId: string | undefined;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({ limit: "100" });
      if (endId) {
        params.set("endId", endId);
      }
      if (since) {
        params.set("startTime", String(since * 1000));
      }

      const result = await this.signedGet(
        "/api/v2/spot/wallet/deposit-records",
        params,
        apiKey,
        apiSecret,
        signal,
        passphrase,
      );

      const json = JSON.parse(result.body) as BitgetResponse<BitgetDeposit>;
      if (json.code !== "00000") {
        throw new Error(`Bitget API error: ${json.msg ?? json.code}`);
      }

      if (!json.data || json.data.length === 0) break;

      for (const dep of json.data) {
        records.push({
          refid: `deposit:${dep.orderId}`,
          type: "deposit",
          asset: this.normalizeAsset(dep.coin),
          amount: dep.size,
          fee: "0",
          timestamp: Number(dep.cTime) / 1000,
          txid: dep.txId ? normalizeTxid(dep.txId) : null,
          metadata: {
            "deposit:chain": dep.chain,
            "deposit:status": dep.status,
          },
        });
      }

      if (json.data.length < 100) break;
      endId = json.data[json.data.length - 1].orderId;

      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }

  private async fetchWithdrawals(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
    passphrase?: string,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let endId: string | undefined;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const params = new URLSearchParams({ limit: "100" });
      if (endId) {
        params.set("endId", endId);
      }
      if (since) {
        params.set("startTime", String(since * 1000));
      }

      const result = await this.signedGet(
        "/api/v2/spot/wallet/withdrawal-records",
        params,
        apiKey,
        apiSecret,
        signal,
        passphrase,
      );

      const json = JSON.parse(result.body) as BitgetResponse<BitgetWithdrawal>;
      if (json.code !== "00000") {
        throw new Error(`Bitget API error: ${json.msg ?? json.code}`);
      }

      if (!json.data || json.data.length === 0) break;

      for (const wd of json.data) {
        records.push({
          refid: `withdraw:${wd.orderId}`,
          type: "withdrawal",
          asset: this.normalizeAsset(wd.coin),
          amount: `-${wd.size}`,
          fee: wd.fee,
          timestamp: Number(wd.cTime) / 1000,
          txid: wd.txId ? normalizeTxid(wd.txId) : null,
          metadata: {
            "withdrawal:chain": wd.chain,
            "withdrawal:fee": wd.fee,
            "withdrawal:status": wd.status,
          },
        });
      }

      if (json.data.length < 100) break;
      endId = json.data[json.data.length - 1].orderId;

      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }
}

// Re-export for tests
export { bitgetSign };
