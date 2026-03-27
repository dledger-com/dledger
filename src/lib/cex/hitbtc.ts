import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";

const HITBTC_API = "https://api.hitbtc.com";
const PROXY_PREFIX = "/api/hitbtc";
const RATE_LIMIT_MS = 200;

interface HitbtcTrade {
  id: number;
  orderId: number;
  clientOrderId: string;
  symbol: string;
  side: string;      // "buy" | "sell"
  quantity: string;
  price: string;
  fee: string;
  timestamp: string; // ISO 8601
}

interface HitbtcTransaction {
  id: string;
  status: string;
  type: string;         // "deposit" | "withdraw"
  currency: string;
  amount: string;
  fee: string;
  createdAt: string;    // ISO 8601
  hash?: string;
}

interface HitbtcSymbol {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
}

function authHeader(apiKey: string, apiSecret: string): string {
  return "Basic " + btoa(`${apiKey}:${apiSecret}`);
}

async function hitbtcFetch(
  url: string,
  apiKey: string,
  apiSecret: string,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, HITBTC_API, PROXY_PREFIX, {
    method: "GET",
    headers: {
      Authorization: authHeader(apiKey, apiSecret),
    },
  }, signal);
}

export class HitbtcAdapter implements CexAdapter {
  readonly exchangeId = "hitbtc" as const;
  readonly exchangeName = "HitBTC";

  normalizeAsset(raw: string): string {
    return raw.toUpperCase();
  }

  async fetchLedgerRecords(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    // Fetch symbol map first for pair decomposition
    const symbolMap = await this.fetchSymbolMap(apiKey, apiSecret, signal);

    const records: CexLedgerRecord[] = [];

    const trades = await this.fetchTrades(apiKey, apiSecret, symbolMap, since, signal);
    records.push(...trades);

    const transactions = await this.fetchTransactions(apiKey, apiSecret, since, signal);
    records.push(...transactions);

    return records;
  }

  private async fetchSymbolMap(
    apiKey: string,
    apiSecret: string,
    signal?: AbortSignal,
  ): Promise<Map<string, { base: string; quote: string }>> {
    const result = await hitbtcFetch(`${HITBTC_API}/api/3/public/symbol`, apiKey, apiSecret, signal);
    const data = JSON.parse(result.body) as Record<string, HitbtcSymbol>;
    const map = new Map<string, { base: string; quote: string }>();
    for (const [id, sym] of Object.entries(data)) {
      map.set(id, { base: sym.baseCurrency.toUpperCase(), quote: sym.quoteCurrency.toUpperCase() });
    }
    return map;
  }

  private async fetchTrades(
    apiKey: string,
    apiSecret: string,
    symbolMap: Map<string, { base: string; quote: string }>,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let offset = 0;
    const limit = 1000;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      let url = `${HITBTC_API}/api/3/spot/history/trade?limit=${limit}&offset=${offset}&sort=ASC`;
      if (since) {
        url += `&from=${new Date(since * 1000).toISOString()}`;
      }

      const result = await hitbtcFetch(url, apiKey, apiSecret, signal);
      const trades = JSON.parse(result.body) as HitbtcTrade[];

      if (!Array.isArray(trades) || trades.length === 0) break;

      for (const trade of trades) {
        const pair = symbolMap.get(trade.symbol);
        if (!pair) continue;

        const ts = new Date(trade.timestamp).getTime() / 1000;
        const isBuy = trade.side === "buy";
        const baseAmount = parseFloat(trade.quantity);
        const quoteAmount = baseAmount * parseFloat(trade.price);
        const fee = parseFloat(trade.fee);
        const refid = `trade:${trade.id}`;

        const tradeMeta: Record<string, string> = {
          "trade:symbol": trade.symbol,
          "trade:side": trade.side,
          "trade:price": trade.price,
        };

        // Base leg
        records.push({
          refid,
          type: "trade",
          asset: pair.base,
          amount: isBuy ? baseAmount.toString() : `-${baseAmount}`,
          fee: "0",
          timestamp: ts,
          txid: null,
          metadata: tradeMeta,
        });

        // Quote leg — fee is always in quote currency for HitBTC
        records.push({
          refid,
          type: "trade",
          asset: pair.quote,
          amount: isBuy ? `-${quoteAmount}` : quoteAmount.toString(),
          fee: fee > 0 ? fee.toString() : "0",
          timestamp: ts,
          txid: null,
          metadata: tradeMeta,
        });
      }

      if (trades.length < limit) break;
      offset += limit;
      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }

  private async fetchTransactions(
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

      let url = `${HITBTC_API}/api/3/wallet/transactions?limit=${limit}&offset=${offset}&sort=ASC`;
      if (since) {
        url += `&from=${new Date(since * 1000).toISOString()}`;
      }

      const result = await hitbtcFetch(url, apiKey, apiSecret, signal);
      const txs = JSON.parse(result.body) as HitbtcTransaction[];

      if (!Array.isArray(txs) || txs.length === 0) break;

      for (const tx of txs) {
        if (tx.status !== "success") continue;

        const asset = this.normalizeAsset(tx.currency);
        const ts = new Date(tx.createdAt).getTime() / 1000;
        const isDeposit = tx.type === "deposit";
        const type = isDeposit ? "deposit" : "withdrawal";

        records.push({
          refid: `${type}:${tx.id}`,
          type,
          asset,
          amount: isDeposit ? tx.amount : `-${tx.amount}`,
          fee: tx.fee || "0",
          timestamp: ts,
          txid: tx.hash ? normalizeTxid(tx.hash) : null,
        });
      }

      if (txs.length < limit) break;
      offset += limit;
      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }
}
