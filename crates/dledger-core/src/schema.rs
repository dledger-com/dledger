/// SQL schema for dledger. Shared between native (rusqlite) and browser (wa-sqlite).
/// All decimal amounts stored as TEXT. UUID v7 primary keys stored as TEXT.

pub const SCHEMA_VERSION: u32 = 4;

pub const SCHEMA_SQL: &str = r#"
-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

-- Currency / asset registry
CREATE TABLE IF NOT EXISTS currency (
    code TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    decimal_places INTEGER NOT NULL DEFAULT 2,
    is_base INTEGER NOT NULL DEFAULT 0,
    is_spam INTEGER NOT NULL DEFAULT 0
);

-- Chart of accounts
CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY NOT NULL,
    parent_id TEXT REFERENCES account(id),
    account_type TEXT NOT NULL CHECK(account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
    name TEXT NOT NULL,
    full_name TEXT NOT NULL UNIQUE,
    allowed_currencies TEXT NOT NULL DEFAULT '[]',  -- JSON array of currency codes
    is_postable INTEGER NOT NULL DEFAULT 1,
    is_archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_parent ON account(parent_id);
CREATE INDEX IF NOT EXISTS idx_account_type ON account(account_type);

-- Closure table for account hierarchy (efficient subtree queries)
CREATE TABLE IF NOT EXISTS account_closure (
    ancestor_id TEXT NOT NULL REFERENCES account(id),
    descendant_id TEXT NOT NULL REFERENCES account(id),
    depth INTEGER NOT NULL,
    PRIMARY KEY (ancestor_id, descendant_id)
);
CREATE INDEX IF NOT EXISTS idx_account_closure_desc ON account_closure(descendant_id);

-- Journal entries (immutable transaction headers)
CREATE TABLE IF NOT EXISTS journal_entry (
    id TEXT PRIMARY KEY NOT NULL,
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed', 'pending', 'voided')),
    source TEXT NOT NULL DEFAULT 'manual',
    voided_by TEXT REFERENCES journal_entry(id),
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal_entry_date ON journal_entry(date);
CREATE INDEX IF NOT EXISTS idx_journal_entry_status ON journal_entry(status);

-- Line items (postings within a journal entry)
CREATE TABLE IF NOT EXISTS line_item (
    id TEXT PRIMARY KEY NOT NULL,
    journal_entry_id TEXT NOT NULL REFERENCES journal_entry(id),
    account_id TEXT NOT NULL REFERENCES account(id),
    currency TEXT NOT NULL REFERENCES currency(code),
    amount TEXT NOT NULL,  -- rust_decimal as TEXT
    lot_id TEXT REFERENCES lot(id),
    CONSTRAINT fk_line_item_entry FOREIGN KEY (journal_entry_id) REFERENCES journal_entry(id)
);
CREATE INDEX IF NOT EXISTS idx_line_item_entry ON line_item(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_line_item_account ON line_item(account_id);
CREATE INDEX IF NOT EXISTS idx_line_item_currency ON line_item(currency);

-- Cost basis lots
CREATE TABLE IF NOT EXISTS lot (
    id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL REFERENCES account(id),
    currency TEXT NOT NULL REFERENCES currency(code),
    acquired_date TEXT NOT NULL,
    original_quantity TEXT NOT NULL,
    remaining_quantity TEXT NOT NULL,
    cost_basis_per_unit TEXT NOT NULL,
    cost_basis_currency TEXT NOT NULL REFERENCES currency(code),
    journal_entry_id TEXT NOT NULL REFERENCES journal_entry(id),
    is_closed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lot_account_currency ON lot(account_id, currency);
CREATE INDEX IF NOT EXISTS idx_lot_open ON lot(account_id, currency, is_closed, acquired_date);

-- Lot disposals
CREATE TABLE IF NOT EXISTS lot_disposal (
    id TEXT PRIMARY KEY NOT NULL,
    lot_id TEXT NOT NULL REFERENCES lot(id),
    journal_entry_id TEXT NOT NULL REFERENCES journal_entry(id),
    quantity TEXT NOT NULL,
    proceeds_per_unit TEXT NOT NULL,
    proceeds_currency TEXT NOT NULL REFERENCES currency(code),
    realized_gain_loss TEXT NOT NULL,
    disposal_date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lot_disposal_lot ON lot_disposal(lot_id);
CREATE INDEX IF NOT EXISTS idx_lot_disposal_date ON lot_disposal(disposal_date);

-- Historical exchange rates / price points
CREATE TABLE IF NOT EXISTS exchange_rate (
    id TEXT PRIMARY KEY NOT NULL,
    date TEXT NOT NULL,
    from_currency TEXT NOT NULL REFERENCES currency(code),
    to_currency TEXT NOT NULL REFERENCES currency(code),
    rate TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual'
);
CREATE INDEX IF NOT EXISTS idx_exchange_rate_pair_date ON exchange_rate(from_currency, to_currency, date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_exchange_rate_unique_pair_date ON exchange_rate(date, from_currency, to_currency);

-- Balance assertions
CREATE TABLE IF NOT EXISTS balance_assertion (
    id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL REFERENCES account(id),
    date TEXT NOT NULL,
    currency TEXT NOT NULL REFERENCES currency(code),
    expected_balance TEXT NOT NULL,
    is_passing INTEGER NOT NULL DEFAULT 1,
    actual_balance TEXT
);
CREATE INDEX IF NOT EXISTS idx_balance_assertion_account ON balance_assertion(account_id);

-- Key-value metadata on journal entries
CREATE TABLE IF NOT EXISTS journal_entry_metadata (
    journal_entry_id TEXT NOT NULL REFERENCES journal_entry(id),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (journal_entry_id, key)
);

-- Append-only audit log
CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY NOT NULL,
    timestamp TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);

-- Raw transaction data for re-processing
CREATE TABLE IF NOT EXISTS raw_transaction (
    source TEXT PRIMARY KEY,
    data TEXT NOT NULL
);

-- Enable WAL mode and foreign keys
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
"#;

pub const MIGRATION_V4: &str = r#"
ALTER TABLE currency ADD COLUMN is_spam INTEGER NOT NULL DEFAULT 0;
"#;

pub const MIGRATION_V3: &str = r#"
CREATE TABLE IF NOT EXISTS raw_transaction (
    source TEXT PRIMARY KEY,
    data TEXT NOT NULL
);
"#;

/// Migration from schema version 1 to 2: deduplicate exchange rates, then add unique index.
pub const MIGRATION_V2: &str = r#"
DELETE FROM exchange_rate
WHERE rowid NOT IN (
  SELECT MAX(rowid) FROM exchange_rate
  GROUP BY date, from_currency, to_currency
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_exchange_rate_unique_pair_date
    ON exchange_rate(date, from_currency, to_currency);
"#;
