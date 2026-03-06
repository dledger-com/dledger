/// SQL schema for dledger. Shared between native (rusqlite) and browser (wa-sqlite).
/// All decimal amounts stored as TEXT. UUID v7 primary keys stored as TEXT.

pub const SCHEMA_VERSION: u32 = 19;

pub const SCHEMA_SQL: &str = r#"
-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

-- Currency / asset registry
CREATE TABLE IF NOT EXISTS currency (
    code TEXT NOT NULL,
    asset_type TEXT NOT NULL DEFAULT '',
    param TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    decimal_places INTEGER NOT NULL DEFAULT 2,
    is_base INTEGER NOT NULL DEFAULT 0,
    is_hidden INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (code, asset_type, param)
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
    created_at TEXT NOT NULL,
    opened_at TEXT
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
    currency TEXT NOT NULL,
    currency_asset_type TEXT NOT NULL DEFAULT '',
    currency_param TEXT NOT NULL DEFAULT '',
    amount TEXT NOT NULL,  -- rust_decimal as TEXT
    lot_id TEXT REFERENCES lot(id),
    is_reconciled INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (currency, currency_asset_type, currency_param) REFERENCES currency(code, asset_type, param)
);
CREATE INDEX IF NOT EXISTS idx_line_item_entry ON line_item(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_line_item_account ON line_item(account_id);
CREATE INDEX IF NOT EXISTS idx_line_item_currency ON line_item(currency);

-- Cost basis lots
CREATE TABLE IF NOT EXISTS lot (
    id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL REFERENCES account(id),
    currency TEXT NOT NULL,
    currency_asset_type TEXT NOT NULL DEFAULT '',
    currency_param TEXT NOT NULL DEFAULT '',
    acquired_date TEXT NOT NULL,
    original_quantity TEXT NOT NULL,
    remaining_quantity TEXT NOT NULL,
    cost_basis_per_unit TEXT NOT NULL,
    cost_basis_currency TEXT NOT NULL,
    cost_basis_currency_asset_type TEXT NOT NULL DEFAULT '',
    cost_basis_currency_param TEXT NOT NULL DEFAULT '',
    journal_entry_id TEXT NOT NULL REFERENCES journal_entry(id),
    is_closed INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (currency, currency_asset_type, currency_param) REFERENCES currency(code, asset_type, param),
    FOREIGN KEY (cost_basis_currency, cost_basis_currency_asset_type, cost_basis_currency_param) REFERENCES currency(code, asset_type, param)
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
    proceeds_currency TEXT NOT NULL,
    proceeds_currency_asset_type TEXT NOT NULL DEFAULT '',
    proceeds_currency_param TEXT NOT NULL DEFAULT '',
    realized_gain_loss TEXT NOT NULL,
    disposal_date TEXT NOT NULL,
    FOREIGN KEY (proceeds_currency, proceeds_currency_asset_type, proceeds_currency_param) REFERENCES currency(code, asset_type, param)
);
CREATE INDEX IF NOT EXISTS idx_lot_disposal_lot ON lot_disposal(lot_id);
CREATE INDEX IF NOT EXISTS idx_lot_disposal_date ON lot_disposal(disposal_date);

-- Historical exchange rates / price points
CREATE TABLE IF NOT EXISTS exchange_rate (
    id TEXT PRIMARY KEY NOT NULL,
    date TEXT NOT NULL,
    from_currency TEXT NOT NULL,
    from_currency_asset_type TEXT NOT NULL DEFAULT '',
    from_currency_param TEXT NOT NULL DEFAULT '',
    to_currency TEXT NOT NULL,
    to_currency_asset_type TEXT NOT NULL DEFAULT '',
    to_currency_param TEXT NOT NULL DEFAULT '',
    rate TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    FOREIGN KEY (from_currency, from_currency_asset_type, from_currency_param) REFERENCES currency(code, asset_type, param),
    FOREIGN KEY (to_currency, to_currency_asset_type, to_currency_param) REFERENCES currency(code, asset_type, param)
);
CREATE INDEX IF NOT EXISTS idx_exchange_rate_pair_date ON exchange_rate(from_currency, to_currency, date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_exchange_rate_unique_pair_date ON exchange_rate(date, from_currency, to_currency);

-- Balance assertions
CREATE TABLE IF NOT EXISTS balance_assertion (
    id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL REFERENCES account(id),
    date TEXT NOT NULL,
    currency TEXT NOT NULL,
    currency_asset_type TEXT NOT NULL DEFAULT '',
    currency_param TEXT NOT NULL DEFAULT '',
    expected_balance TEXT NOT NULL,
    is_passing INTEGER NOT NULL DEFAULT 1,
    actual_balance TEXT,
    is_strict INTEGER NOT NULL DEFAULT 0,
    include_subaccounts INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (currency, currency_asset_type, currency_param) REFERENCES currency(code, asset_type, param)
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

-- Currency rate source configuration
CREATE TABLE IF NOT EXISTS currency_rate_source (
    currency TEXT NOT NULL,
    asset_type TEXT NOT NULL DEFAULT '',
    param TEXT NOT NULL DEFAULT '',
    rate_source TEXT NOT NULL,
    set_by TEXT NOT NULL DEFAULT 'auto',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (currency, asset_type, param)
);

-- Budgets (v8)
CREATE TABLE IF NOT EXISTS budget (
    id TEXT PRIMARY KEY,
    account_pattern TEXT NOT NULL,
    period_type TEXT NOT NULL DEFAULT 'monthly',
    amount TEXT NOT NULL,
    currency TEXT NOT NULL,
    currency_asset_type TEXT NOT NULL DEFAULT '',
    currency_param TEXT NOT NULL DEFAULT '',
    start_date TEXT,
    end_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Reconciliation (v9)
CREATE TABLE IF NOT EXISTS reconciliation (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    statement_date TEXT NOT NULL,
    statement_balance TEXT NOT NULL,
    currency TEXT NOT NULL,
    reconciled_at TEXT NOT NULL,
    line_item_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reconciliation_line_item (
    reconciliation_id TEXT NOT NULL,
    line_item_id TEXT NOT NULL,
    PRIMARY KEY (reconciliation_id, line_item_id)
);

-- Recurring templates (v10)
CREATE TABLE IF NOT EXISTS recurring_template (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    frequency TEXT NOT NULL CHECK(frequency IN ('daily','weekly','monthly','yearly')),
    interval_val INTEGER NOT NULL DEFAULT 1,
    next_date TEXT NOT NULL,
    end_date TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    line_items_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);

-- CEX exchange accounts (v11, passphrase added v13)
CREATE TABLE IF NOT EXISTS exchange_account (
    id TEXT PRIMARY KEY NOT NULL,
    exchange TEXT NOT NULL,
    label TEXT NOT NULL,
    api_key TEXT NOT NULL,
    api_secret TEXT NOT NULL,
    linked_etherscan_account_id TEXT,
    passphrase TEXT,
    last_sync TEXT,
    created_at TEXT NOT NULL
);

-- Currency token addresses (v12)
CREATE TABLE IF NOT EXISTS currency_token_address (
    currency TEXT NOT NULL,
    asset_type TEXT NOT NULL DEFAULT '',
    param TEXT NOT NULL DEFAULT '',
    chain TEXT NOT NULL,
    contract_address TEXT NOT NULL,
    PRIMARY KEY (currency, asset_type, param, chain)
);

-- Account metadata (v14)
CREATE TABLE IF NOT EXISTS account_metadata (
    account_id TEXT NOT NULL REFERENCES account(id),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (account_id, key)
);
CREATE INDEX IF NOT EXISTS idx_account_metadata_key_value ON account_metadata(key, value);

-- Transaction links (v16)
CREATE TABLE IF NOT EXISTS entry_link (
    journal_entry_id TEXT NOT NULL REFERENCES journal_entry(id),
    link_name TEXT NOT NULL,
    PRIMARY KEY (journal_entry_id, link_name)
);
CREATE INDEX IF NOT EXISTS idx_entry_link_name ON entry_link(link_name);

-- French tax reports (v19)
CREATE TABLE IF NOT EXISTS french_tax_report (
    tax_year INTEGER PRIMARY KEY NOT NULL,
    generated_at TEXT NOT NULL,
    final_acquisition_cost TEXT NOT NULL,
    report_json TEXT NOT NULL
);

-- Enable WAL mode and foreign keys
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
"#;

pub const MIGRATION_V7: &str = r#"
CREATE TABLE IF NOT EXISTS budget (
    id TEXT PRIMARY KEY,
    account_pattern TEXT NOT NULL,
    period_type TEXT NOT NULL DEFAULT 'monthly',
    amount TEXT NOT NULL,
    currency TEXT NOT NULL,
    start_date TEXT,
    end_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_metadata_key_value ON journal_entry_metadata(key, value);
"#;

pub const MIGRATION_V19: &str = r#"
DROP TABLE IF EXISTS french_tax_report;
CREATE TABLE IF NOT EXISTS french_tax_report (
    tax_year INTEGER PRIMARY KEY NOT NULL,
    generated_at TEXT NOT NULL,
    final_acquisition_cost TEXT NOT NULL,
    report_json TEXT NOT NULL
);
"#;

pub const MIGRATION_V18: &str = r#"
ALTER TABLE account ADD COLUMN opened_at TEXT;
"#;

pub const MIGRATION_V16: &str = r#"
CREATE TABLE IF NOT EXISTS entry_link (
    journal_entry_id TEXT NOT NULL REFERENCES journal_entry(id),
    link_name TEXT NOT NULL,
    PRIMARY KEY (journal_entry_id, link_name)
);
CREATE INDEX IF NOT EXISTS idx_entry_link_name ON entry_link(link_name);
"#;

pub const MIGRATION_V15: &str = r#"
ALTER TABLE balance_assertion ADD COLUMN is_strict INTEGER NOT NULL DEFAULT 0;
ALTER TABLE balance_assertion ADD COLUMN include_subaccounts INTEGER NOT NULL DEFAULT 0;
"#;

pub const MIGRATION_V14: &str = r#"
CREATE TABLE IF NOT EXISTS account_metadata (
    account_id TEXT NOT NULL REFERENCES account(id),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (account_id, key)
);
CREATE INDEX IF NOT EXISTS idx_account_metadata_key_value ON account_metadata(key, value);
"#;

pub const MIGRATION_V13: &str = r#"
ALTER TABLE exchange_account ADD COLUMN passphrase TEXT;
"#;

pub const MIGRATION_V12: &str = r#"
CREATE TABLE IF NOT EXISTS currency_token_address (
    currency TEXT NOT NULL,
    chain TEXT NOT NULL,
    contract_address TEXT NOT NULL,
    PRIMARY KEY (currency, chain)
);
"#;

pub const MIGRATION_V11: &str = r#"
CREATE TABLE IF NOT EXISTS exchange_account (
    id TEXT PRIMARY KEY NOT NULL,
    exchange TEXT NOT NULL,
    label TEXT NOT NULL,
    api_key TEXT NOT NULL,
    api_secret TEXT NOT NULL,
    linked_etherscan_account_id TEXT,
    last_sync TEXT,
    created_at TEXT NOT NULL
);
"#;

pub const MIGRATION_V10: &str = r#"
CREATE TABLE IF NOT EXISTS recurring_template (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    frequency TEXT NOT NULL CHECK(frequency IN ('daily','weekly','monthly','yearly')),
    interval_val INTEGER NOT NULL DEFAULT 1,
    next_date TEXT NOT NULL,
    end_date TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    line_items_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);
"#;

pub const MIGRATION_V9: &str = r#"
CREATE TABLE IF NOT EXISTS reconciliation (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    statement_date TEXT NOT NULL,
    statement_balance TEXT NOT NULL,
    currency TEXT NOT NULL,
    reconciled_at TEXT NOT NULL,
    line_item_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reconciliation_line_item (
    reconciliation_id TEXT NOT NULL,
    line_item_id TEXT NOT NULL,
    PRIMARY KEY (reconciliation_id, line_item_id)
);
"#;

pub const MIGRATION_V8: &str = r#"
CREATE TABLE IF NOT EXISTS budget (
    id TEXT PRIMARY KEY,
    account_pattern TEXT NOT NULL,
    period_type TEXT NOT NULL DEFAULT 'monthly',
    amount TEXT NOT NULL,
    currency TEXT NOT NULL,
    start_date TEXT,
    end_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_metadata_key_value ON journal_entry_metadata(key, value);
"#;

pub const MIGRATION_V6: &str = r#"
CREATE TABLE IF NOT EXISTS currency_rate_source (
    currency TEXT NOT NULL,
    rate_source TEXT NOT NULL,
    set_by TEXT NOT NULL DEFAULT 'auto',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (currency)
);
"#;

pub const MIGRATION_V5: &str = r#"
ALTER TABLE currency RENAME COLUMN is_spam TO is_hidden;
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

/// Migration v17: Add asset_type + param composite key to currency and all referencing tables.
pub const MIGRATION_V17: &str = r#"
PRAGMA foreign_keys = OFF;

-- 1. Recreate currency with composite PK (code, asset_type, param)
CREATE TABLE currency_new (
    code TEXT NOT NULL,
    asset_type TEXT NOT NULL DEFAULT '',
    param TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    decimal_places INTEGER NOT NULL DEFAULT 2,
    is_base INTEGER NOT NULL DEFAULT 0,
    is_hidden INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (code, asset_type, param)
);
INSERT INTO currency_new (code, name, decimal_places, is_base, is_hidden)
    SELECT code, name, decimal_places, is_base, is_hidden FROM currency;
DROP TABLE currency;
ALTER TABLE currency_new RENAME TO currency;

-- 2. Recreate line_item with currency_asset_type + currency_param
CREATE TABLE line_item_new (
    id TEXT PRIMARY KEY NOT NULL,
    journal_entry_id TEXT NOT NULL REFERENCES journal_entry(id),
    account_id TEXT NOT NULL REFERENCES account(id),
    currency TEXT NOT NULL,
    currency_asset_type TEXT NOT NULL DEFAULT '',
    currency_param TEXT NOT NULL DEFAULT '',
    amount TEXT NOT NULL,
    lot_id TEXT REFERENCES lot(id),
    is_reconciled INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (currency, currency_asset_type, currency_param) REFERENCES currency(code, asset_type, param)
);
INSERT INTO line_item_new (id, journal_entry_id, account_id, currency, amount, lot_id, is_reconciled)
    SELECT id, journal_entry_id, account_id, currency, amount, lot_id, is_reconciled FROM line_item;
DROP TABLE line_item;
ALTER TABLE line_item_new RENAME TO line_item;
CREATE INDEX idx_line_item_entry ON line_item(journal_entry_id);
CREATE INDEX idx_line_item_account ON line_item(account_id);
CREATE INDEX idx_line_item_currency ON line_item(currency);

-- 3. Recreate lot with currency + cost_basis_currency type/param
CREATE TABLE lot_new (
    id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL REFERENCES account(id),
    currency TEXT NOT NULL,
    currency_asset_type TEXT NOT NULL DEFAULT '',
    currency_param TEXT NOT NULL DEFAULT '',
    acquired_date TEXT NOT NULL,
    original_quantity TEXT NOT NULL,
    remaining_quantity TEXT NOT NULL,
    cost_basis_per_unit TEXT NOT NULL,
    cost_basis_currency TEXT NOT NULL,
    cost_basis_currency_asset_type TEXT NOT NULL DEFAULT '',
    cost_basis_currency_param TEXT NOT NULL DEFAULT '',
    journal_entry_id TEXT NOT NULL REFERENCES journal_entry(id),
    is_closed INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (currency, currency_asset_type, currency_param) REFERENCES currency(code, asset_type, param),
    FOREIGN KEY (cost_basis_currency, cost_basis_currency_asset_type, cost_basis_currency_param) REFERENCES currency(code, asset_type, param)
);
INSERT INTO lot_new (id, account_id, currency, acquired_date, original_quantity, remaining_quantity,
                     cost_basis_per_unit, cost_basis_currency, journal_entry_id, is_closed)
    SELECT id, account_id, currency, acquired_date, original_quantity, remaining_quantity,
           cost_basis_per_unit, cost_basis_currency, journal_entry_id, is_closed FROM lot;
DROP TABLE lot;
ALTER TABLE lot_new RENAME TO lot;
CREATE INDEX idx_lot_account_currency ON lot(account_id, currency);
CREATE INDEX idx_lot_open ON lot(account_id, currency, is_closed, acquired_date);

-- 4. Recreate lot_disposal with proceeds_currency type/param
CREATE TABLE lot_disposal_new (
    id TEXT PRIMARY KEY NOT NULL,
    lot_id TEXT NOT NULL REFERENCES lot(id),
    journal_entry_id TEXT NOT NULL REFERENCES journal_entry(id),
    quantity TEXT NOT NULL,
    proceeds_per_unit TEXT NOT NULL,
    proceeds_currency TEXT NOT NULL,
    proceeds_currency_asset_type TEXT NOT NULL DEFAULT '',
    proceeds_currency_param TEXT NOT NULL DEFAULT '',
    realized_gain_loss TEXT NOT NULL,
    disposal_date TEXT NOT NULL,
    FOREIGN KEY (proceeds_currency, proceeds_currency_asset_type, proceeds_currency_param) REFERENCES currency(code, asset_type, param)
);
INSERT INTO lot_disposal_new (id, lot_id, journal_entry_id, quantity, proceeds_per_unit,
                               proceeds_currency, realized_gain_loss, disposal_date)
    SELECT id, lot_id, journal_entry_id, quantity, proceeds_per_unit,
           proceeds_currency, realized_gain_loss, disposal_date FROM lot_disposal;
DROP TABLE lot_disposal;
ALTER TABLE lot_disposal_new RENAME TO lot_disposal;
CREATE INDEX idx_lot_disposal_lot ON lot_disposal(lot_id);
CREATE INDEX idx_lot_disposal_date ON lot_disposal(disposal_date);

-- 5. Recreate exchange_rate with from/to currency type/param
CREATE TABLE exchange_rate_new (
    id TEXT PRIMARY KEY NOT NULL,
    date TEXT NOT NULL,
    from_currency TEXT NOT NULL,
    from_currency_asset_type TEXT NOT NULL DEFAULT '',
    from_currency_param TEXT NOT NULL DEFAULT '',
    to_currency TEXT NOT NULL,
    to_currency_asset_type TEXT NOT NULL DEFAULT '',
    to_currency_param TEXT NOT NULL DEFAULT '',
    rate TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    FOREIGN KEY (from_currency, from_currency_asset_type, from_currency_param) REFERENCES currency(code, asset_type, param),
    FOREIGN KEY (to_currency, to_currency_asset_type, to_currency_param) REFERENCES currency(code, asset_type, param)
);
INSERT INTO exchange_rate_new (id, date, from_currency, to_currency, rate, source)
    SELECT id, date, from_currency, to_currency, rate, source FROM exchange_rate;
DROP TABLE exchange_rate;
ALTER TABLE exchange_rate_new RENAME TO exchange_rate;
CREATE INDEX idx_exchange_rate_pair_date ON exchange_rate(from_currency, to_currency, date);
CREATE UNIQUE INDEX idx_exchange_rate_unique_pair_date ON exchange_rate(date, from_currency, to_currency);

-- 6. Recreate balance_assertion with currency type/param
CREATE TABLE balance_assertion_new (
    id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL REFERENCES account(id),
    date TEXT NOT NULL,
    currency TEXT NOT NULL,
    currency_asset_type TEXT NOT NULL DEFAULT '',
    currency_param TEXT NOT NULL DEFAULT '',
    expected_balance TEXT NOT NULL,
    is_passing INTEGER NOT NULL DEFAULT 1,
    actual_balance TEXT,
    is_strict INTEGER NOT NULL DEFAULT 0,
    include_subaccounts INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (currency, currency_asset_type, currency_param) REFERENCES currency(code, asset_type, param)
);
INSERT INTO balance_assertion_new (id, account_id, date, currency, expected_balance, is_passing, actual_balance, is_strict, include_subaccounts)
    SELECT id, account_id, date, currency, expected_balance, is_passing, actual_balance, is_strict, include_subaccounts FROM balance_assertion;
DROP TABLE balance_assertion;
ALTER TABLE balance_assertion_new RENAME TO balance_assertion;
CREATE INDEX idx_balance_assertion_account ON balance_assertion(account_id);

-- 7. Recreate budget with currency type/param
CREATE TABLE budget_new (
    id TEXT PRIMARY KEY,
    account_pattern TEXT NOT NULL,
    period_type TEXT NOT NULL DEFAULT 'monthly',
    amount TEXT NOT NULL,
    currency TEXT NOT NULL,
    currency_asset_type TEXT NOT NULL DEFAULT '',
    currency_param TEXT NOT NULL DEFAULT '',
    start_date TEXT,
    end_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO budget_new (id, account_pattern, period_type, amount, currency, start_date, end_date, created_at)
    SELECT id, account_pattern, period_type, amount, currency, start_date, end_date, created_at FROM budget;
DROP TABLE budget;
ALTER TABLE budget_new RENAME TO budget;

-- 8. Recreate currency_rate_source with composite PK
CREATE TABLE currency_rate_source_new (
    currency TEXT NOT NULL,
    asset_type TEXT NOT NULL DEFAULT '',
    param TEXT NOT NULL DEFAULT '',
    rate_source TEXT NOT NULL,
    set_by TEXT NOT NULL DEFAULT 'auto',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (currency, asset_type, param)
);
INSERT INTO currency_rate_source_new (currency, rate_source, set_by, updated_at)
    SELECT currency, rate_source, set_by, updated_at FROM currency_rate_source;
DROP TABLE currency_rate_source;
ALTER TABLE currency_rate_source_new RENAME TO currency_rate_source;

-- 9. Recreate currency_token_address with composite PK
CREATE TABLE currency_token_address_new (
    currency TEXT NOT NULL,
    asset_type TEXT NOT NULL DEFAULT '',
    param TEXT NOT NULL DEFAULT '',
    chain TEXT NOT NULL,
    contract_address TEXT NOT NULL,
    PRIMARY KEY (currency, asset_type, param, chain)
);
INSERT INTO currency_token_address_new (currency, chain, contract_address)
    SELECT currency, chain, contract_address FROM currency_token_address;
DROP TABLE currency_token_address;
ALTER TABLE currency_token_address_new RENAME TO currency_token_address;

PRAGMA foreign_keys = ON;
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
