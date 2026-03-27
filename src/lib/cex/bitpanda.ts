import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";

const BITPANDA_API = "https://api.bitpanda.com";
const PROXY_PREFIX = "/api/bitpanda";
const RATE_LIMIT_MS = 200;

interface BpTrade {
  trade_id: string;
  type: string;              // "buy" | "sell"
  cryptocoin_symbol: string;
  fiat_to_eur_rate: string;
  amount_cryptocoin: string;
  amount_fiat: string;
  fiat_currency: string;
  fee_amount: string;
  fee_currency: string;
  time: { date_iso8601: string };
}

interface BpTransaction {
  transaction_id: string;
  type: string;              // "deposit" | "withdrawal" | "transfer"
  in_or_out: string;         // "incoming" | "outgoing"
  amount: string;
  fee: string;
  cryptocoin_symbol: string;
  fiat_currency?: string;
  time: { date_iso8601: string };
  blockchain_transaction_id?: string;
  status: string;
}

interface BpPage<T> {
  data: T[];
  links?: { next?: string };
}

async function bpFetch(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, BITPANDA_API, PROXY_PREFIX, {
    method: "GET",
    headers: {
      "X-API-KEY": apiKey,
    },
  }, signal);
}

export class BitpandaAdapter implements CexAdapter {
  readonly exchangeId = "bitpanda" as const;
  readonly exchangeName = "Bitpanda";

  normalizeAsset(raw: string): string {
    return raw.toUpperCase();
  }

  async fetchLedgerRecords(
    apiKey: string,
    _apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];

    const trades = await this.fetchTrades(apiKey, since, signal);
    records.push(...trades);

    const transactions = await this.fetchTransactions(apiKey, since, signal);
    records.push(...transactions);

    return records;
  }

  private async fetchTrades(
    apiKey: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let url = `${BITPANDA_API}/v1/trades?page_size=100`;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const result = await bpFetch(url, apiKey, signal);
      const page = JSON.parse(result.body) as BpPage<BpTrade>;

      if (!Array.isArray(page.data) || page.data.length === 0) break;

      for (const trade of page.data) {
        const ts = new Date(trade.time.date_iso8601).getTime() / 1000;
        if (since && ts < since) continue;

        const crypto = this.normalizeAsset(trade.cryptocoin_symbol);
        const fiat = this.normalizeAsset(trade.fiat_currency);
        const isBuy = trade.type === "buy";
        const refid = `trade:${trade.trade_id}`;

        const tradeMeta: Record<string, string> = {
          "trade:side": trade.type,
        };

        // Crypto leg
        records.push({
          refid,
          type: "trade",
          asset: crypto,
          amount: isBuy ? trade.amount_cryptocoin : `-${trade.amount_cryptocoin}`,
          fee: this.normalizeAsset(trade.fee_currency) === crypto ? trade.fee_amount : "0",
          timestamp: ts,
          txid: null,
          metadata: tradeMeta,
        });

        // Fiat leg
        records.push({
          refid,
          type: "trade",
          asset: fiat,
          amount: isBuy ? `-${trade.amount_fiat}` : trade.amount_fiat,
          fee: this.normalizeAsset(trade.fee_currency) === fiat ? trade.fee_amount : "0",
          timestamp: ts,
          txid: null,
          metadata: tradeMeta,
        });
      }

      if (!page.links?.next) break;
      url = page.links.next;
      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }

  private async fetchTransactions(
    apiKey: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let url = `${BITPANDA_API}/v1/wallets/transactions?page_size=100`;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const result = await bpFetch(url, apiKey, signal);
      const page = JSON.parse(result.body) as BpPage<BpTransaction>;

      if (!Array.isArray(page.data) || page.data.length === 0) break;

      for (const tx of page.data) {
        if (tx.status !== "finished" && tx.status !== "confirmed") continue;

        const ts = new Date(tx.time.date_iso8601).getTime() / 1000;
        if (since && ts < since) continue;

        const asset = this.normalizeAsset(tx.cryptocoin_symbol || tx.fiat_currency || "");
        if (!asset) continue;

        const isIncoming = tx.in_or_out === "incoming";
        const type = isIncoming ? "deposit" : "withdrawal";

        records.push({
          refid: `${type}:${tx.transaction_id}`,
          type,
          asset,
          amount: isIncoming ? tx.amount : `-${tx.amount}`,
          fee: tx.fee || "0",
          timestamp: ts,
          txid: tx.blockchain_transaction_id ? normalizeTxid(tx.blockchain_transaction_id) : null,
        });
      }

      if (!page.links?.next) break;
      url = page.links.next;
      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }
}
