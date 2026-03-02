export type JournalEntryStatus = "confirmed" | "pending" | "voided";

export interface LineItem {
  id: string;
  journal_entry_id: string;
  account_id: string;
  currency: string;
  /** Positive = debit, negative = credit */
  amount: string;
  lot_id: string | null;
}

export interface JournalEntry {
  id: string;
  date: string;
  description: string;
  status: JournalEntryStatus;
  source: string;
  voided_by: string | null;
  created_at: string;
}

export interface TransactionFilter {
  account_id?: string;
  from_date?: string;
  to_date?: string;
  status?: JournalEntryStatus;
  source?: string;
  description_search?: string;
  tag_filters?: string[];
  link_filters?: string[];
  limit?: number;
  offset?: number;
  order_by?: "date" | "description" | "status";
  order_direction?: "asc" | "desc";
}

export interface JournalEntryWithItems {
  entry: JournalEntry;
  items: LineItem[];
}
