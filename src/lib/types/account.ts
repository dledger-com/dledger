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
}

export interface Currency {
  code: string;
  name: string;
  decimal_places: number;
  is_base: boolean;
  is_hidden?: boolean;
}
