use chrono::NaiveDate;
use rust_decimal::Decimal;
use uuid::Uuid;

use crate::models::*;

/// Errors that can occur during storage operations.
#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("entity not found: {0}")]
    NotFound(String),
    #[error("duplicate entity: {0}")]
    Duplicate(String),
    #[error("constraint violation: {0}")]
    Constraint(String),
    #[error("storage error: {0}")]
    Internal(String),
}

pub type StorageResult<T> = Result<T, StorageError>;

/// Abstract storage trait. All ledger operations go through this.
/// Platform crates provide concrete implementations (rusqlite, wa-sqlite).
pub trait Storage: Send + Sync {
    // -- Currency --

    fn create_currency(&self, currency: &Currency) -> StorageResult<()>;
    fn get_currency(&self, code: &str) -> StorageResult<Option<Currency>>;
    fn list_currencies(&self) -> StorageResult<Vec<Currency>>;
    fn set_currency_asset_type(&self, code: &str, asset_type: &str, param: &str) -> StorageResult<()>;

    // -- Accounts --

    fn create_account(&self, account: &Account) -> StorageResult<()>;
    fn get_account(&self, id: &Uuid) -> StorageResult<Option<Account>>;
    fn get_account_by_full_name(&self, full_name: &str) -> StorageResult<Option<Account>>;
    fn list_accounts(&self) -> StorageResult<Vec<Account>>;
    fn update_account_archived(&self, id: &Uuid, is_archived: bool) -> StorageResult<()>;
    fn update_account_opened_at(&self, id: &Uuid, opened_at: Option<NaiveDate>) -> StorageResult<()>;
    /// Get all descendant account IDs (via closure table).
    fn get_account_subtree_ids(&self, id: &Uuid) -> StorageResult<Vec<Uuid>>;

    // -- Journal entries + line items (atomic write) --

    fn insert_journal_entry(
        &self,
        entry: &JournalEntry,
        items: &[LineItem],
    ) -> StorageResult<()>;

    fn get_journal_entry(
        &self,
        id: &Uuid,
    ) -> StorageResult<Option<(JournalEntry, Vec<LineItem>)>>;

    fn query_journal_entries(
        &self,
        filter: &TransactionFilter,
    ) -> StorageResult<Vec<(JournalEntry, Vec<LineItem>)>>;

    fn update_journal_entry_status(
        &self,
        id: &Uuid,
        status: JournalEntryStatus,
        voided_by: Option<Uuid>,
    ) -> StorageResult<()>;

    /// Check if any line items for an entry are reconciled.
    fn has_reconciled_items(&self, entry_id: &Uuid) -> StorageResult<bool>;

    // -- Lots --

    fn insert_lot(&self, lot: &Lot) -> StorageResult<()>;
    fn get_lot(&self, id: &Uuid) -> StorageResult<Option<Lot>>;
    fn get_open_lots_fifo(
        &self,
        account_id: &Uuid,
        currency: &str,
    ) -> StorageResult<Vec<Lot>>;
    fn update_lot_remaining(
        &self,
        id: &Uuid,
        remaining: Decimal,
        is_closed: bool,
    ) -> StorageResult<()>;
    fn insert_lot_disposal(&self, disposal: &LotDisposal) -> StorageResult<()>;
    fn get_lot_disposals_for_period(
        &self,
        from_date: NaiveDate,
        to_date: NaiveDate,
    ) -> StorageResult<Vec<LotDisposal>>;

    // -- Exchange rates --

    fn insert_exchange_rate(&self, rate: &ExchangeRate) -> StorageResult<()>;
    /// Get the closest rate on or before the given date.
    fn get_exchange_rate(
        &self,
        from: &str,
        to: &str,
        date: NaiveDate,
    ) -> StorageResult<Option<Decimal>>;
    /// Get the source of an exchange rate for a specific date and currency pair.
    fn get_exchange_rate_source(
        &self,
        from: &str,
        to: &str,
        date: NaiveDate,
    ) -> StorageResult<Option<String>>;
    /// List exchange rates with optional currency filters.
    fn list_exchange_rates(
        &self,
        from: Option<&str>,
        to: Option<&str>,
    ) -> StorageResult<Vec<ExchangeRate>>;
    /// Get all distinct from_currency codes that have a rate on an exact date.
    fn get_exchange_rate_currencies_on_date(
        &self,
        date: NaiveDate,
    ) -> StorageResult<Vec<String>>;

    // -- Balances (computed by summing line items) --

    fn sum_line_items(
        &self,
        account_ids: &[Uuid],
        before_date: Option<NaiveDate>,
    ) -> StorageResult<Vec<CurrencyBalance>>;

    // -- Balance assertions --

    fn insert_balance_assertion(&self, assertion: &BalanceAssertion) -> StorageResult<()>;
    fn update_balance_assertion_result(
        &self,
        id: &Uuid,
        is_passing: bool,
        actual_balance: Decimal,
    ) -> StorageResult<()>;
    fn get_balance_assertions(
        &self,
        account_id: Option<&Uuid>,
    ) -> StorageResult<Vec<BalanceAssertion>>;

    // -- Raw transactions --

    fn store_raw_transaction(&self, source: &str, data: &str) -> StorageResult<()>;
    fn get_raw_transaction(&self, source: &str) -> StorageResult<Option<String>>;
    fn query_raw_transactions(&self, source_prefix: &str) -> StorageResult<Vec<(String, String)>>;

