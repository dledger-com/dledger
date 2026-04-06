use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Top-level account type following standard double-entry accounting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountType {
    Asset,
    Liability,
    Equity,
    Revenue,
    Expense,
}

impl AccountType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Asset => "asset",
            Self::Liability => "liability",
            Self::Equity => "equity",
            Self::Revenue => "revenue",
            Self::Expense => "expense",
        }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "asset" => Some(Self::Asset),
            "liability" => Some(Self::Liability),
            "equity" => Some(Self::Equity),
            "revenue" => Some(Self::Revenue),
            "expense" => Some(Self::Expense),
            _ => None,
        }
    }
}

/// Currency / asset definition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Currency {
    /// Short code, e.g. "EUR", "BTC", "ETH"
    pub code: String,
    /// Asset type: "crypto", "fiat", "stock", "commodity", "index", "bond", or "" (unclassified)
    #[serde(default)]
    pub asset_type: String,
    /// Optional qualifier, e.g. "ethereum:0xabc..." for chain-specific tokens
    #[serde(default)]
    pub param: String,
    /// Human-readable name
    pub name: String,
    /// Number of decimal places for display (e.g. 2 for EUR, 8 for BTC)
    pub decimal_places: u8,
    /// Whether this is the base/reporting currency
    pub is_base: bool,
}

/// An account in the chart of accounts. Hierarchical via parent_id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    pub id: Uuid,
    /// Parent account ID (None for top-level accounts)
    pub parent_id: Option<Uuid>,
    /// Account type determines which side of the balance sheet
    pub account_type: AccountType,
    /// Short name (e.g. "Checking", "Bitcoin", "Salary")
    pub name: String,
    /// Full path from root (e.g. "Assets:Bank:Checking")
    pub full_name: String,
    /// Currencies allowed in this account (empty = any)
    pub allowed_currencies: Vec<String>,
    /// Whether this account can receive postings (leaf accounts only)
    pub is_postable: bool,
    /// Whether this account is archived (hidden from active views)
    pub is_archived: bool,
    pub created_at: NaiveDate,
    /// Optional explicit open date (for Beancount `open` directive). Falls back to `created_at`.
    pub opened_at: Option<NaiveDate>,
}

/// Status of a journal entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JournalEntryStatus {
    /// Confirmed and final
    Confirmed,
    /// Pending review (e.g. from plugin import)
    Pending,
    /// Voided by a reversing entry
    Voided,
}

impl JournalEntryStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Confirmed => "confirmed",
            Self::Pending => "pending",
            Self::Voided => "voided",
        }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "confirmed" => Some(Self::Confirmed),
            "pending" => Some(Self::Pending),
            "voided" => Some(Self::Voided),
            _ => None,
        }
    }
}

/// Immutable transaction header.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JournalEntry {
    pub id: Uuid,
    pub date: NaiveDate,
    pub description: String,
    pub status: JournalEntryStatus,
    /// Source of this entry (e.g. "manual", "plugin:csv-import")
    pub source: String,
    /// If this entry was voided, the ID of the reversing entry
    pub voided_by: Option<Uuid>,
    pub created_at: NaiveDate,
}

/// A single line (posting) within a journal entry.
/// Positive = debit, negative = credit. SUM across all line items in an entry = 0.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineItem {
    pub id: Uuid,
    pub journal_entry_id: Uuid,
    pub account_id: Uuid,
    pub currency: String,
    #[serde(default)]
    pub currency_asset_type: String,
    #[serde(default)]
    pub currency_param: String,
    /// Positive = debit, negative = credit
    pub amount: Decimal,
    /// Optional lot ID this posting is associated with
    pub lot_id: Option<Uuid>,
}

/// Cost basis lot for an asset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lot {
    pub id: Uuid,
    /// Account that holds this lot
    pub account_id: Uuid,
    /// Currency of the asset
    pub currency: String,
    #[serde(default)]
    pub currency_asset_type: String,
    #[serde(default)]
    pub currency_param: String,
    /// Date the lot was acquired
    pub acquired_date: NaiveDate,
    /// Original quantity acquired
    pub original_quantity: Decimal,
    /// Remaining quantity (decreases as lot is consumed)
    pub remaining_quantity: Decimal,
    /// Cost basis per unit in the base currency
    pub cost_basis_per_unit: Decimal,
    /// Base currency used for cost basis
    pub cost_basis_currency: String,
    #[serde(default)]
    pub cost_basis_currency_asset_type: String,
    #[serde(default)]
    pub cost_basis_currency_param: String,
    /// Journal entry that created this lot
    pub journal_entry_id: Uuid,
    /// Whether this lot is fully consumed
    pub is_closed: bool,
}

