export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export interface Account {
  id: string;
  parent_id: string | null;
  account_type: AccountType;
  name: string;
  full_name: string;
  allowed_currencies: string[];
  is_postable: boolean;
  is_archived: boolean;
  created_at: string;
  opened_at?: string | null;
}

export type CurrencyAssetType = "crypto" | "fiat" | "stock" | "commodity" | "index" | "bond" | "";

export interface Currency {
  code: string;
  asset_type: string;
  name: string;
  decimal_places: number;
  is_hidden?: boolean;
  tracks_currency?: string | null;
  sync_full_range?: boolean;
  is_stale?: boolean;
}