    // -- Metadata --

    fn insert_metadata(
        &self,
        journal_entry_id: &Uuid,
        key: &str,
        value: &str,
    ) -> StorageResult<()>;
    fn get_metadata(&self, journal_entry_id: &Uuid) -> StorageResult<Vec<Metadata>>;
    fn query_entries_by_metadata(&self, key: &str, value: &str) -> StorageResult<Vec<Uuid>>;

    // -- Entry links --

    fn set_entry_links(&self, entry_id: &Uuid, links: &[String]) -> StorageResult<()>;
    fn get_entry_links(&self, entry_id: &Uuid) -> StorageResult<Vec<String>>;
    fn get_entries_by_link(&self, link_name: &str) -> StorageResult<Vec<Uuid>>;
    fn get_all_link_names(&self) -> StorageResult<Vec<String>>;
    fn get_all_links_with_counts(&self) -> StorageResult<Vec<(String, u64)>>;

    // -- Open lots --

    fn list_all_open_lots(&self) -> StorageResult<Vec<Lot>>;

    // -- Audit --

    fn insert_audit_log(&self, entry: &AuditLogEntry) -> StorageResult<()>;

    // -- Transactions (for atomicity) --

    fn in_transaction(
        &self,
        f: &mut dyn FnMut(&dyn Storage) -> StorageResult<()>,
    ) -> StorageResult<()>;

    // -- Hidden currencies --

    fn set_currency_hidden(&self, code: &str, is_hidden: bool) -> StorageResult<()>;
    fn list_hidden_currencies(&self) -> StorageResult<Vec<String>>;

    // -- Currency rate sources --

    fn get_currency_rate_sources(&self) -> StorageResult<Vec<CurrencyRateSource>>;
    fn set_currency_rate_source(&self, currency: &str, rate_source: &str, set_by: &str) -> StorageResult<()>;
    fn clear_auto_rate_sources(&self) -> StorageResult<()>;
    fn clear_non_user_rate_sources(&self) -> StorageResult<()>;

    // -- Integrity checks --

    fn count_orphaned_line_items(&self) -> StorageResult<u64>;
    fn count_duplicate_sources(&self) -> StorageResult<u64>;

    // -- Currency origins --

    /// Get distinct (currency, normalized_source) pairs from non-voided journal entries.
    fn get_currency_origins(&self) -> StorageResult<Vec<CurrencyOrigin>>;

    // -- Data management --

    fn clear_exchange_rates(&self) -> StorageResult<()>;
    fn clear_ledger_data(&self) -> StorageResult<()>;
    fn clear_all_data(&self) -> StorageResult<()>;

    // -- Budgets --

    fn create_budget(&self, budget: &Budget) -> StorageResult<()>;
    fn list_budgets(&self) -> StorageResult<Vec<Budget>>;
    fn update_budget(&self, budget: &Budget) -> StorageResult<()>;
    fn delete_budget(&self, id: &Uuid) -> StorageResult<()>;

    // -- Reconciliation --

    fn get_unreconciled_line_items(
        &self,
        account_id: &Uuid,
        currency: &str,
        up_to_date: Option<NaiveDate>,
    ) -> StorageResult<Vec<UnreconciledLineItem>>;
    fn mark_reconciled(
        &self,
        reconciliation: &Reconciliation,
        line_item_ids: &[Uuid],
    ) -> StorageResult<()>;
    fn list_reconciliations(
        &self,
        account_id: Option<&Uuid>,
    ) -> StorageResult<Vec<Reconciliation>>;
    fn get_reconciliation_detail(
        &self,
        id: &Uuid,
    ) -> StorageResult<Option<(Reconciliation, Vec<Uuid>)>>;

    // -- Recurring templates --

    fn create_recurring_template(&self, template: &RecurringTemplate) -> StorageResult<()>;
    fn list_recurring_templates(&self) -> StorageResult<Vec<RecurringTemplate>>;
    fn update_recurring_template(&self, template: &RecurringTemplate) -> StorageResult<()>;
    fn delete_recurring_template(&self, id: &Uuid) -> StorageResult<()>;

    // -- Pagination --

    fn count_journal_entries(&self, filter: &TransactionFilter) -> StorageResult<u64>;

    // -- Exchange accounts (CEX) --

    fn list_exchange_accounts(&self) -> StorageResult<Vec<serde_json::Value>>;
    fn add_exchange_account(&self, account: &serde_json::Value) -> StorageResult<()>;
    fn update_exchange_account(&self, id: &str, updates: &serde_json::Value) -> StorageResult<()>;
    fn remove_exchange_account(&self, id: &str) -> StorageResult<()>;

    // -- Currency token addresses --

    fn set_currency_token_address(&self, currency: &str, chain: &str, contract_address: &str) -> StorageResult<()>;
    fn get_currency_token_addresses(&self) -> StorageResult<Vec<(String, String, String)>>; // (currency, chain, contract_address)
    fn get_currency_token_address(&self, currency: &str) -> StorageResult<Option<(String, String)>>; // (chain, contract_address)

    // -- Schema --

    fn execute_sql(&self, sql: &str) -> StorageResult<()>;
    fn get_schema_version(&self) -> StorageResult<u32>;
    fn set_schema_version(&self, version: u32) -> StorageResult<()>;
}
