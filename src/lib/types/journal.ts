export type JournalEntryStatus = "confirmed" | "pending" | "voided";

export interface LineItem {
  id: string;
  journal_entry_id: string;
  account_id: string;
  currency: string;
  currency_asset_type?: string;
  currency_param?: string;
  /** Positive = debit, negative = credit */
  amount: string;
  lot_id: string | null;
}

export interface JournalEntry {
  id: string;
  date: string;
  description: string;
  description_data?: string;
  status: JournalEntryStatus;
  source: string;
  voided_by: string | null;
  created_at: string;
}

export interface TransactionFilter {
  account_id?: string;
  account_ids?: string[];
  from_date?: string;
  to_date?: string;
  status?: JournalEntryStatus;
  source?: string;
  description_search?: string;
  tag_filters?: string[];
  tag_filters_or?: string[];
  link_filters?: string[];
  link_filters_or?: string[];
  limit?: number;
  offset?: number;
  order_by?: "date" | "description" | "status";
  order_direction?: "asc" | "desc";
  exclude_hidden_currencies?: boolean;
}

export interface JournalEntryWithItems {
  entry: JournalEntry;
  items: LineItem[];
}
