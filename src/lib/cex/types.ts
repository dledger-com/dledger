export type ExchangeId = "kraken" | "binance" | "coinbase" | "bybit" | "okx" | "bitstamp" | "cryptocom" | "volet";

export interface ExchangeAccount {
  id: string;
  exchange: ExchangeId;
  label: string;
  api_key: string;
  api_secret: string;
  passphrase?: string | null;
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
  metadata?: Record<string, string>;
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
  requiresPassphrase?: boolean;
  normalizeAsset(raw: string): string;
  fetchLedgerRecords(apiKey: string, apiSecret: string, since?: number, signal?: AbortSignal, passphrase?: string): Promise<CexLedgerRecord[]>;
}
