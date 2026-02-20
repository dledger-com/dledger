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

    // -- Accounts --

    fn create_account(&self, account: &Account) -> StorageResult<()>;
    fn get_account(&self, id: &Uuid) -> StorageResult<Option<Account>>;
    fn get_account_by_full_name(&self, full_name: &str) -> StorageResult<Option<Account>>;
    fn list_accounts(&self) -> StorageResult<Vec<Account>>;
    fn update_account_archived(&self, id: &Uuid, is_archived: bool) -> StorageResult<()>;
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

    // -- Schema --

    fn execute_sql(&self, sql: &str) -> StorageResult<()>;
    fn get_schema_version(&self) -> StorageResult<u32>;
    fn set_schema_version(&self, version: u32) -> StorageResult<()>;
}
