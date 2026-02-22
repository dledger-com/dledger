export type ExchangeId = "kraken";

export interface ExchangeAccount {
  id: string;
  exchange: ExchangeId;
  label: string;
  api_key: string;
  api_secret: string;
  last_sync: string | null;
  created_at: string;
}

export interface CexLedgerRecord {
  refid: string;
  type: "trade" | "deposit" | "withdrawal" | "transfer" | "staking" | "other";
  asset: string;
  amount: string;
  fee: string;
  timestamp: number;
  txid: string | null;
}

export interface CexSyncResult {
  entries_imported: number;
  entries_skipped: number;
  entries_consolidated: number;
  accounts_created: number;
  warnings: string[];
}

export interface CexAdapter {
  exchangeId: ExchangeId;
  exchangeName: string;
  normalizeAsset(raw: string): string;
  fetchLedgerRecords(apiKey: string, apiSecret: string): Promise<CexLedgerRecord[]>;
}