/// Records consumption (disposal) of a lot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LotDisposal {
    pub id: Uuid,
    pub lot_id: Uuid,
    /// Journal entry that triggered the disposal
    pub journal_entry_id: Uuid,
    /// Quantity disposed from this lot
    pub quantity: Decimal,
    /// Proceeds per unit in base currency
    pub proceeds_per_unit: Decimal,
    /// Base currency for proceeds
    pub proceeds_currency: String,
    #[serde(default)]
    pub proceeds_currency_asset_type: String,
    #[serde(default)]
    pub proceeds_currency_param: String,
    /// Realized gain or loss (total, not per-unit)
    pub realized_gain_loss: Decimal,
    pub disposal_date: NaiveDate,
}

/// Historical exchange rate / price point.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExchangeRate {
    pub id: Uuid,
    pub date: NaiveDate,
    pub from_currency: String,
    #[serde(default)]
    pub from_currency_asset_type: String,
    #[serde(default)]
    pub from_currency_param: String,
    pub to_currency: String,
    #[serde(default)]
    pub to_currency_asset_type: String,
    #[serde(default)]
    pub to_currency_param: String,
    pub rate: Decimal,
    /// Source of this rate (e.g. "manual", "plugin:coingecko")
    pub source: String,
}

/// Beancount-inspired balance assertion: assert account has expected balance at date.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BalanceAssertion {
    pub id: Uuid,
    pub account_id: Uuid,
    pub date: NaiveDate,
    pub currency: String,
    #[serde(default)]
    pub currency_asset_type: String,
    #[serde(default)]
    pub currency_param: String,
    pub expected_balance: Decimal,
    pub is_passing: bool,
    pub actual_balance: Option<Decimal>,
    #[serde(default)]
    pub is_strict: bool,
    #[serde(default)]
    pub include_subaccounts: bool,
}

/// Extensible key-value metadata on a journal entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Metadata {
    pub journal_entry_id: Uuid,
    pub key: String,
    pub value: String,
}

/// Append-only audit log entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditLogEntry {
    pub id: Uuid,
    pub timestamp: NaiveDate,
    pub action: String,
    pub entity_type: String,
    pub entity_id: Uuid,
    pub details: String,
}

/// Balance for a single currency (used in balance queries).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CurrencyBalance {
    pub currency: String,
    pub amount: Decimal,
}

/// Filter for querying journal entries.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TransactionFilter {
    pub account_id: Option<Uuid>,
    pub account_ids: Option<Vec<Uuid>>,
    pub from_date: Option<NaiveDate>,
    pub to_date: Option<NaiveDate>,
    pub status: Option<JournalEntryStatus>,
    pub source: Option<String>,
    pub description_search: Option<String>,
    pub tag_filters: Option<Vec<String>>,
    pub tag_filters_or: Option<Vec<String>>,
    pub link_filters: Option<Vec<String>>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    pub order_by: Option<String>,
    pub order_direction: Option<String>,
}

/// Lot booking method.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum BookingMethod {
    /// First In, First Out (default, matches French PEPS)
    #[default]
    Fifo,
    /// Specific identification by lot ID
    SpecificIdentification,
}

/// Which normalized source types a currency appears in (e.g. "etherscan", "manual", "ledger-file").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CurrencyOrigin {
    pub currency: String,
    pub origin: String,
}

/// Currency rate source configuration (which API/handler to use for exchange rates).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurrencyRateSource {
    pub currency: String,
    #[serde(default)]
    pub asset_type: String,
    #[serde(default)]
    pub param: String,
    pub rate_source: String,
    pub set_by: String,
}

/// Budget definition for tracking spending against targets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Budget {
    pub id: Uuid,
    pub account_pattern: String,
    pub period_type: String,
    pub amount: Decimal,
    pub currency: String,
    #[serde(default)]
    pub currency_asset_type: String,
    #[serde(default)]
    pub currency_param: String,
    pub start_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
    pub created_at: NaiveDate,
}

/// Reconciliation record for an account statement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reconciliation {
    pub id: Uuid,
    pub account_id: Uuid,
    pub statement_date: NaiveDate,
    pub statement_balance: Decimal,
    pub currency: String,
    pub reconciled_at: NaiveDate,
    pub line_item_count: u32,
}

/// Unreconciled line item for reconciliation UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnreconciledLineItem {
    pub line_item_id: Uuid,
    pub entry_id: Uuid,
    pub entry_date: NaiveDate,
    pub entry_description: String,
    pub account_id: Uuid,
    pub currency: String,
    pub amount: Decimal,
    pub is_reconciled: bool,
}

/// Recurring transaction template.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecurringTemplate {
    pub id: Uuid,
    pub description: String,
    pub frequency: String,
    pub interval: u32,
    pub next_date: NaiveDate,
    pub end_date: Option<NaiveDate>,
    pub is_active: bool,
    pub line_items_json: String,
    pub created_at: NaiveDate,
}
