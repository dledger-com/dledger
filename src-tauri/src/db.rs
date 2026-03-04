use std::cell::RefCell;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};

use chrono::NaiveDate;
use rust_decimal::Decimal;
use rusqlite::{params, Connection};
use uuid::Uuid;

static SAVEPOINT_COUNTER: AtomicU64 = AtomicU64::new(0);

use dledger_core::models::*;
use dledger_core::schema::{MIGRATION_V2, MIGRATION_V3, MIGRATION_V4, MIGRATION_V5, MIGRATION_V6, MIGRATION_V7, MIGRATION_V8, MIGRATION_V9, MIGRATION_V10, MIGRATION_V11, MIGRATION_V12, MIGRATION_V13, MIGRATION_V14, MIGRATION_V15, MIGRATION_V16, MIGRATION_V17, MIGRATION_V18, SCHEMA_SQL, SCHEMA_VERSION};
use dledger_core::storage::*;

pub struct SqliteStorage {
    conn: RefCell<Connection>,
}

// SAFETY: SqliteStorage is only accessed from a single thread (Tauri main thread).
// The RefCell provides interior mutability for the rusqlite Connection which requires &mut self
// for transactions but our Storage trait uses &self.
unsafe impl Send for SqliteStorage {}
unsafe impl Sync for SqliteStorage {}

impl SqliteStorage {
    pub fn new(path: &str) -> StorageResult<Self> {
        let conn =
            Connection::open(path).map_err(|e| StorageError::Internal(e.to_string()))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(Self {
            conn: RefCell::new(conn),
        })
    }

    pub fn new_in_memory() -> StorageResult<Self> {
        let conn =
            Connection::open_in_memory().map_err(|e| StorageError::Internal(e.to_string()))?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(Self {
            conn: RefCell::new(conn),
        })
    }

    /// Insert closure table entries for a new account.
    fn insert_closure_entries(&self, account_id: &Uuid, parent_id: Option<&Uuid>) -> StorageResult<()> {
        let conn = self.conn.borrow();
        // Self-referencing entry
        conn.execute(
            "INSERT INTO account_closure (ancestor_id, descendant_id, depth) VALUES (?1, ?2, 0)",
            params![account_id.to_string(), account_id.to_string()],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;

        if let Some(pid) = parent_id {
            // Copy all ancestor relationships from parent to this new account, incrementing depth
            conn.execute(
                "INSERT INTO account_closure (ancestor_id, descendant_id, depth)
                 SELECT ancestor_id, ?1, depth + 1
                 FROM account_closure
                 WHERE descendant_id = ?2",
                params![account_id.to_string(), pid.to_string()],
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        }
        Ok(())
    }
}

fn parse_uuid(s: &str) -> StorageResult<Uuid> {
    Uuid::parse_str(s).map_err(|e| StorageError::Internal(format!("invalid UUID: {e}")))
}

fn parse_decimal(s: &str) -> StorageResult<Decimal> {
    Decimal::from_str(s).map_err(|e| StorageError::Internal(format!("invalid decimal: {e}")))
}

fn parse_date(s: &str) -> StorageResult<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map_err(|e| StorageError::Internal(format!("invalid date: {e}")))
}

fn parse_account_type(s: &str) -> StorageResult<AccountType> {
    AccountType::from_str(s)
        .ok_or_else(|| StorageError::Internal(format!("invalid account type: {s}")))
}

fn parse_entry_status(s: &str) -> StorageResult<JournalEntryStatus> {
    JournalEntryStatus::from_str(s)
        .ok_or_else(|| StorageError::Internal(format!("invalid entry status: {s}")))
}

/// Source priority: manual (3) > ledger-file/transaction (2) > API (1).
fn source_priority(source: &str) -> u8 {
    match source {
        "manual" => 3,
        "ledger-file" | "transaction" => 2,
        _ => 1,
    }
}

/// Rate source set_by priority: "user" (3) > "handler:*" (2) > "auto" (1).
fn set_by_priority(set_by: &str) -> u8 {
    if set_by == "user" {
        3
    } else if set_by.starts_with("handler:") {
        2
    } else {
        1
    }
}

impl Storage for SqliteStorage {
    // -- Currency --

    fn create_currency(&self, currency: &Currency) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO currency (code, asset_type, param, name, decimal_places, is_base) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                currency.code,
                currency.asset_type,
                currency.param,
                currency.name,
                currency.decimal_places,
                currency.is_base as i32,
            ],
        )
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                StorageError::Duplicate(format!("currency {}", currency.code))
            } else {
                StorageError::Internal(e.to_string())
            }
        })?;
        Ok(())
    }

    fn get_currency(&self, code: &str) -> StorageResult<Option<Currency>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare("SELECT code, asset_type, param, name, decimal_places, is_base FROM currency WHERE code = ?1")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let result = stmt
            .query_row(params![code], |row| {
                Ok(Currency {
                    code: row.get(0)?,
                    asset_type: row.get(1)?,
                    param: row.get(2)?,
                    name: row.get(3)?,
                    decimal_places: row.get::<_, u8>(4)?,
                    is_base: row.get::<_, i32>(5)? != 0,
                })
            })
            .optional()
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(result)
    }

    fn list_currencies(&self) -> StorageResult<Vec<Currency>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare("SELECT code, asset_type, param, name, decimal_places, is_base FROM currency ORDER BY code")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Currency {
                    code: row.get(0)?,
                    asset_type: row.get(1)?,
                    param: row.get(2)?,
                    name: row.get(3)?,
                    decimal_places: row.get::<_, u8>(4)?,
                    is_base: row.get::<_, i32>(5)? != 0,
                })
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| StorageError::Internal(e.to_string()))
    }

    fn set_currency_asset_type(&self, code: &str, asset_type: &str, param: &str) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "UPDATE currency SET asset_type = ? WHERE code = ? AND asset_type = '' AND param = ?",
            rusqlite::params![asset_type, code, param],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    // -- Accounts --

    fn create_account(&self, account: &Account) -> StorageResult<()> {
        let allowed_json =
            serde_json::to_string(&account.allowed_currencies).unwrap_or_else(|_| "[]".to_string());
        {
            let conn = self.conn.borrow();
            conn.execute(
                "INSERT INTO account (id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at, opened_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    account.id.to_string(),
                    account.parent_id.map(|id| id.to_string()),
                    account.account_type.as_str(),
                    account.name,
                    account.full_name,
                    allowed_json,
                    account.is_postable as i32,
                    account.is_archived as i32,
                    account.created_at.format("%Y-%m-%d").to_string(),
                    account.opened_at.map(|d| d.format("%Y-%m-%d").to_string()),
                ],
            )
            .map_err(|e| {
                if e.to_string().contains("UNIQUE") {
                    StorageError::Duplicate(format!("account {}", account.full_name))
                } else {
                    StorageError::Internal(e.to_string())
                }
            })?;
        }
        self.insert_closure_entries(&account.id, account.parent_id.as_ref())?;
        Ok(())
    }

    fn get_account(&self, id: &Uuid) -> StorageResult<Option<Account>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare(
                "SELECT id, parent_id, account_type, name, full_name, allowed_currencies,
                        is_postable, is_archived, created_at, opened_at
                 FROM account WHERE id = ?1",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let result = stmt
            .query_row(params![id.to_string()], |row| {
                Ok(row_to_account(row))
            })
            .optional()
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        match result {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    fn get_account_by_full_name(&self, full_name: &str) -> StorageResult<Option<Account>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare(
                "SELECT id, parent_id, account_type, name, full_name, allowed_currencies,
                        is_postable, is_archived, created_at, opened_at
                 FROM account WHERE full_name = ?1",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let result = stmt
            .query_row(params![full_name], |row| Ok(row_to_account(row)))
            .optional()
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        match result {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    fn list_accounts(&self) -> StorageResult<Vec<Account>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare(
                "SELECT id, parent_id, account_type, name, full_name, allowed_currencies,
                        is_postable, is_archived, created_at, opened_at
                 FROM account ORDER BY full_name",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| Ok(row_to_account(row)))
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.map(|r| r.map_err(|e| StorageError::Internal(e.to_string()))?)
            .collect()
    }

    fn update_account_archived(&self, id: &Uuid, is_archived: bool) -> StorageResult<()> {
        let conn = self.conn.borrow();
        let affected = conn
            .execute(
                "UPDATE account SET is_archived = ?1 WHERE id = ?2",
                params![is_archived as i32, id.to_string()],
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        if affected == 0 {
            return Err(StorageError::NotFound(format!("account {id}")));
        }
        Ok(())
    }

    fn update_account_opened_at(&self, id: &Uuid, opened_at: Option<NaiveDate>) -> StorageResult<()> {
        let conn = self.conn.borrow();
        let affected = conn
            .execute(
                "UPDATE account SET opened_at = ?1 WHERE id = ?2",
                params![
                    opened_at.map(|d| d.format("%Y-%m-%d").to_string()),
                    id.to_string()
                ],
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        if affected == 0 {
            return Err(StorageError::NotFound(format!("account {id}")));
        }
        Ok(())
    }

    fn get_account_subtree_ids(&self, id: &Uuid) -> StorageResult<Vec<Uuid>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare(
                "SELECT descendant_id FROM account_closure WHERE ancestor_id = ?1 ORDER BY depth",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map(params![id.to_string()], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.map(|r| {
            let s = r.map_err(|e| StorageError::Internal(e.to_string()))?;
            parse_uuid(&s)
        })
        .collect()
    }

    // -- Journal entries + line items --

    fn insert_journal_entry(
        &self,
        entry: &JournalEntry,
        items: &[LineItem],
    ) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO journal_entry (id, date, description, status, source, voided_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                entry.id.to_string(),
                entry.date.format("%Y-%m-%d").to_string(),
                entry.description,
                entry.status.as_str(),
                entry.source,
                entry.voided_by.map(|id| id.to_string()),
                entry.created_at.format("%Y-%m-%d").to_string(),
            ],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;

        for item in items {
            conn.execute(
                "INSERT INTO line_item (id, journal_entry_id, account_id, currency, currency_asset_type, currency_param, amount, lot_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    item.id.to_string(),
                    item.journal_entry_id.to_string(),
                    item.account_id.to_string(),
                    item.currency,
                    item.currency_asset_type,
                    item.currency_param,
                    item.amount.to_string(),
                    item.lot_id.map(|id| id.to_string()),
                ],
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        }
        Ok(())
    }

    fn get_journal_entry(
        &self,
        id: &Uuid,
    ) -> StorageResult<Option<(JournalEntry, Vec<LineItem>)>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare(
                "SELECT id, date, description, status, source, voided_by, created_at
                 FROM journal_entry WHERE id = ?1",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let entry_opt = stmt
            .query_row(params![id.to_string()], |row| Ok(row_to_journal_entry(row)))
            .optional()
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let entry = match entry_opt {
            Some(r) => r?,
            None => return Ok(None),
        };

        let items = fetch_line_items_for_entry(&conn, &entry.id)?;
        Ok(Some((entry, items)))
    }

    fn query_journal_entries(
        &self,
        filter: &TransactionFilter,
    ) -> StorageResult<Vec<(JournalEntry, Vec<LineItem>)>> {
        let conn = self.conn.borrow();
        let mut sql = String::from(
            "SELECT DISTINCT je.id, je.date, je.description, je.status, je.source, je.voided_by, je.created_at
             FROM journal_entry je",
        );
        let mut conditions: Vec<String> = Vec::new();
        let mut param_values: Vec<String> = Vec::new();

        // account_ids takes precedence over account_id when both set
        // Use account_closure to include sub-account transactions
        if filter.account_ids.as_ref().map_or(false, |ids| !ids.is_empty()) {
            sql.push_str(" JOIN line_item li ON li.journal_entry_id = je.id");
            let ids = filter.account_ids.as_ref().unwrap();
            let placeholders: Vec<String> = ids.iter().map(|id| {
                param_values.push(id.to_string());
                format!("?{}", param_values.len())
            }).collect();
            conditions.push(format!("li.account_id IN (SELECT descendant_id FROM account_closure WHERE ancestor_id IN ({}))", placeholders.join(", ")));
        } else if filter.account_id.is_some() {
            sql.push_str(" JOIN line_item li ON li.journal_entry_id = je.id");
            let account_id = filter.account_id.as_ref().unwrap();
            param_values.push(account_id.to_string());
            conditions.push(format!("li.account_id IN (SELECT descendant_id FROM account_closure WHERE ancestor_id = ?{})", param_values.len()));
        }

        if let Some(ref from_date) = filter.from_date {
            param_values.push(from_date.format("%Y-%m-%d").to_string());
            conditions.push(format!("je.date >= ?{}", param_values.len()));
        }
        if let Some(ref to_date) = filter.to_date {
            param_values.push(to_date.format("%Y-%m-%d").to_string());
            conditions.push(format!("je.date <= ?{}", param_values.len()));
        }
        if let Some(ref status) = filter.status {
            param_values.push(status.as_str().to_string());
            conditions.push(format!("je.status = ?{}", param_values.len()));
        }
        if let Some(ref source) = filter.source {
            param_values.push(source.clone());
            conditions.push(format!("je.source = ?{}", param_values.len()));
        }
        if let Some(ref search) = filter.description_search {
            param_values.push(format!("%{}%", search));
            conditions.push(format!("je.description LIKE ?{}", param_values.len()));
        }
        if let Some(ref tags) = filter.tag_filters {
            for tag in tags {
                param_values.push(format!("%,{},%", tag.to_lowercase()));
                conditions.push(format!(
                    "je.id IN (SELECT journal_entry_id FROM journal_entry_metadata WHERE key = 'tags' AND (',' || LOWER(value) || ',') LIKE ?{})",
                    param_values.len()
                ));
            }
        }
        if let Some(ref tags_or) = filter.tag_filters_or {
            if !tags_or.is_empty() {
                let or_parts: Vec<String> = tags_or.iter().map(|tag| {
                    param_values.push(format!("%,{},%", tag.to_lowercase()));
                    format!("(',' || LOWER(value) || ',') LIKE ?{}", param_values.len())
                }).collect();
                conditions.push(format!(
                    "je.id IN (SELECT journal_entry_id FROM journal_entry_metadata WHERE key = 'tags' AND ({}))",
                    or_parts.join(" OR ")
                ));
            }
        }
        if let Some(ref links) = filter.link_filters {
            for link in links {
                param_values.push(link.to_lowercase());
                conditions.push(format!(
                    "je.id IN (SELECT journal_entry_id FROM entry_link WHERE link_name = ?{})",
                    param_values.len()
                ));
            }
        }

        if !conditions.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&conditions.join(" AND "));
        }

        let order_clause = match (filter.order_by.as_deref(), filter.order_direction.as_deref()) {
            (Some(col), dir) => {
                let mapped = match col {
                    "date" => "je.date",
                    "description" => "je.description",
                    "status" => "je.status",
                    _ => "je.date",
                };
                let d = if dir == Some("asc") { "ASC" } else { "DESC" };
                format!(" ORDER BY {} {}, je.created_at {}", mapped, d, d)
            }
            _ => " ORDER BY je.date DESC, je.created_at DESC".to_string(),
        };
        sql.push_str(&order_clause);

        if let Some(limit) = filter.limit {
            param_values.push(limit.to_string());
            sql.push_str(&format!(" LIMIT ?{}", param_values.len()));
        }
        if let Some(offset) = filter.offset {
            param_values.push(offset.to_string());
            sql.push_str(&format!(" OFFSET ?{}", param_values.len()));
        }

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| StorageError::Internal(e.to_string()))?;

        let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_values
            .iter()
            .map(|s| s as &dyn rusqlite::types::ToSql)
            .collect();

        let rows = stmt
            .query_map(params_refs.as_slice(), |row| {
                Ok(row_to_journal_entry(row))
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;

        let entries: Vec<JournalEntry> = rows
            .map(|r| r.map_err(|e| StorageError::Internal(e.to_string()))?)
            .collect::<StorageResult<Vec<_>>>()?;

        let mut results = Vec::with_capacity(entries.len());
        for entry in entries {
            let items = fetch_line_items_for_entry(&conn, &entry.id)?;
            results.push((entry, items));
        }
        Ok(results)
    }

    fn update_journal_entry_status(
        &self,
        id: &Uuid,
        status: JournalEntryStatus,
        voided_by: Option<Uuid>,
    ) -> StorageResult<()> {
        let conn = self.conn.borrow();
        let affected = conn
            .execute(
                "UPDATE journal_entry SET status = ?1, voided_by = ?2 WHERE id = ?3",
                params![
                    status.as_str(),
                    voided_by.map(|id| id.to_string()),
                    id.to_string(),
                ],
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        if affected == 0 {
            return Err(StorageError::NotFound(format!("journal entry {id}")));
        }
        Ok(())
    }

    // -- Lots --

    fn insert_lot(&self, lot: &Lot) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO lot (id, account_id, currency, currency_asset_type, currency_param,
                              acquired_date, original_quantity,
                              remaining_quantity, cost_basis_per_unit, cost_basis_currency,
                              cost_basis_currency_asset_type, cost_basis_currency_param,
                              journal_entry_id, is_closed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                lot.id.to_string(),
                lot.account_id.to_string(),
                lot.currency,
                lot.currency_asset_type,
                lot.currency_param,
                lot.acquired_date.format("%Y-%m-%d").to_string(),
                lot.original_quantity.to_string(),
                lot.remaining_quantity.to_string(),
                lot.cost_basis_per_unit.to_string(),
                lot.cost_basis_currency,
                lot.cost_basis_currency_asset_type,
                lot.cost_basis_currency_param,
                lot.journal_entry_id.to_string(),
                lot.is_closed as i32,
            ],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn get_lot(&self, id: &Uuid) -> StorageResult<Option<Lot>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare(
                "SELECT id, account_id, currency, currency_asset_type, currency_param,
                        acquired_date, original_quantity,
                        remaining_quantity, cost_basis_per_unit, cost_basis_currency,
                        cost_basis_currency_asset_type, cost_basis_currency_param,
                        journal_entry_id, is_closed
                 FROM lot WHERE id = ?1",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let result = stmt
            .query_row(params![id.to_string()], |row| Ok(row_to_lot(row)))
            .optional()
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        match result {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    fn get_open_lots_fifo(
        &self,
        account_id: &Uuid,
        currency: &str,
    ) -> StorageResult<Vec<Lot>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare(
                "SELECT id, account_id, currency, currency_asset_type, currency_param,
                        acquired_date, original_quantity,
                        remaining_quantity, cost_basis_per_unit, cost_basis_currency,
                        cost_basis_currency_asset_type, cost_basis_currency_param,
                        journal_entry_id, is_closed
                 FROM lot
                 WHERE account_id = ?1 AND currency = ?2 AND is_closed = 0
                 ORDER BY acquired_date ASC",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map(params![account_id.to_string(), currency], |row| {
                Ok(row_to_lot(row))
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.map(|r| r.map_err(|e| StorageError::Internal(e.to_string()))?)
            .collect()
    }

    fn update_lot_remaining(
        &self,
        id: &Uuid,
        remaining: Decimal,
        is_closed: bool,
    ) -> StorageResult<()> {
        let conn = self.conn.borrow();
        let affected = conn
            .execute(
                "UPDATE lot SET remaining_quantity = ?1, is_closed = ?2 WHERE id = ?3",
                params![remaining.to_string(), is_closed as i32, id.to_string()],
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        if affected == 0 {
            return Err(StorageError::NotFound(format!("lot {id}")));
        }
        Ok(())
    }

    fn insert_lot_disposal(&self, disposal: &LotDisposal) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO lot_disposal (id, lot_id, journal_entry_id, quantity,
                                       proceeds_per_unit, proceeds_currency,
                                       proceeds_currency_asset_type, proceeds_currency_param,
                                       realized_gain_loss, disposal_date)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                disposal.id.to_string(),
                disposal.lot_id.to_string(),
                disposal.journal_entry_id.to_string(),
                disposal.quantity.to_string(),
                disposal.proceeds_per_unit.to_string(),
                disposal.proceeds_currency,
                disposal.proceeds_currency_asset_type,
                disposal.proceeds_currency_param,
                disposal.realized_gain_loss.to_string(),
                disposal.disposal_date.format("%Y-%m-%d").to_string(),
            ],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn get_lot_disposals_for_period(
        &self,
        from_date: NaiveDate,
        to_date: NaiveDate,
    ) -> StorageResult<Vec<LotDisposal>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare(
                "SELECT id, lot_id, journal_entry_id, quantity,
                        proceeds_per_unit, proceeds_currency,
                        proceeds_currency_asset_type, proceeds_currency_param,
                        realized_gain_loss, disposal_date
                 FROM lot_disposal
                 WHERE disposal_date >= ?1 AND disposal_date <= ?2
                 ORDER BY disposal_date ASC",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map(
                params![
                    from_date.format("%Y-%m-%d").to_string(),
                    to_date.format("%Y-%m-%d").to_string(),
                ],
                |row| Ok(row_to_lot_disposal(row)),
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.map(|r| r.map_err(|e| StorageError::Internal(e.to_string()))?)
            .collect()
    }

    // -- Exchange rates --

    fn insert_exchange_rate(&self, rate: &ExchangeRate) -> StorageResult<()> {
        let conn = self.conn.borrow();
        let date_str = rate.date.format("%Y-%m-%d").to_string();

        // Check existing source priority before overwriting
        let existing_source: Option<String> = conn
            .prepare(
                "SELECT source FROM exchange_rate WHERE date = ?1 AND from_currency = ?2 AND to_currency = ?3",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?
            .query_row(
                params![date_str, rate.from_currency, rate.to_currency],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| StorageError::Internal(e.to_string()))?;

        if let Some(ref existing) = existing_source {
            if source_priority(existing) > source_priority(&rate.source) {
                return Ok(()); // Don't overwrite higher-priority source
            }
        }

        conn.execute(
            "DELETE FROM exchange_rate WHERE date = ?1 AND from_currency = ?2 AND to_currency = ?3",
            params![date_str, rate.from_currency, rate.to_currency],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        conn.execute(
            "INSERT INTO exchange_rate (id, date, from_currency, from_currency_asset_type, from_currency_param,
                                        to_currency, to_currency_asset_type, to_currency_param, rate, source)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                rate.id.to_string(),
                date_str,
                rate.from_currency,
                rate.from_currency_asset_type,
                rate.from_currency_param,
                rate.to_currency,
                rate.to_currency_asset_type,
                rate.to_currency_param,
                rate.rate.to_string(),
                rate.source,
            ],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn get_exchange_rate(
        &self,
        from: &str,
        to: &str,
        date: NaiveDate,
    ) -> StorageResult<Option<Decimal>> {
        let conn = self.conn.borrow();
        let date_str = date.format("%Y-%m-%d").to_string();

        // Direct lookup
        let mut stmt = conn
            .prepare(
                "SELECT rate FROM exchange_rate
                 WHERE from_currency = ?1 AND to_currency = ?2 AND date <= ?3
                 ORDER BY date DESC LIMIT 1",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let result = stmt
            .query_row(params![from, to, &date_str], |row| row.get::<_, String>(0))
            .optional()
            .map_err(|e| StorageError::Internal(e.to_string()))?;

        if let Some(s) = result {
            return Ok(Some(parse_decimal(&s)?));
        }

        // Inverse fallback: look for to→from and invert
        let mut inv_stmt = conn
            .prepare(
                "SELECT rate FROM exchange_rate
                 WHERE from_currency = ?1 AND to_currency = ?2 AND date <= ?3
                 ORDER BY date DESC LIMIT 1",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let inv_result = inv_stmt
            .query_row(params![to, from, &date_str], |row| row.get::<_, String>(0))
            .optional()
            .map_err(|e| StorageError::Internal(e.to_string()))?;

        if let Some(s) = inv_result {
            let rate = parse_decimal(&s)?;
            if rate.is_zero() {
                return Ok(None);
            }
            return Ok(Some(Decimal::ONE / rate));
        }

        // Transitive fallback: A→X→B via single intermediate
        // Both legs use "on or before" matching within a 7-day staleness window
        const TRANSITIVE_MAX_STALENESS_DAYS: i64 = 7;
        let window_start = date - chrono::Duration::days(TRANSITIVE_MAX_STALENESS_DAYS);
        let window_start_str = window_start.format("%Y-%m-%d").to_string();

        // Collect latest first-leg rate per intermediate currency (deduplicated)
        let mut from_legs: std::collections::HashMap<String, (Decimal, String)> =
            std::collections::HashMap::new();

        // Direct: from→X (latest within window)
        {
            let mut stmt = conn
                .prepare(
                    "SELECT to_currency, rate, date FROM exchange_rate
                     WHERE from_currency = ?1 AND date <= ?2 AND date >= ?3
                     ORDER BY date DESC",
                )
                .map_err(|e| StorageError::Internal(e.to_string()))?;
            let rows = stmt
                .query_map(params![from, &date_str, &window_start_str], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|e| StorageError::Internal(e.to_string()))?;
            for row in rows {
                let (currency, rate_str, d) =
                    row.map_err(|e| StorageError::Internal(e.to_string()))?;
                let rate = parse_decimal(&rate_str)?;
                from_legs.entry(currency).or_insert((rate, d));
            }
        }

        // Inverse: X→from (so from→X = 1/rate), latest within window
        {
            let mut stmt = conn
                .prepare(
                    "SELECT from_currency, rate, date FROM exchange_rate
                     WHERE to_currency = ?1 AND date <= ?2 AND date >= ?3
                     ORDER BY date DESC",
                )
                .map_err(|e| StorageError::Internal(e.to_string()))?;
            let rows = stmt
                .query_map(params![from, &date_str, &window_start_str], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|e| StorageError::Internal(e.to_string()))?;
            for row in rows {
                let (currency, rate_str, d) =
                    row.map_err(|e| StorageError::Internal(e.to_string()))?;
                let rate = parse_decimal(&rate_str)?;
                if rate.is_zero() {
                    continue;
                }
                from_legs.entry(currency).or_insert((Decimal::ONE / rate, d));
            }
        }

        // For each intermediate X, find latest X→to (or to→X) within staleness window
        for (_x, (leg_rate, _leg_date)) in &from_legs {
            // Direct: X→to
            let mut stmt = conn
                .prepare(
                    "SELECT rate FROM exchange_rate
                     WHERE from_currency = ?1 AND to_currency = ?2 AND date <= ?3 AND date >= ?4
                     ORDER BY date DESC LIMIT 1",
                )
                .map_err(|e| StorageError::Internal(e.to_string()))?;
            let x_to_direct = stmt
                .query_row(params![_x, to, &date_str, &window_start_str], |row| {
                    row.get::<_, String>(0)
                })
                .optional()
                .map_err(|e| StorageError::Internal(e.to_string()))?;

            if let Some(s) = x_to_direct {
                let second_rate = parse_decimal(&s)?;
                return Ok(Some(*leg_rate * second_rate));
            }

            // Inverse: to→X (so X→to = 1/rate)
            let mut inv_stmt = conn
                .prepare(
                    "SELECT rate FROM exchange_rate
                     WHERE from_currency = ?1 AND to_currency = ?2 AND date <= ?3 AND date >= ?4
                     ORDER BY date DESC LIMIT 1",
                )
                .map_err(|e| StorageError::Internal(e.to_string()))?;
            let x_to_inverse = inv_stmt
                .query_row(params![to, _x, &date_str, &window_start_str], |row| {
                    row.get::<_, String>(0)
                })
                .optional()
                .map_err(|e| StorageError::Internal(e.to_string()))?;

            if let Some(s) = x_to_inverse {
                let inv_rate = parse_decimal(&s)?;
                if !inv_rate.is_zero() {
                    return Ok(Some(*leg_rate * (Decimal::ONE / inv_rate)));
                }
            }
        }

        Ok(None)
    }

    fn get_exchange_rate_source(
        &self,
        from: &str,
        to: &str,
        date: NaiveDate,
    ) -> StorageResult<Option<String>> {
        let conn = self.conn.borrow();
        let date_str = date.format("%Y-%m-%d").to_string();
        let result = conn
            .prepare(
                "SELECT source FROM exchange_rate WHERE date = ?1 AND from_currency = ?2 AND to_currency = ?3",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?
            .query_row(params![date_str, from, to], |row| row.get::<_, String>(0))
            .optional()
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(result)
    }

    fn list_exchange_rates(
        &self,
        from: Option<&str>,
        to: Option<&str>,
    ) -> StorageResult<Vec<ExchangeRate>> {
        let conn = self.conn.borrow();
        let mut sql = String::from(
            "SELECT id, date, from_currency, from_currency_asset_type, from_currency_param, to_currency, to_currency_asset_type, to_currency_param, rate, source FROM exchange_rate",
        );
        let mut conditions: Vec<String> = Vec::new();
        let mut param_values: Vec<String> = Vec::new();

        if let Some(f) = from {
            param_values.push(f.to_string());
            conditions.push(format!("from_currency = ?{}", param_values.len()));
        }
        if let Some(t) = to {
            param_values.push(t.to_string());
            conditions.push(format!("to_currency = ?{}", param_values.len()));
        }
        if !conditions.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&conditions.join(" AND "));
        }
        sql.push_str(" ORDER BY date DESC");

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| StorageError::Internal(e.to_string()))?;

        let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_values
            .iter()
            .map(|s| s as &dyn rusqlite::types::ToSql)
            .collect();

        let rows = stmt
            .query_map(params_refs.as_slice(), |row| Ok(row_to_exchange_rate(row)))
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.map(|r| r.map_err(|e| StorageError::Internal(e.to_string()))?)
            .collect()
    }

    fn get_exchange_rate_currencies_on_date(
        &self,
        date: NaiveDate,
    ) -> StorageResult<Vec<String>> {
        let conn = self.conn.borrow();
        let date_str = date.format("%Y-%m-%d").to_string();
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT from_currency FROM exchange_rate WHERE date = ?1",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map(params![&date_str], |row| row.get::<_, String>(0))
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| StorageError::Internal(e.to_string()))?);
        }
        Ok(result)
    }

    // -- Balances --

    fn sum_line_items(
        &self,
        account_ids: &[Uuid],
        before_date: Option<NaiveDate>,
    ) -> StorageResult<Vec<CurrencyBalance>> {
        if account_ids.is_empty() {
            return Ok(Vec::new());
        }

        let placeholders: Vec<String> = (1..=account_ids.len())
            .map(|i| format!("?{i}"))
            .collect();

        // Fetch raw amounts and sum with Decimal in Rust for precision
        // Note: voided entries are NOT excluded - the reversing entry handles the correction
        let mut sql = format!(
            "SELECT li.currency, li.amount
             FROM line_item li
             JOIN journal_entry je ON je.id = li.journal_entry_id
             WHERE li.account_id IN ({})",
            placeholders.join(", ")
        );

        let mut param_values: Vec<String> = account_ids
            .iter()
            .map(|id| id.to_string())
            .collect();

        if let Some(ref date) = before_date {
            param_values.push(date.format("%Y-%m-%d").to_string());
            sql.push_str(&format!(" AND je.date < ?{}", param_values.len()));
        }

        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| StorageError::Internal(e.to_string()))?;

        let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_values
            .iter()
            .map(|s| s as &dyn rusqlite::types::ToSql)
            .collect();

        let mut totals: std::collections::HashMap<String, Decimal> =
            std::collections::HashMap::new();

        let rows = stmt
            .query_map(params_refs.as_slice(), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;

        for row in rows {
            let (currency, amount_str) =
                row.map_err(|e| StorageError::Internal(e.to_string()))?;
            let amount = parse_decimal(&amount_str)?;
            *totals.entry(currency).or_default() += amount;
        }

        let mut balances: Vec<CurrencyBalance> = totals
            .into_iter()
            .map(|(currency, amount)| CurrencyBalance { currency, amount })
            .collect();
        balances.sort_by(|a, b| a.currency.cmp(&b.currency));
        Ok(balances)
    }

    // -- Balance assertions --

    fn insert_balance_assertion(&self, assertion: &BalanceAssertion) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO balance_assertion (id, account_id, date, currency, currency_asset_type, currency_param, expected_balance, is_passing, actual_balance, is_strict, include_subaccounts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                assertion.id.to_string(),
                assertion.account_id.to_string(),
                assertion.date.format("%Y-%m-%d").to_string(),
                assertion.currency,
                assertion.currency_asset_type,
                assertion.currency_param,
                assertion.expected_balance.to_string(),
                assertion.is_passing as i32,
                assertion.actual_balance.map(|d| d.to_string()),
                assertion.is_strict as i32,
                assertion.include_subaccounts as i32,
            ],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn update_balance_assertion_result(
        &self,
        id: &Uuid,
        is_passing: bool,
        actual_balance: Decimal,
    ) -> StorageResult<()> {
        let conn = self.conn.borrow();
        let affected = conn
            .execute(
                "UPDATE balance_assertion SET is_passing = ?1, actual_balance = ?2 WHERE id = ?3",
                params![
                    is_passing as i32,
                    actual_balance.to_string(),
                    id.to_string(),
                ],
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        if affected == 0 {
            return Err(StorageError::NotFound(format!("balance assertion {id}")));
        }
        Ok(())
    }

    fn get_balance_assertions(
        &self,
        account_id: Option<&Uuid>,
    ) -> StorageResult<Vec<BalanceAssertion>> {
        let conn = self.conn.borrow();
        let (sql, param_val) = match account_id {
            Some(id) => (
                "SELECT id, account_id, date, currency, currency_asset_type, currency_param, expected_balance, is_passing, actual_balance, is_strict, include_subaccounts
                 FROM balance_assertion WHERE account_id = ?1 ORDER BY date",
                Some(id.to_string()),
            ),
            None => (
                "SELECT id, account_id, date, currency, currency_asset_type, currency_param, expected_balance, is_passing, actual_balance, is_strict, include_subaccounts
                 FROM balance_assertion ORDER BY date",
                None,
            ),
        };
        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| StorageError::Internal(e.to_string()))?;

        let mut results = Vec::new();
        if let Some(ref pv) = param_val {
            let rows = stmt
                .query_map(params![pv], |row| Ok(row_to_balance_assertion(row)))
                .map_err(|e| StorageError::Internal(e.to_string()))?;
            for row in rows {
                results.push(row.map_err(|e| StorageError::Internal(e.to_string()))??);
            }
        } else {
            let rows = stmt
                .query_map([], |row| Ok(row_to_balance_assertion(row)))
                .map_err(|e| StorageError::Internal(e.to_string()))?;
            for row in rows {
                results.push(row.map_err(|e| StorageError::Internal(e.to_string()))??);
            }
        };
        Ok(results)
    }

    // -- Metadata --

    fn insert_metadata(
        &self,
        journal_entry_id: &Uuid,
        key: &str,
        value: &str,
    ) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO journal_entry_metadata (journal_entry_id, key, value) VALUES (?1, ?2, ?3)",
            params![journal_entry_id.to_string(), key, value],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn get_metadata(&self, journal_entry_id: &Uuid) -> StorageResult<Vec<Metadata>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare(
                "SELECT journal_entry_id, key, value FROM journal_entry_metadata
                 WHERE journal_entry_id = ?1 ORDER BY key",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map(params![journal_entry_id.to_string()], |row| {
                Ok(row_to_metadata(row))
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.map(|r| r.map_err(|e| StorageError::Internal(e.to_string()))?)
            .collect()
    }

    fn query_entries_by_metadata(&self, key: &str, value: &str) -> StorageResult<Vec<Uuid>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT m.journal_entry_id
                 FROM journal_entry_metadata m
                 JOIN journal_entry je ON je.id = m.journal_entry_id
                 WHERE m.key = ?1 AND m.value = ?2 AND je.status != 'voided'
                 ORDER BY je.date DESC",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map(params![key, value], |row| {
                let id_str: String = row.get(0)?;
                Ok(id_str)
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.map(|r| {
            let id_str = r.map_err(|e| StorageError::Internal(e.to_string()))?;
            parse_uuid(&id_str)
        })
        .collect()
    }

    // -- Entry links --

    fn set_entry_links(&self, entry_id: &Uuid, links: &[String]) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "DELETE FROM entry_link WHERE journal_entry_id = ?1",
            params![entry_id.to_string()],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        let mut stmt = conn
            .prepare("INSERT INTO entry_link (journal_entry_id, link_name) VALUES (?1, ?2)")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        for link in links {
            let normalized = link.trim().to_lowercase();
            if !normalized.is_empty() {
                stmt.execute(params![entry_id.to_string(), normalized])
                    .map_err(|e| StorageError::Internal(e.to_string()))?;
            }
        }
        Ok(())
    }

    fn get_entry_links(&self, entry_id: &Uuid) -> StorageResult<Vec<String>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare(
                "SELECT link_name FROM entry_link WHERE journal_entry_id = ?1 ORDER BY link_name",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map(params![entry_id.to_string()], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| StorageError::Internal(e.to_string()))?);
        }
        Ok(result)
    }

    fn get_entries_by_link(&self, link_name: &str) -> StorageResult<Vec<Uuid>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare(
                "SELECT el.journal_entry_id FROM entry_link el
                 JOIN journal_entry je ON je.id = el.journal_entry_id
                 WHERE el.link_name = ?1 AND je.status != 'voided'
                 ORDER BY je.date DESC",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map(params![link_name], |row| row.get::<_, String>(0))
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let mut result = Vec::new();
        for row in rows {
            let id_str = row.map_err(|e| StorageError::Internal(e.to_string()))?;
            result.push(parse_uuid(&id_str)?);
        }
        Ok(result)
    }

    fn get_all_link_names(&self) -> StorageResult<Vec<String>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare("SELECT DISTINCT link_name FROM entry_link ORDER BY link_name")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| StorageError::Internal(e.to_string()))?);
        }
        Ok(result)
    }

    fn get_all_links_with_counts(&self) -> StorageResult<Vec<(String, u64)>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare(
                "SELECT el.link_name, COUNT(DISTINCT el.journal_entry_id) as cnt
                 FROM entry_link el
                 JOIN journal_entry je ON je.id = el.journal_entry_id
                 WHERE je.status != 'voided'
                 GROUP BY el.link_name
                 ORDER BY el.link_name",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| StorageError::Internal(e.to_string()))?);
        }
        Ok(result)
    }

    fn list_all_open_lots(&self) -> StorageResult<Vec<Lot>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare(
                "SELECT id, account_id, currency, currency_asset_type, currency_param,
                        acquired_date, original_quantity,
                        remaining_quantity, cost_basis_per_unit, cost_basis_currency,
                        cost_basis_currency_asset_type, cost_basis_currency_param,
                        journal_entry_id, is_closed
                 FROM lot
                 WHERE is_closed = 0 AND CAST(remaining_quantity AS REAL) > 0
                 ORDER BY currency, acquired_date",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| Ok(row_to_lot(row)))
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.map(|r| r.map_err(|e| StorageError::Internal(e.to_string()))?)
            .collect()
    }

    // -- Raw transactions --

    fn store_raw_transaction(&self, source: &str, data: &str) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT OR REPLACE INTO raw_transaction (source, data) VALUES (?1, ?2)",
            params![source, data],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn get_raw_transaction(&self, source: &str) -> StorageResult<Option<String>> {
        let conn = self.conn.borrow();
        let result = conn
            .prepare("SELECT data FROM raw_transaction WHERE source = ?1")
            .map_err(|e| StorageError::Internal(e.to_string()))?
            .query_row(params![source], |row| row.get::<_, String>(0))
            .optional()
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(result)
    }

    fn query_raw_transactions(&self, source_prefix: &str) -> StorageResult<Vec<(String, String)>> {
        let conn = self.conn.borrow();
        let pattern = format!("{}%", source_prefix);
        let mut stmt = conn
            .prepare("SELECT source, data FROM raw_transaction WHERE source LIKE ?1 ORDER BY source")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map(params![pattern], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| StorageError::Internal(e.to_string()))
    }

    // -- Audit --

    fn insert_audit_log(&self, entry: &AuditLogEntry) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO audit_log (id, timestamp, action, entity_type, entity_id, details)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                entry.id.to_string(),
                entry.timestamp.format("%Y-%m-%d").to_string(),
                entry.action,
                entry.entity_type,
                entry.entity_id.to_string(),
                entry.details,
            ],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    // -- Hidden currencies --

    fn set_currency_hidden(&self, code: &str, is_hidden: bool) -> StorageResult<()> {
        let conn = self.conn.borrow();
        let affected = conn
            .execute(
                "UPDATE currency SET is_hidden = ?1 WHERE code = ?2",
                params![is_hidden as i32, code],
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        if affected == 0 {
            return Err(StorageError::NotFound(format!("currency {code}")));
        }
        Ok(())
    }

    fn list_hidden_currencies(&self) -> StorageResult<Vec<String>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare("SELECT code FROM currency WHERE is_hidden = 1")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| StorageError::Internal(e.to_string()))
    }

    // -- Currency rate sources --

    fn get_currency_rate_sources(&self) -> StorageResult<Vec<CurrencyRateSource>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare("SELECT currency, asset_type, param, rate_source, set_by FROM currency_rate_source")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(CurrencyRateSource {
                    currency: row.get(0)?,
                    asset_type: row.get(1)?,
                    param: row.get(2)?,
                    rate_source: row.get(3)?,
                    set_by: row.get(4)?,
                })
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| StorageError::Internal(e.to_string()))
    }

    fn set_currency_rate_source(&self, currency: &str, rate_source: &str, set_by: &str) -> StorageResult<()> {
        let conn = self.conn.borrow();
        let priority = set_by_priority(set_by) as i32;
        conn.execute(
            "INSERT INTO currency_rate_source (currency, asset_type, param, rate_source, set_by, updated_at)
             VALUES (?1, '', '', ?2, ?3, datetime('now'))
             ON CONFLICT(currency, asset_type, param) DO UPDATE SET
               rate_source = CASE WHEN ?4 >= (CASE WHEN set_by = 'user' THEN 3 WHEN set_by LIKE 'handler:%' THEN 2 ELSE 1 END) THEN ?2 ELSE rate_source END,
               set_by = CASE WHEN ?4 >= (CASE WHEN set_by = 'user' THEN 3 WHEN set_by LIKE 'handler:%' THEN 2 ELSE 1 END) THEN ?3 ELSE set_by END,
               updated_at = CASE WHEN ?4 >= (CASE WHEN set_by = 'user' THEN 3 WHEN set_by LIKE 'handler:%' THEN 2 ELSE 1 END) THEN datetime('now') ELSE updated_at END",
            params![currency, rate_source, set_by, priority],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn clear_auto_rate_sources(&self) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute("DELETE FROM currency_rate_source WHERE set_by = 'auto'", [])
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn clear_non_user_rate_sources(&self) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute("DELETE FROM currency_rate_source WHERE set_by != 'user'", [])
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    // -- Integrity checks --

    fn count_orphaned_line_items(&self) -> StorageResult<u64> {
        let conn = self.conn.borrow();
        let count: u64 = conn
            .query_row(
                "SELECT COUNT(*) FROM line_item WHERE journal_entry_id NOT IN (SELECT id FROM journal_entry)",
                [],
                |row| row.get(0),
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(count)
    }

    fn count_duplicate_sources(&self) -> StorageResult<u64> {
        let conn = self.conn.borrow();
        let count: u64 = conn
            .query_row(
                "SELECT COUNT(*) FROM (SELECT source, COUNT(*) as cnt FROM journal_entry WHERE source IS NOT NULL AND source != '' AND status = 'posted' GROUP BY source HAVING cnt > 1)",
                [],
                |row| row.get(0),
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(count)
    }

    // -- Currency origins --

    fn get_currency_origins(&self) -> StorageResult<Vec<CurrencyOrigin>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT li.currency,
                   CASE
                     WHEN je.source LIKE 'etherscan:%' THEN 'etherscan'
                     ELSE je.source
                   END AS origin
                 FROM line_item li
                 JOIN journal_entry je ON li.journal_entry_id = je.id
                 WHERE je.status != 'voided'",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let mut results = Vec::new();
        for row in rows {
            let (currency, origin) =
                row.map_err(|e| StorageError::Internal(e.to_string()))?;
            results.push(CurrencyOrigin { currency, origin });
        }
        Ok(results)
    }

    // -- Data management --

    fn clear_exchange_rates(&self) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute_batch("DELETE FROM exchange_rate")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn clear_ledger_data(&self) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute_batch(
            "PRAGMA foreign_keys=OFF;
             DELETE FROM reconciliation_line_item;
             DELETE FROM reconciliation;
             DELETE FROM lot_disposal;
             DELETE FROM lot;
             DELETE FROM line_item;
             DELETE FROM entry_link;
             DELETE FROM journal_entry_metadata;
             DELETE FROM balance_assertion;
             DELETE FROM audit_log;
             DELETE FROM journal_entry;
             DELETE FROM account_closure;
             DELETE FROM account;
             DELETE FROM currency;
             DELETE FROM currency_rate_source;
             DELETE FROM raw_transaction;
             DELETE FROM budget;
             DELETE FROM recurring_template;
             DELETE FROM currency_token_address;
             DELETE FROM account_metadata;
             UPDATE exchange_account SET last_sync = NULL;
             PRAGMA foreign_keys=ON;",
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn clear_all_data(&self) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute_batch(
            "DELETE FROM reconciliation_line_item;
             DELETE FROM reconciliation;
             DELETE FROM lot_disposal;
             DELETE FROM lot;
             DELETE FROM line_item;
             DELETE FROM entry_link;
             DELETE FROM journal_entry_metadata;
             DELETE FROM balance_assertion;
             DELETE FROM audit_log;
             DELETE FROM journal_entry;
             DELETE FROM exchange_rate;
             DELETE FROM account_closure;
             DELETE FROM account;
             DELETE FROM currency;
             DELETE FROM currency_rate_source;
             DELETE FROM raw_transaction;
             DELETE FROM budget;
             DELETE FROM recurring_template;
             DELETE FROM currency_token_address;
             DELETE FROM account_metadata;
             DELETE FROM exchange_account;",
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    // -- Transactions --

    fn in_transaction(
        &self,
        f: &mut dyn FnMut(&dyn Storage) -> StorageResult<()>,
    ) -> StorageResult<()> {
        // We need to use a savepoint for nesting support.
        // rusqlite's transaction/savepoint requires &mut Connection, but we only have &self.
        // We execute raw SQL for savepoint management and pass self as the storage.
        let id = SAVEPOINT_COUNTER.fetch_add(1, Ordering::Relaxed);
        let savepoint_name = format!("sp_{id}");
        {
            let conn = self.conn.borrow();
            conn.execute_batch(&format!("SAVEPOINT {savepoint_name}"))
                .map_err(|e| StorageError::Internal(e.to_string()))?;
        }

        match f(self) {
            Ok(()) => {
                let conn = self.conn.borrow();
                conn.execute_batch(&format!("RELEASE {savepoint_name}"))
                    .map_err(|e| StorageError::Internal(e.to_string()))?;
                Ok(())
            }
            Err(e) => {
                let conn = self.conn.borrow();
                // Best effort rollback; if it fails, return the original error
                let _ = conn.execute_batch(&format!("ROLLBACK TO {savepoint_name}"));
                let _ = conn.execute_batch(&format!("RELEASE {savepoint_name}"));
                Err(e)
            }
        }
    }

    // -- Budgets --

    fn create_budget(&self, budget: &Budget) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO budget (id, account_pattern, period_type, amount, currency, currency_asset_type, currency_param, start_date, end_date, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                budget.id.to_string(),
                budget.account_pattern,
                budget.period_type,
                budget.amount.to_string(),
                budget.currency,
                budget.currency_asset_type,
                budget.currency_param,
                budget.start_date.map(|d| d.format("%Y-%m-%d").to_string()),
                budget.end_date.map(|d| d.format("%Y-%m-%d").to_string()),
                budget.created_at.format("%Y-%m-%d").to_string(),
            ],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn list_budgets(&self) -> StorageResult<Vec<Budget>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare("SELECT id, account_pattern, period_type, amount, currency, currency_asset_type, currency_param, start_date, end_date, created_at FROM budget ORDER BY created_at")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(row_to_budget(row))
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.map(|r| r.map_err(|e| StorageError::Internal(e.to_string()))?)
            .collect()
    }

    fn update_budget(&self, budget: &Budget) -> StorageResult<()> {
        let conn = self.conn.borrow();
        let affected = conn
            .execute(
                "UPDATE budget SET account_pattern = ?2, period_type = ?3, amount = ?4, currency = ?5, currency_asset_type = ?6, currency_param = ?7, start_date = ?8, end_date = ?9 WHERE id = ?1",
                params![
                    budget.id.to_string(),
                    budget.account_pattern,
                    budget.period_type,
                    budget.amount.to_string(),
                    budget.currency,
                    budget.currency_asset_type,
                    budget.currency_param,
                    budget.start_date.map(|d| d.format("%Y-%m-%d").to_string()),
                    budget.end_date.map(|d| d.format("%Y-%m-%d").to_string()),
                ],
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        if affected == 0 {
            return Err(StorageError::NotFound(format!("budget {}", budget.id)));
        }
        Ok(())
    }

    fn delete_budget(&self, id: &Uuid) -> StorageResult<()> {
        let conn = self.conn.borrow();
        let affected = conn
            .execute("DELETE FROM budget WHERE id = ?1", params![id.to_string()])
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        if affected == 0 {
            return Err(StorageError::NotFound(format!("budget {id}")));
        }
        Ok(())
    }

    // -- Reconciliation --

    fn get_unreconciled_line_items(
        &self,
        account_id: &Uuid,
        currency: &str,
        up_to_date: Option<NaiveDate>,
    ) -> StorageResult<Vec<UnreconciledLineItem>> {
        let conn = self.conn.borrow();
        let date_clause = if up_to_date.is_some() {
            " AND je.date <= ?3"
        } else {
            ""
        };
        let sql = format!(
            "SELECT li.id, je.id, je.date, je.description, li.account_id, li.currency, li.amount, li.is_reconciled
             FROM line_item li
             JOIN journal_entry je ON je.id = li.journal_entry_id
             WHERE li.account_id = ?1 AND li.currency = ?2 AND je.status != 'voided' AND li.is_reconciled = 0{}
             ORDER BY je.date, je.id",
            date_clause
        );
        let mut stmt = conn.prepare(&sql)
            .map_err(|e| StorageError::Internal(e.to_string()))?;

        let account_id_str = account_id.to_string();
        let date_str = up_to_date.map(|d| d.format("%Y-%m-%d").to_string());

        let rows: Vec<UnreconciledLineItem> = if let Some(ref ds) = date_str {
            stmt.query_map(params![account_id_str, currency, ds], |row| {
                Ok(row_to_unreconciled_line_item(row))
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?
            .map(|r| r.map_err(|e| StorageError::Internal(e.to_string()))?)
            .collect::<StorageResult<Vec<_>>>()?
        } else {
            stmt.query_map(params![account_id_str, currency], |row| {
                Ok(row_to_unreconciled_line_item(row))
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?
            .map(|r| r.map_err(|e| StorageError::Internal(e.to_string()))?)
            .collect::<StorageResult<Vec<_>>>()?
        };
        Ok(rows)
    }

    fn mark_reconciled(
        &self,
        reconciliation: &Reconciliation,
        line_item_ids: &[Uuid],
    ) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO reconciliation (id, account_id, statement_date, statement_balance, currency, reconciled_at, line_item_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                reconciliation.id.to_string(),
                reconciliation.account_id.to_string(),
                reconciliation.statement_date.format("%Y-%m-%d").to_string(),
                reconciliation.statement_balance.to_string(),
                reconciliation.currency,
                reconciliation.reconciled_at.format("%Y-%m-%d").to_string(),
                line_item_ids.len() as u32,
            ],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;

        for li_id in line_item_ids {
            conn.execute(
                "INSERT INTO reconciliation_line_item (reconciliation_id, line_item_id) VALUES (?1, ?2)",
                params![reconciliation.id.to_string(), li_id.to_string()],
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
            conn.execute(
                "UPDATE line_item SET is_reconciled = 1 WHERE id = ?1",
                params![li_id.to_string()],
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        }
        Ok(())
    }

    fn list_reconciliations(
        &self,
        account_id: Option<&Uuid>,
    ) -> StorageResult<Vec<Reconciliation>> {
        let conn = self.conn.borrow();
        let (sql, param_val) = if let Some(aid) = account_id {
            (
                "SELECT id, account_id, statement_date, statement_balance, currency, reconciled_at, line_item_count
                 FROM reconciliation WHERE account_id = ?1 ORDER BY statement_date DESC",
                Some(aid.to_string()),
            )
        } else {
            (
                "SELECT id, account_id, statement_date, statement_balance, currency, reconciled_at, line_item_count
                 FROM reconciliation ORDER BY statement_date DESC",
                None,
            )
        };
        let mut stmt = conn.prepare(sql)
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let mut results = Vec::new();
        if let Some(ref pv) = param_val {
            let rows = stmt.query_map(params![pv], |row| Ok(row_to_reconciliation(row)))
                .map_err(|e| StorageError::Internal(e.to_string()))?;
            for row in rows {
                results.push(row.map_err(|e| StorageError::Internal(e.to_string()))??);
            }
        } else {
            let rows = stmt.query_map([], |row| Ok(row_to_reconciliation(row)))
                .map_err(|e| StorageError::Internal(e.to_string()))?;
            for row in rows {
                results.push(row.map_err(|e| StorageError::Internal(e.to_string()))??);
            }
        }
        Ok(results)
    }

    fn get_reconciliation_detail(
        &self,
        id: &Uuid,
    ) -> StorageResult<Option<(Reconciliation, Vec<Uuid>)>> {
        let conn = self.conn.borrow();
        let reconciliation = conn
            .prepare("SELECT id, account_id, statement_date, statement_balance, currency, reconciled_at, line_item_count FROM reconciliation WHERE id = ?1")
            .map_err(|e| StorageError::Internal(e.to_string()))?
            .query_row(params![id.to_string()], |row| Ok(row_to_reconciliation(row)))
            .optional()
            .map_err(|e| StorageError::Internal(e.to_string()))?;

        match reconciliation {
            None => Ok(None),
            Some(rec) => {
                let rec = rec?;
                let mut stmt = conn
                    .prepare("SELECT line_item_id FROM reconciliation_line_item WHERE reconciliation_id = ?1")
                    .map_err(|e| StorageError::Internal(e.to_string()))?;
                let ids = stmt
                    .query_map(params![id.to_string()], |row| row.get::<_, String>(0))
                    .map_err(|e| StorageError::Internal(e.to_string()))?
                    .map(|r| {
                        let s = r.map_err(|e| StorageError::Internal(e.to_string()))?;
                        parse_uuid(&s)
                    })
                    .collect::<StorageResult<Vec<_>>>()?;
                Ok(Some((rec, ids)))
            }
        }
    }

    // -- Recurring templates --

    fn create_recurring_template(&self, template: &RecurringTemplate) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO recurring_template (id, description, frequency, interval_val, next_date, end_date, is_active, line_items_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                template.id.to_string(),
                template.description,
                template.frequency,
                template.interval,
                template.next_date.format("%Y-%m-%d").to_string(),
                template.end_date.map(|d| d.format("%Y-%m-%d").to_string()),
                template.is_active as i32,
                template.line_items_json,
                template.created_at.format("%Y-%m-%d").to_string(),
            ],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn list_recurring_templates(&self) -> StorageResult<Vec<RecurringTemplate>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare("SELECT id, description, frequency, interval_val, next_date, end_date, is_active, line_items_json, created_at FROM recurring_template ORDER BY next_date")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| Ok(row_to_recurring_template(row)))
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.map(|r| r.map_err(|e| StorageError::Internal(e.to_string()))?)
            .collect()
    }

    fn update_recurring_template(&self, template: &RecurringTemplate) -> StorageResult<()> {
        let conn = self.conn.borrow();
        let affected = conn
            .execute(
                "UPDATE recurring_template SET description = ?2, frequency = ?3, interval_val = ?4, next_date = ?5, end_date = ?6, is_active = ?7, line_items_json = ?8 WHERE id = ?1",
                params![
                    template.id.to_string(),
                    template.description,
                    template.frequency,
                    template.interval,
                    template.next_date.format("%Y-%m-%d").to_string(),
                    template.end_date.map(|d| d.format("%Y-%m-%d").to_string()),
                    template.is_active as i32,
                    template.line_items_json,
                ],
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        if affected == 0 {
            return Err(StorageError::NotFound(format!("recurring_template {}", template.id)));
        }
        Ok(())
    }

    fn delete_recurring_template(&self, id: &Uuid) -> StorageResult<()> {
        let conn = self.conn.borrow();
        let affected = conn
            .execute("DELETE FROM recurring_template WHERE id = ?1", params![id.to_string()])
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        if affected == 0 {
            return Err(StorageError::NotFound(format!("recurring_template {id}")));
        }
        Ok(())
    }

    // -- Pagination --

    fn count_journal_entries(&self, filter: &TransactionFilter) -> StorageResult<u64> {
        let conn = self.conn.borrow();
        let mut conditions: Vec<String> = Vec::new();
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        // account_ids takes precedence over account_id when both set
        // Use account_closure to include sub-account transactions
        if let Some(ref ids) = filter.account_ids {
            if !ids.is_empty() {
                let placeholders: Vec<&str> = ids.iter().map(|_| "?").collect();
                conditions.push(format!("je.id IN (SELECT journal_entry_id FROM line_item WHERE account_id IN (SELECT descendant_id FROM account_closure WHERE ancestor_id IN ({})))", placeholders.join(", ")));
                for id in ids {
                    param_values.push(Box::new(id.to_string()));
                }
            }
        } else if let Some(ref account_id) = filter.account_id {
            conditions.push("je.id IN (SELECT journal_entry_id FROM line_item WHERE account_id IN (SELECT descendant_id FROM account_closure WHERE ancestor_id = ?))".to_string());
            param_values.push(Box::new(account_id.to_string()));
        }
        if let Some(ref from_date) = filter.from_date {
            conditions.push("je.date >= ?".to_string());
            param_values.push(Box::new(from_date.format("%Y-%m-%d").to_string()));
        }
        if let Some(ref to_date) = filter.to_date {
            conditions.push("je.date <= ?".to_string());
            param_values.push(Box::new(to_date.format("%Y-%m-%d").to_string()));
        }
        if let Some(ref status) = filter.status {
            conditions.push("je.status = ?".to_string());
            param_values.push(Box::new(status.as_str().to_string()));
        }
        if let Some(ref source) = filter.source {
            conditions.push("je.source = ?".to_string());
            param_values.push(Box::new(source.clone()));
        }
        if let Some(ref search) = filter.description_search {
            conditions.push("je.description LIKE ?".to_string());
            param_values.push(Box::new(format!("%{}%", search)));
        }
        if let Some(ref tags) = filter.tag_filters {
            for tag in tags {
                conditions.push("je.id IN (SELECT journal_entry_id FROM journal_entry_metadata WHERE key = 'tags' AND (',' || LOWER(value) || ',') LIKE ?)".to_string());
                param_values.push(Box::new(format!("%,{},%", tag.to_lowercase())));
            }
        }
        if let Some(ref tags_or) = filter.tag_filters_or {
            if !tags_or.is_empty() {
                let or_parts: Vec<&str> = tags_or.iter().map(|_| "(',' || LOWER(value) || ',') LIKE ?").collect();
                conditions.push(format!(
                    "je.id IN (SELECT journal_entry_id FROM journal_entry_metadata WHERE key = 'tags' AND ({}))",
                    or_parts.join(" OR ")
                ));
                for tag in tags_or {
                    param_values.push(Box::new(format!("%,{},%", tag.to_lowercase())));
                }
            }
        }
        if let Some(ref links) = filter.link_filters {
            for link in links {
                conditions.push("je.id IN (SELECT journal_entry_id FROM entry_link WHERE link_name = ?)".to_string());
                param_values.push(Box::new(link.to_lowercase()));
            }
        }

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", conditions.join(" AND "))
        };

        let sql = format!("SELECT COUNT(*) FROM journal_entry je{}", where_clause);
        let mut stmt = conn.prepare(&sql)
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let params_ref: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();
        let count: u64 = stmt
            .query_row(params_ref.as_slice(), |row| row.get(0))
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(count)
    }

    // -- Exchange accounts (CEX) --

    fn list_exchange_accounts(&self) -> StorageResult<Vec<serde_json::Value>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare("SELECT id, exchange, label, api_key, api_secret, linked_etherscan_account_id, passphrase, last_sync, created_at FROM exchange_account ORDER BY created_at")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let exchange: String = row.get(1)?;
                let label: String = row.get(2)?;
                let api_key: String = row.get(3)?;
                let api_secret: String = row.get(4)?;
                let linked_etherscan_account_id: Option<String> = row.get(5)?;
                let passphrase: Option<String> = row.get(6)?;
                let last_sync: Option<String> = row.get(7)?;
                let created_at: String = row.get(8)?;
                Ok(serde_json::json!({
                    "id": id,
                    "exchange": exchange,
                    "label": label,
                    "api_key": api_key,
                    "api_secret": api_secret,
                    "linked_etherscan_account_id": linked_etherscan_account_id,
                    "passphrase": passphrase,
                    "last_sync": last_sync,
                    "created_at": created_at,
                }))
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| StorageError::Internal(e.to_string()))
    }

    fn add_exchange_account(&self, account: &serde_json::Value) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO exchange_account (id, exchange, label, api_key, api_secret, linked_etherscan_account_id, passphrase, last_sync, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                account["id"].as_str().unwrap_or_default(),
                account["exchange"].as_str().unwrap_or_default(),
                account["label"].as_str().unwrap_or_default(),
                account["api_key"].as_str().unwrap_or_default(),
                account["api_secret"].as_str().unwrap_or_default(),
                account["linked_etherscan_account_id"].as_str(),
                account["passphrase"].as_str(),
                account["last_sync"].as_str(),
                account["created_at"].as_str().unwrap_or_default(),
            ],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn update_exchange_account(&self, id: &str, updates: &serde_json::Value) -> StorageResult<()> {
        let conn = self.conn.borrow();
        let mut set_clauses = Vec::new();
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(v) = updates.get("exchange").and_then(|v| v.as_str()) {
            set_clauses.push("exchange = ?");
            param_values.push(Box::new(v.to_string()));
        }
        if let Some(v) = updates.get("label").and_then(|v| v.as_str()) {
            set_clauses.push("label = ?");
            param_values.push(Box::new(v.to_string()));
        }
        if let Some(v) = updates.get("api_key").and_then(|v| v.as_str()) {
            set_clauses.push("api_key = ?");
            param_values.push(Box::new(v.to_string()));
        }
        if let Some(v) = updates.get("api_secret").and_then(|v| v.as_str()) {
            set_clauses.push("api_secret = ?");
            param_values.push(Box::new(v.to_string()));
        }
        if updates.get("linked_etherscan_account_id").is_some() {
            set_clauses.push("linked_etherscan_account_id = ?");
            param_values.push(Box::new(updates["linked_etherscan_account_id"].as_str().map(|s| s.to_string())));
        }
        if updates.get("passphrase").is_some() {
            set_clauses.push("passphrase = ?");
            param_values.push(Box::new(updates["passphrase"].as_str().map(|s| s.to_string())));
        }
        if updates.get("last_sync").is_some() {
            set_clauses.push("last_sync = ?");
            param_values.push(Box::new(updates["last_sync"].as_str().map(|s| s.to_string())));
        }

        if set_clauses.is_empty() {
            return Ok(());
        }

        param_values.push(Box::new(id.to_string()));
        let sql = format!(
            "UPDATE exchange_account SET {} WHERE id = ?",
            set_clauses.join(", ")
        );
        let params_ref: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();
        let affected = conn
            .execute(&sql, params_ref.as_slice())
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        if affected == 0 {
            return Err(StorageError::NotFound(format!("exchange_account {id}")));
        }
        Ok(())
    }

    fn remove_exchange_account(&self, id: &str) -> StorageResult<()> {
        let conn = self.conn.borrow();
        let affected = conn
            .execute("DELETE FROM exchange_account WHERE id = ?1", params![id])
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        if affected == 0 {
            return Err(StorageError::NotFound(format!("exchange_account {id}")));
        }
        Ok(())
    }

    // -- Currency token addresses --

    fn set_currency_token_address(&self, currency: &str, chain: &str, contract_address: &str) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT OR REPLACE INTO currency_token_address (currency, asset_type, param, chain, contract_address) VALUES (?1, '', '', ?2, ?3)",
            params![currency, chain, contract_address],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn get_currency_token_addresses(&self) -> StorageResult<Vec<(String, String, String)>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare("SELECT currency, chain, contract_address FROM currency_token_address ORDER BY currency, asset_type, param")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| StorageError::Internal(e.to_string()))
    }

    fn get_currency_token_address(&self, currency: &str) -> StorageResult<Option<(String, String)>> {
        let conn = self.conn.borrow();
        let result = conn
            .query_row(
                "SELECT chain, contract_address FROM currency_token_address WHERE currency = ?1 LIMIT 1",
                params![currency],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(result)
    }

    // -- Schema --

    fn execute_sql(&self, sql: &str) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute_batch(sql)
            .map_err(|e| StorageError::Internal(e.to_string()))
    }

    fn get_schema_version(&self) -> StorageResult<u32> {
        let conn = self.conn.borrow();
        let result = conn
            .query_row("SELECT version FROM schema_version LIMIT 1", [], |row| {
                row.get::<_, u32>(0)
            })
            .optional()
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(result.unwrap_or(0))
    }

    fn set_schema_version(&self, version: u32) -> StorageResult<()> {
        let conn = self.conn.borrow();
        // Upsert: delete existing and insert new
        conn.execute("DELETE FROM schema_version", [])
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        conn.execute(
            "INSERT INTO schema_version (version) VALUES (?1)",
            params![version],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }
}

/// Apply migrations to the database.
pub fn apply_migrations(storage: &SqliteStorage) -> StorageResult<()> {
    let current = storage.get_schema_version()?;
    if current == 0 {
        // Fresh database — apply full schema
        storage.execute_sql(SCHEMA_SQL)?;
        storage.set_schema_version(SCHEMA_VERSION)?;
    } else {
        // Incremental migrations
        if current < 2 {
            storage.execute_sql(MIGRATION_V2)?;
            storage.set_schema_version(2)?;
        }
        if current < 3 {
            storage.execute_sql(MIGRATION_V3)?;
            storage.set_schema_version(3)?;
        }
        if current < 4 {
            storage.execute_sql(MIGRATION_V4)?;
            storage.set_schema_version(4)?;
        }
        if current < 5 {
            storage.execute_sql(MIGRATION_V5)?;
            storage.set_schema_version(5)?;
        }
        if current < 6 {
            storage.execute_sql(MIGRATION_V6)?;
            storage.set_schema_version(6)?;
        }
        if current < 7 {
            storage.execute_sql(MIGRATION_V7)?;
            storage.set_schema_version(7)?;
        }
        if current < 8 {
            storage.execute_sql(MIGRATION_V8)?;
            storage.set_schema_version(8)?;
        }
        if current < 9 {
            // Add is_reconciled column if it doesn't already exist (idempotent)
            let _ = storage.execute_sql("ALTER TABLE line_item ADD COLUMN is_reconciled INTEGER NOT NULL DEFAULT 0");
            storage.execute_sql(MIGRATION_V9)?;
            storage.set_schema_version(9)?;
        }
        if current < 10 {
            storage.execute_sql(MIGRATION_V10)?;
            storage.set_schema_version(10)?;
        }
        if current < 11 {
            storage.execute_sql(MIGRATION_V11)?;
            storage.set_schema_version(11)?;
        }
        if current < 12 {
            storage.execute_sql(MIGRATION_V12)?;
            storage.set_schema_version(12)?;
        }
        if current < 13 {
            // Add passphrase column if it doesn't already exist (idempotent)
            let _ = storage.execute_sql(MIGRATION_V13);
            storage.set_schema_version(13)?;
        }
        if current < 14 {
            storage.execute_sql(MIGRATION_V14)?;
            storage.set_schema_version(14)?;
        }
        if current < 15 {
            // Add extended balance assertion columns (idempotent)
            let _ = storage.execute_sql(MIGRATION_V15);
            storage.set_schema_version(15)?;
        }
        if current < 16 {
            storage.execute_sql(MIGRATION_V16)?;
            // Migrate links from metadata to entry_link table
            {
                let conn = storage.conn.borrow();
                let mut link_stmt = conn.prepare(
                    "SELECT journal_entry_id, value FROM journal_entry_metadata WHERE key = 'links'"
                ).map_err(|e| StorageError::Internal(e.to_string()))?;
                let link_rows: Vec<(String, String)> = link_stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                }).map_err(|e| StorageError::Internal(e.to_string()))?
                .filter_map(|r| r.ok())
                .collect();
                drop(link_stmt);
                for (entry_id, value) in &link_rows {
                    for token in value.split_whitespace() {
                        let link = token.trim_start_matches('^').to_lowercase();
                        if !link.is_empty() {
                            let _ = conn.execute(
                                "INSERT OR IGNORE INTO entry_link (journal_entry_id, link_name) VALUES (?1, ?2)",
                                params![entry_id, link],
                            );
                        }
                    }
                }
                drop(conn);
            }
            storage.execute_sql("DELETE FROM journal_entry_metadata WHERE key = 'links'")?;
            storage.set_schema_version(16)?;
        }
        if current < 17 {
            storage.execute_sql(MIGRATION_V17)?;
            storage.set_schema_version(17)?;
        }
        if current < 18 {
            let _ = storage.execute_sql(MIGRATION_V18);
            storage.set_schema_version(18)?;
        }
    }
    Ok(())
}

// -- Row mapping helpers --

fn row_to_account(row: &rusqlite::Row<'_>) -> StorageResult<Account> {
    let id_str: String = row
        .get(0)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let parent_id_str: Option<String> = row
        .get(1)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let account_type_str: String = row
        .get(2)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let name: String = row
        .get(3)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let full_name: String = row
        .get(4)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let allowed_json: String = row
        .get(5)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let is_postable: i32 = row
        .get(6)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let is_archived: i32 = row
        .get(7)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let created_at_str: String = row
        .get(8)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let opened_at_str: Option<String> = row
        .get(9)
        .map_err(|e| StorageError::Internal(e.to_string()))?;

    let allowed_currencies: Vec<String> =
        serde_json::from_str(&allowed_json).unwrap_or_default();

    Ok(Account {
        id: parse_uuid(&id_str)?,
        parent_id: parent_id_str.as_deref().map(parse_uuid).transpose()?,
        account_type: parse_account_type(&account_type_str)?,
        name,
        full_name,
        allowed_currencies,
        is_postable: is_postable != 0,
        is_archived: is_archived != 0,
        created_at: parse_date(&created_at_str)?,
        opened_at: opened_at_str.as_deref().map(parse_date).transpose()?,
    })
}

fn row_to_journal_entry(row: &rusqlite::Row<'_>) -> StorageResult<JournalEntry> {
    let id_str: String = row
        .get(0)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let date_str: String = row
        .get(1)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let description: String = row
        .get(2)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let status_str: String = row
        .get(3)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let source: String = row
        .get(4)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let voided_by_str: Option<String> = row
        .get(5)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let created_at_str: String = row
        .get(6)
        .map_err(|e| StorageError::Internal(e.to_string()))?;

    Ok(JournalEntry {
        id: parse_uuid(&id_str)?,
        date: parse_date(&date_str)?,
        description,
        status: parse_entry_status(&status_str)?,
        source,
        voided_by: voided_by_str.as_deref().map(parse_uuid).transpose()?,
        created_at: parse_date(&created_at_str)?,
    })
}

fn row_to_line_item(row: &rusqlite::Row<'_>) -> StorageResult<LineItem> {
    let id_str: String = row
        .get(0)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let je_id_str: String = row
        .get(1)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let account_id_str: String = row
        .get(2)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let currency: String = row
        .get(3)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let currency_asset_type: String = row
        .get(4)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let currency_param: String = row
        .get(5)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let amount_str: String = row
        .get(6)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let lot_id_str: Option<String> = row
        .get(7)
        .map_err(|e| StorageError::Internal(e.to_string()))?;

    Ok(LineItem {
        id: parse_uuid(&id_str)?,
        journal_entry_id: parse_uuid(&je_id_str)?,
        account_id: parse_uuid(&account_id_str)?,
        currency,
        currency_asset_type,
        currency_param,
        amount: parse_decimal(&amount_str)?,
        lot_id: lot_id_str.as_deref().map(parse_uuid).transpose()?,
    })
}

fn row_to_lot(row: &rusqlite::Row<'_>) -> StorageResult<Lot> {
    let id_str: String = row
        .get(0)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let account_id_str: String = row
        .get(1)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let currency: String = row
        .get(2)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let currency_asset_type: String = row
        .get(3)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let currency_param: String = row
        .get(4)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let acquired_date_str: String = row
        .get(5)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let original_quantity_str: String = row
        .get(6)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let remaining_quantity_str: String = row
        .get(7)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let cost_basis_str: String = row
        .get(8)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let cost_basis_currency: String = row
        .get(9)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let cost_basis_currency_asset_type: String = row
        .get(10)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let cost_basis_currency_param: String = row
        .get(11)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let je_id_str: String = row
        .get(12)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let is_closed: i32 = row
        .get(13)
        .map_err(|e| StorageError::Internal(e.to_string()))?;

    Ok(Lot {
        id: parse_uuid(&id_str)?,
        account_id: parse_uuid(&account_id_str)?,
        currency,
        currency_asset_type,
        currency_param,
        acquired_date: parse_date(&acquired_date_str)?,
        original_quantity: parse_decimal(&original_quantity_str)?,
        remaining_quantity: parse_decimal(&remaining_quantity_str)?,
        cost_basis_per_unit: parse_decimal(&cost_basis_str)?,
        cost_basis_currency,
        cost_basis_currency_asset_type,
        cost_basis_currency_param,
        journal_entry_id: parse_uuid(&je_id_str)?,
        is_closed: is_closed != 0,
    })
}

fn row_to_lot_disposal(row: &rusqlite::Row<'_>) -> StorageResult<LotDisposal> {
    let id_str: String = row
        .get(0)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let lot_id_str: String = row
        .get(1)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let je_id_str: String = row
        .get(2)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let quantity_str: String = row
        .get(3)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let proceeds_str: String = row
        .get(4)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let proceeds_currency: String = row
        .get(5)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let proceeds_currency_asset_type: String = row
        .get(6)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let proceeds_currency_param: String = row
        .get(7)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let gain_loss_str: String = row
        .get(8)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let disposal_date_str: String = row
        .get(9)
        .map_err(|e| StorageError::Internal(e.to_string()))?;

    Ok(LotDisposal {
        id: parse_uuid(&id_str)?,
        lot_id: parse_uuid(&lot_id_str)?,
        journal_entry_id: parse_uuid(&je_id_str)?,
        quantity: parse_decimal(&quantity_str)?,
        proceeds_per_unit: parse_decimal(&proceeds_str)?,
        proceeds_currency,
        proceeds_currency_asset_type,
        proceeds_currency_param,
        realized_gain_loss: parse_decimal(&gain_loss_str)?,
        disposal_date: parse_date(&disposal_date_str)?,
    })
}

fn row_to_exchange_rate(row: &rusqlite::Row<'_>) -> StorageResult<ExchangeRate> {
    let id_str: String = row
        .get(0)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let date_str: String = row
        .get(1)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let from_currency: String = row
        .get(2)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let from_currency_asset_type: String = row
        .get(3)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let from_currency_param: String = row
        .get(4)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let to_currency: String = row
        .get(5)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let to_currency_asset_type: String = row
        .get(6)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let to_currency_param: String = row
        .get(7)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let rate_str: String = row
        .get(8)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let source: String = row
        .get(9)
        .map_err(|e| StorageError::Internal(e.to_string()))?;

    Ok(ExchangeRate {
        id: parse_uuid(&id_str)?,
        date: parse_date(&date_str)?,
        from_currency,
        from_currency_asset_type,
        from_currency_param,
        to_currency,
        to_currency_asset_type,
        to_currency_param,
        rate: parse_decimal(&rate_str)?,
        source,
    })
}

fn row_to_balance_assertion(row: &rusqlite::Row<'_>) -> StorageResult<BalanceAssertion> {
    let id_str: String = row
        .get(0)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let account_id_str: String = row
        .get(1)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let date_str: String = row
        .get(2)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let currency: String = row
        .get(3)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let currency_asset_type: String = row
        .get(4)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let currency_param: String = row
        .get(5)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let expected_str: String = row
        .get(6)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let is_passing: i32 = row
        .get(7)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let actual_str: Option<String> = row
        .get(8)
        .map_err(|e| StorageError::Internal(e.to_string()))?;

    let is_strict: i32 = row
        .get(9)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let include_subaccounts: i32 = row
        .get(10)
        .map_err(|e| StorageError::Internal(e.to_string()))?;

    Ok(BalanceAssertion {
        id: parse_uuid(&id_str)?,
        account_id: parse_uuid(&account_id_str)?,
        date: parse_date(&date_str)?,
        currency,
        currency_asset_type,
        currency_param,
        expected_balance: parse_decimal(&expected_str)?,
        is_passing: is_passing != 0,
        actual_balance: actual_str
            .as_deref()
            .map(parse_decimal)
            .transpose()?,
        is_strict: is_strict != 0,
        include_subaccounts: include_subaccounts != 0,
    })
}

fn row_to_metadata(row: &rusqlite::Row<'_>) -> StorageResult<Metadata> {
    let je_id_str: String = row
        .get(0)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let key: String = row
        .get(1)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let value: String = row
        .get(2)
        .map_err(|e| StorageError::Internal(e.to_string()))?;

    Ok(Metadata {
        journal_entry_id: parse_uuid(&je_id_str)?,
        key,
        value,
    })
}

fn row_to_budget(row: &rusqlite::Row<'_>) -> StorageResult<Budget> {
    let id_str: String = row.get(0).map_err(|e| StorageError::Internal(e.to_string()))?;
    let account_pattern: String = row.get(1).map_err(|e| StorageError::Internal(e.to_string()))?;
    let period_type: String = row.get(2).map_err(|e| StorageError::Internal(e.to_string()))?;
    let amount_str: String = row.get(3).map_err(|e| StorageError::Internal(e.to_string()))?;
    let currency: String = row.get(4).map_err(|e| StorageError::Internal(e.to_string()))?;
    let currency_asset_type: String = row.get(5).map_err(|e| StorageError::Internal(e.to_string()))?;
    let currency_param: String = row.get(6).map_err(|e| StorageError::Internal(e.to_string()))?;
    let start_date_str: Option<String> = row.get(7).map_err(|e| StorageError::Internal(e.to_string()))?;
    let end_date_str: Option<String> = row.get(8).map_err(|e| StorageError::Internal(e.to_string()))?;
    let created_at_str: String = row.get(9).map_err(|e| StorageError::Internal(e.to_string()))?;

    Ok(Budget {
        id: parse_uuid(&id_str)?,
        account_pattern,
        period_type,
        amount: parse_decimal(&amount_str)?,
        currency,
        currency_asset_type,
        currency_param,
        start_date: start_date_str.as_deref().map(parse_date).transpose()?,
        end_date: end_date_str.as_deref().map(parse_date).transpose()?,
        created_at: parse_date(&created_at_str)?,
    })
}

fn row_to_reconciliation(row: &rusqlite::Row<'_>) -> StorageResult<Reconciliation> {
    let id_str: String = row.get(0).map_err(|e| StorageError::Internal(e.to_string()))?;
    let account_id_str: String = row.get(1).map_err(|e| StorageError::Internal(e.to_string()))?;
    let statement_date_str: String = row.get(2).map_err(|e| StorageError::Internal(e.to_string()))?;
    let statement_balance_str: String = row.get(3).map_err(|e| StorageError::Internal(e.to_string()))?;
    let currency: String = row.get(4).map_err(|e| StorageError::Internal(e.to_string()))?;
    let reconciled_at_str: String = row.get(5).map_err(|e| StorageError::Internal(e.to_string()))?;
    let line_item_count: u32 = row.get(6).map_err(|e| StorageError::Internal(e.to_string()))?;

    Ok(Reconciliation {
        id: parse_uuid(&id_str)?,
        account_id: parse_uuid(&account_id_str)?,
        statement_date: parse_date(&statement_date_str)?,
        statement_balance: parse_decimal(&statement_balance_str)?,
        currency,
        reconciled_at: parse_date(&reconciled_at_str)?,
        line_item_count,
    })
}

fn row_to_unreconciled_line_item(row: &rusqlite::Row<'_>) -> StorageResult<UnreconciledLineItem> {
    let line_item_id_str: String = row.get(0).map_err(|e| StorageError::Internal(e.to_string()))?;
    let entry_id_str: String = row.get(1).map_err(|e| StorageError::Internal(e.to_string()))?;
    let entry_date_str: String = row.get(2).map_err(|e| StorageError::Internal(e.to_string()))?;
    let entry_description: String = row.get(3).map_err(|e| StorageError::Internal(e.to_string()))?;
    let account_id_str: String = row.get(4).map_err(|e| StorageError::Internal(e.to_string()))?;
    let currency: String = row.get(5).map_err(|e| StorageError::Internal(e.to_string()))?;
    let amount_str: String = row.get(6).map_err(|e| StorageError::Internal(e.to_string()))?;
    let is_reconciled: i32 = row.get(7).map_err(|e| StorageError::Internal(e.to_string()))?;

    Ok(UnreconciledLineItem {
        line_item_id: parse_uuid(&line_item_id_str)?,
        entry_id: parse_uuid(&entry_id_str)?,
        entry_date: parse_date(&entry_date_str)?,
        entry_description,
        account_id: parse_uuid(&account_id_str)?,
        currency,
        amount: parse_decimal(&amount_str)?,
        is_reconciled: is_reconciled != 0,
    })
}

fn row_to_recurring_template(row: &rusqlite::Row<'_>) -> StorageResult<RecurringTemplate> {
    let id_str: String = row.get(0).map_err(|e| StorageError::Internal(e.to_string()))?;
    let description: String = row.get(1).map_err(|e| StorageError::Internal(e.to_string()))?;
    let frequency: String = row.get(2).map_err(|e| StorageError::Internal(e.to_string()))?;
    let interval: u32 = row.get(3).map_err(|e| StorageError::Internal(e.to_string()))?;
    let next_date_str: String = row.get(4).map_err(|e| StorageError::Internal(e.to_string()))?;
    let end_date_str: Option<String> = row.get(5).map_err(|e| StorageError::Internal(e.to_string()))?;
    let is_active: i32 = row.get(6).map_err(|e| StorageError::Internal(e.to_string()))?;
    let line_items_json: String = row.get(7).map_err(|e| StorageError::Internal(e.to_string()))?;
    let created_at_str: String = row.get(8).map_err(|e| StorageError::Internal(e.to_string()))?;

    Ok(RecurringTemplate {
        id: parse_uuid(&id_str)?,
        description,
        frequency,
        interval,
        next_date: parse_date(&next_date_str)?,
        end_date: end_date_str.as_deref().map(parse_date).transpose()?,
        is_active: is_active != 0,
        line_items_json,
        created_at: parse_date(&created_at_str)?,
    })
}

fn fetch_line_items_for_entry(
    conn: &Connection,
    entry_id: &Uuid,
) -> StorageResult<Vec<LineItem>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, journal_entry_id, account_id, currency, currency_asset_type, currency_param, amount, lot_id
             FROM line_item WHERE journal_entry_id = ?1",
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let rows = stmt
        .query_map(params![entry_id.to_string()], |row| {
            Ok(row_to_line_item(row))
        })
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    rows.map(|r| r.map_err(|e| StorageError::Internal(e.to_string()))?)
        .collect()
}

// rusqlite helper extension
use rusqlite::OptionalExtension;

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use dledger_core::storage::Storage;
    use rust_decimal_macros::dec;
    use uuid::Uuid;

    /// Create a fresh in-memory SqliteStorage with schema applied.
    fn setup() -> SqliteStorage {
        let storage = SqliteStorage::new_in_memory().unwrap();
        // Bootstrap schema_version table so apply_migrations can query it
        storage
            .execute_sql("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);")
            .unwrap();
        apply_migrations(&storage).unwrap();
        storage
    }

    fn make_date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    fn make_currency(code: &str, name: &str, decimal_places: u8, is_base: bool) -> Currency {
        Currency {
            code: code.to_string(),
            asset_type: String::new(),
            param: String::new(),
            name: name.to_string(),
            decimal_places,
            is_base,
        }
    }

    fn make_account(
        parent_id: Option<Uuid>,
        account_type: AccountType,
        name: &str,
        full_name: &str,
    ) -> Account {
        Account {
            id: Uuid::now_v7(),
            parent_id,
            account_type,
            name: name.to_string(),
            full_name: full_name.to_string(),
            allowed_currencies: vec![],
            is_postable: true,
            is_archived: false,
            created_at: make_date(2024, 1, 1),
            opened_at: None,
        }
    }

    // ---------------------------------------------------------------
    // 1. Currency CRUD + hidden currencies
    // ---------------------------------------------------------------

    #[test]
    fn test_create_and_get_currency() {
        let s = setup();
        let c = make_currency("USD", "US Dollar", 2, true);
        s.create_currency(&c).unwrap();

        let fetched = s.get_currency("USD").unwrap().unwrap();
        assert_eq!(fetched.code, "USD");
        assert_eq!(fetched.name, "US Dollar");
        assert_eq!(fetched.decimal_places, 2);
        assert!(fetched.is_base);
    }

    #[test]
    fn test_list_currencies_ordered() {
        let s = setup();
        s.create_currency(&make_currency("EUR", "Euro", 2, false)).unwrap();
        s.create_currency(&make_currency("BTC", "Bitcoin", 8, false)).unwrap();
        s.create_currency(&make_currency("USD", "US Dollar", 2, true)).unwrap();

        let list = s.list_currencies().unwrap();
        assert_eq!(list.len(), 3);
        // Should be alphabetical
        assert_eq!(list[0].code, "BTC");
        assert_eq!(list[1].code, "EUR");
        assert_eq!(list[2].code, "USD");
    }

    #[test]
    fn test_duplicate_currency_returns_error() {
        let s = setup();
        s.create_currency(&make_currency("USD", "US Dollar", 2, true)).unwrap();
        let result = s.create_currency(&make_currency("USD", "Dollar", 2, false));
        assert!(matches!(result, Err(StorageError::Duplicate(_))));
    }

    #[test]
    fn test_set_currency_hidden_and_list_hidden() {
        let s = setup();
        s.create_currency(&make_currency("USD", "US Dollar", 2, true)).unwrap();
        s.create_currency(&make_currency("SCAM", "Scam Token", 0, false)).unwrap();

        assert!(s.list_hidden_currencies().unwrap().is_empty());

        s.set_currency_hidden("SCAM", true).unwrap();
        let hidden = s.list_hidden_currencies().unwrap();
        assert_eq!(hidden, vec!["SCAM"]);

        // Unhide it
        s.set_currency_hidden("SCAM", false).unwrap();
        assert!(s.list_hidden_currencies().unwrap().is_empty());
    }

    #[test]
    fn test_set_currency_hidden_nonexistent_returns_not_found() {
        let s = setup();
        let result = s.set_currency_hidden("NOPE", true);
        assert!(matches!(result, Err(StorageError::NotFound(_))));
    }

    // ---------------------------------------------------------------
    // 2. Account CRUD + closure table
    // ---------------------------------------------------------------

    #[test]
    fn test_create_and_get_account() {
        let s = setup();
        let acct = make_account(None, AccountType::Asset, "Assets", "Assets");
        s.create_account(&acct).unwrap();

        let fetched = s.get_account(&acct.id).unwrap().unwrap();
        assert_eq!(fetched.name, "Assets");
        assert_eq!(fetched.full_name, "Assets");
        assert_eq!(fetched.account_type, AccountType::Asset);
        assert!(fetched.is_postable);
        assert!(!fetched.is_archived);
    }

    #[test]
    fn test_account_closure_table_parent_child() {
        let s = setup();
        let parent = make_account(None, AccountType::Asset, "Assets", "Assets");
        s.create_account(&parent).unwrap();

        let child = make_account(Some(parent.id), AccountType::Asset, "Bank", "Assets:Bank");
        s.create_account(&child).unwrap();

        let grandchild = make_account(Some(child.id), AccountType::Asset, "Checking", "Assets:Bank:Checking");
        s.create_account(&grandchild).unwrap();

        // Parent subtree should include self + child + grandchild
        let subtree = s.get_account_subtree_ids(&parent.id).unwrap();
        assert_eq!(subtree.len(), 3);
        assert_eq!(subtree[0], parent.id); // depth 0
        assert!(subtree.contains(&child.id));
        assert!(subtree.contains(&grandchild.id));

        // Child subtree should include self + grandchild
        let child_subtree = s.get_account_subtree_ids(&child.id).unwrap();
        assert_eq!(child_subtree.len(), 2);
        assert!(child_subtree.contains(&child.id));
        assert!(child_subtree.contains(&grandchild.id));

        // Grandchild subtree should include only itself
        let gc_subtree = s.get_account_subtree_ids(&grandchild.id).unwrap();
        assert_eq!(gc_subtree.len(), 1);
        assert_eq!(gc_subtree[0], grandchild.id);
    }

    #[test]
    fn test_archive_account() {
        let s = setup();
        let acct = make_account(None, AccountType::Expense, "Expenses", "Expenses");
        s.create_account(&acct).unwrap();

        s.update_account_archived(&acct.id, true).unwrap();
        let fetched = s.get_account(&acct.id).unwrap().unwrap();
        assert!(fetched.is_archived);

        // Unarchive
        s.update_account_archived(&acct.id, false).unwrap();
        let fetched = s.get_account(&acct.id).unwrap().unwrap();
        assert!(!fetched.is_archived);
    }

    #[test]
    fn test_get_account_by_full_name() {
        let s = setup();
        let acct = make_account(None, AccountType::Revenue, "Income", "Income");
        s.create_account(&acct).unwrap();

        let fetched = s.get_account_by_full_name("Income").unwrap().unwrap();
        assert_eq!(fetched.id, acct.id);

        assert!(s.get_account_by_full_name("NonExistent").unwrap().is_none());
    }

    // ---------------------------------------------------------------
    // 3. Journal entry + line item insert/query
    // ---------------------------------------------------------------

    /// Helper to set up two accounts and a currency, returning (asset_id, expense_id).
    fn seed_accounts_and_currency(s: &SqliteStorage) -> (Uuid, Uuid) {
        s.create_currency(&make_currency("USD", "US Dollar", 2, true)).unwrap();

        let asset = make_account(None, AccountType::Asset, "Assets", "Assets");
        s.create_account(&asset).unwrap();
        let expense = make_account(None, AccountType::Expense, "Expenses", "Expenses");
        s.create_account(&expense).unwrap();
        (asset.id, expense.id)
    }

    #[test]
    fn test_insert_and_get_journal_entry() {
        let s = setup();
        let (asset_id, expense_id) = seed_accounts_and_currency(&s);

        let entry_id = Uuid::now_v7();
        let entry = JournalEntry {
            id: entry_id,
            date: make_date(2024, 3, 15),
            description: "Lunch".to_string(),
            status: JournalEntryStatus::Confirmed,
            source: "manual".to_string(),
            voided_by: None,
            created_at: make_date(2024, 3, 15),
        };
        let items = vec![
            LineItem {
                id: Uuid::now_v7(),
                journal_entry_id: entry_id,
                account_id: expense_id,
                currency: "USD".to_string(),
                currency_asset_type: String::new(),
                currency_param: String::new(),
                amount: dec!(12.50),
                lot_id: None,
            },
            LineItem {
                id: Uuid::now_v7(),
                journal_entry_id: entry_id,
                account_id: asset_id,
                currency: "USD".to_string(),
                currency_asset_type: String::new(),
                currency_param: String::new(),
                amount: dec!(-12.50),
                lot_id: None,
            },
        ];

        s.insert_journal_entry(&entry, &items).unwrap();

        let (fetched_entry, fetched_items) = s.get_journal_entry(&entry_id).unwrap().unwrap();
        assert_eq!(fetched_entry.description, "Lunch");
        assert_eq!(fetched_entry.status, JournalEntryStatus::Confirmed);
        assert_eq!(fetched_items.len(), 2);

        // Verify amounts sum to zero
        let total: Decimal = fetched_items.iter().map(|i| i.amount).sum();
        assert_eq!(total, dec!(0));
    }

    #[test]
    fn test_query_journal_entries_with_filter() {
        let s = setup();
        let (asset_id, expense_id) = seed_accounts_and_currency(&s);

        // Insert two entries on different dates
        for (i, date) in [(1, make_date(2024, 1, 10)), (2, make_date(2024, 6, 20))] {
            let eid = Uuid::now_v7();
            let entry = JournalEntry {
                id: eid,
                date,
                description: format!("Entry {i}"),
                status: JournalEntryStatus::Confirmed,
                source: "manual".to_string(),
                voided_by: None,
                created_at: date,
            };
            let items = vec![
                LineItem {
                    id: Uuid::now_v7(),
                    journal_entry_id: eid,
                    account_id: expense_id,
                    currency: "USD".to_string(),
                    currency_asset_type: String::new(),
                    currency_param: String::new(),
                    amount: dec!(10),
                    lot_id: None,
                },
                LineItem {
                    id: Uuid::now_v7(),
                    journal_entry_id: eid,
                    account_id: asset_id,
                    currency: "USD".to_string(),
                    currency_asset_type: String::new(),
                    currency_param: String::new(),
                    amount: dec!(-10),
                    lot_id: None,
                },
            ];
            s.insert_journal_entry(&entry, &items).unwrap();
        }

        // Filter by date range that includes only the first entry
        let filter = TransactionFilter {
            from_date: Some(make_date(2024, 1, 1)),
            to_date: Some(make_date(2024, 3, 1)),
            ..Default::default()
        };
        let results = s.query_journal_entries(&filter).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0.description, "Entry 1");

        // Filter by account
        let filter_acct = TransactionFilter {
            account_id: Some(expense_id),
            ..Default::default()
        };
        let results = s.query_journal_entries(&filter_acct).unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn test_sum_line_items() {
        let s = setup();
        let (asset_id, expense_id) = seed_accounts_and_currency(&s);

        let eid = Uuid::now_v7();
        let entry = JournalEntry {
            id: eid,
            date: make_date(2024, 5, 1),
            description: "Test sum".to_string(),
            status: JournalEntryStatus::Confirmed,
            source: "manual".to_string(),
            voided_by: None,
            created_at: make_date(2024, 5, 1),
        };
        let items = vec![
            LineItem {
                id: Uuid::now_v7(),
                journal_entry_id: eid,
                account_id: expense_id,
                currency: "USD".to_string(),
                currency_asset_type: String::new(),
                currency_param: String::new(),
                amount: dec!(100),
                lot_id: None,
            },
            LineItem {
                id: Uuid::now_v7(),
                journal_entry_id: eid,
                account_id: asset_id,
                currency: "USD".to_string(),
                currency_asset_type: String::new(),
                currency_param: String::new(),
                amount: dec!(-100),
                lot_id: None,
            },
        ];
        s.insert_journal_entry(&entry, &items).unwrap();

        let balances = s.sum_line_items(&[expense_id], None).unwrap();
        assert_eq!(balances.len(), 1);
        assert_eq!(balances[0].currency, "USD");
        assert_eq!(balances[0].amount, dec!(100));

        // With before_date that excludes the entry
        let balances_before = s.sum_line_items(&[expense_id], Some(make_date(2024, 4, 1))).unwrap();
        assert!(balances_before.is_empty());
    }

    // ---------------------------------------------------------------
    // 4. Exchange rate insert + source priority
    // ---------------------------------------------------------------

    #[test]
    fn test_insert_and_get_exchange_rate() {
        let s = setup();
        s.create_currency(&make_currency("USD", "US Dollar", 2, true)).unwrap();
        s.create_currency(&make_currency("EUR", "Euro", 2, false)).unwrap();

        let rate = ExchangeRate {
            id: Uuid::now_v7(),
            date: make_date(2024, 6, 1),
            from_currency: "EUR".to_string(),
            from_currency_asset_type: String::new(),
            from_currency_param: String::new(),
            to_currency: "USD".to_string(),
            to_currency_asset_type: String::new(),
            to_currency_param: String::new(),
            rate: dec!(1.08),
            source: "manual".to_string(),
        };
        s.insert_exchange_rate(&rate).unwrap();

        let fetched = s.get_exchange_rate("EUR", "USD", make_date(2024, 6, 1)).unwrap();
        assert_eq!(fetched, Some(dec!(1.08)));
    }

    #[test]
    fn test_exchange_rate_inverse_fallback() {
        let s = setup();
        s.create_currency(&make_currency("USD", "US Dollar", 2, true)).unwrap();
        s.create_currency(&make_currency("EUR", "Euro", 2, false)).unwrap();

        let rate = ExchangeRate {
            id: Uuid::now_v7(),
            date: make_date(2024, 6, 1),
            from_currency: "EUR".to_string(),
            from_currency_asset_type: String::new(),
            from_currency_param: String::new(),
            to_currency: "USD".to_string(),
            to_currency_asset_type: String::new(),
            to_currency_param: String::new(),
            rate: dec!(2), // 1 EUR = 2 USD
            source: "manual".to_string(),
        };
        s.insert_exchange_rate(&rate).unwrap();

        // Query inverse: USD -> EUR should return 1/2 = 0.5
        let inverse = s.get_exchange_rate("USD", "EUR", make_date(2024, 6, 1)).unwrap().unwrap();
        assert_eq!(inverse, dec!(0.5));
    }

    #[test]
    fn test_exchange_rate_source_priority() {
        let s = setup();
        s.create_currency(&make_currency("USD", "US Dollar", 2, true)).unwrap();
        s.create_currency(&make_currency("EUR", "Euro", 2, false)).unwrap();

        let date = make_date(2024, 6, 1);

        // Insert API rate (priority 1)
        let api_rate = ExchangeRate {
            id: Uuid::now_v7(),
            date,
            from_currency: "EUR".to_string(),
            from_currency_asset_type: String::new(),
            from_currency_param: String::new(),
            to_currency: "USD".to_string(),
            to_currency_asset_type: String::new(),
            to_currency_param: String::new(),
            rate: dec!(1.05),
            source: "coingecko".to_string(),
        };
        s.insert_exchange_rate(&api_rate).unwrap();
        assert_eq!(s.get_exchange_rate("EUR", "USD", date).unwrap(), Some(dec!(1.05)));

        // Insert ledger-file rate (priority 2) — should overwrite API
        let ledger_rate = ExchangeRate {
            id: Uuid::now_v7(),
            date,
            from_currency: "EUR".to_string(),
            from_currency_asset_type: String::new(),
            from_currency_param: String::new(),
            to_currency: "USD".to_string(),
            to_currency_asset_type: String::new(),
            to_currency_param: String::new(),
            rate: dec!(1.08),
            source: "ledger-file".to_string(),
        };
        s.insert_exchange_rate(&ledger_rate).unwrap();
        assert_eq!(s.get_exchange_rate("EUR", "USD", date).unwrap(), Some(dec!(1.08)));

        // Insert manual rate (priority 3) — should overwrite ledger-file
        let manual_rate = ExchangeRate {
            id: Uuid::now_v7(),
            date,
            from_currency: "EUR".to_string(),
            from_currency_asset_type: String::new(),
            from_currency_param: String::new(),
            to_currency: "USD".to_string(),
            to_currency_asset_type: String::new(),
            to_currency_param: String::new(),
            rate: dec!(1.10),
            source: "manual".to_string(),
        };
        s.insert_exchange_rate(&manual_rate).unwrap();
        assert_eq!(s.get_exchange_rate("EUR", "USD", date).unwrap(), Some(dec!(1.10)));

        // Try to overwrite manual with API — should NOT overwrite
        let api_rate2 = ExchangeRate {
            id: Uuid::now_v7(),
            date,
            from_currency: "EUR".to_string(),
            from_currency_asset_type: String::new(),
            from_currency_param: String::new(),
            to_currency: "USD".to_string(),
            to_currency_asset_type: String::new(),
            to_currency_param: String::new(),
            rate: dec!(0.99),
            source: "frankfurter".to_string(),
        };
        s.insert_exchange_rate(&api_rate2).unwrap();
        // Should still be the manual rate
        assert_eq!(s.get_exchange_rate("EUR", "USD", date).unwrap(), Some(dec!(1.10)));
    }

    #[test]
    fn test_transaction_source_priority() {
        let s = setup();
        s.create_currency(&make_currency("BTC", "Bitcoin", 8, false)).unwrap();
        s.create_currency(&make_currency("USD", "US Dollar", 2, true)).unwrap();

        let date = make_date(2024, 6, 1);

        // Insert API rate (priority 1)
        let api_rate = ExchangeRate {
            id: Uuid::now_v7(),
            date,
            from_currency: "BTC".to_string(),
            from_currency_asset_type: String::new(),
            from_currency_param: String::new(),
            to_currency: "USD".to_string(),
            to_currency_asset_type: String::new(),
            to_currency_param: String::new(),
            rate: dec!(50000),
            source: "coingecko".to_string(),
        };
        s.insert_exchange_rate(&api_rate).unwrap();
        assert_eq!(s.get_exchange_rate("BTC", "USD", date).unwrap(), Some(dec!(50000)));

        // Insert transaction rate (priority 2) — should overwrite API
        let tx_rate = ExchangeRate {
            id: Uuid::now_v7(),
            date,
            from_currency: "BTC".to_string(),
            from_currency_asset_type: String::new(),
            from_currency_param: String::new(),
            to_currency: "USD".to_string(),
            to_currency_asset_type: String::new(),
            to_currency_param: String::new(),
            rate: dec!(50500),
            source: "transaction".to_string(),
        };
        s.insert_exchange_rate(&tx_rate).unwrap();
        assert_eq!(s.get_exchange_rate("BTC", "USD", date).unwrap(), Some(dec!(50500)));

        // Insert manual rate (priority 3) — should overwrite transaction
        let manual_rate = ExchangeRate {
            id: Uuid::now_v7(),
            date,
            from_currency: "BTC".to_string(),
            from_currency_asset_type: String::new(),
            from_currency_param: String::new(),
            to_currency: "USD".to_string(),
            to_currency_asset_type: String::new(),
            to_currency_param: String::new(),
            rate: dec!(51000),
            source: "manual".to_string(),
        };
        s.insert_exchange_rate(&manual_rate).unwrap();
        assert_eq!(s.get_exchange_rate("BTC", "USD", date).unwrap(), Some(dec!(51000)));

        // Try to overwrite manual with transaction — should NOT overwrite
        let tx_rate2 = ExchangeRate {
            id: Uuid::now_v7(),
            date,
            from_currency: "BTC".to_string(),
            from_currency_asset_type: String::new(),
            from_currency_param: String::new(),
            to_currency: "USD".to_string(),
            to_currency_asset_type: String::new(),
            to_currency_param: String::new(),
            rate: dec!(49000),
            source: "transaction".to_string(),
        };
        s.insert_exchange_rate(&tx_rate2).unwrap();
        assert_eq!(s.get_exchange_rate("BTC", "USD", date).unwrap(), Some(dec!(51000)));
    }

    #[test]
    fn test_get_exchange_rate_source() {
        let s = setup();
        s.create_currency(&make_currency("USD", "US Dollar", 2, true)).unwrap();
        s.create_currency(&make_currency("BTC", "Bitcoin", 8, false)).unwrap();

        let date = make_date(2024, 7, 1);
        let rate = ExchangeRate {
            id: Uuid::now_v7(),
            date,
            from_currency: "BTC".to_string(),
            from_currency_asset_type: String::new(),
            from_currency_param: String::new(),
            to_currency: "USD".to_string(),
            to_currency_asset_type: String::new(),
            to_currency_param: String::new(),
            rate: dec!(60000),
            source: "coingecko".to_string(),
        };
        s.insert_exchange_rate(&rate).unwrap();

        let source = s.get_exchange_rate_source("BTC", "USD", date).unwrap();
        assert_eq!(source, Some("coingecko".to_string()));

        // Non-existent pair
        let none = s.get_exchange_rate_source("USD", "BTC", date).unwrap();
        assert!(none.is_none());
    }

    #[test]
    fn test_transitive_rate_via_shared_base() {
        let s = setup();
        s.create_currency(&make_currency("USD", "US Dollar", 2, true)).unwrap();
        s.create_currency(&make_currency("EUR", "Euro", 2, false)).unwrap();
        s.create_currency(&make_currency("GLD", "Gold", 4, false)).unwrap();

        let date = make_date(2024, 1, 15);
        // EUR→USD and GLD→USD on same date
        s.insert_exchange_rate(&ExchangeRate {
            id: Uuid::now_v7(), date,
            from_currency: "EUR".into(), from_currency_asset_type: String::new(), from_currency_param: String::new(),
            to_currency: "USD".into(), to_currency_asset_type: String::new(), to_currency_param: String::new(),
            rate: dec!(1.10), source: "api".into(),
        }).unwrap();
        s.insert_exchange_rate(&ExchangeRate {
            id: Uuid::now_v7(), date,
            from_currency: "GLD".into(), from_currency_asset_type: String::new(), from_currency_param: String::new(),
            to_currency: "USD".into(), to_currency_asset_type: String::new(), to_currency_param: String::new(),
            rate: dec!(2000), source: "api".into(),
        }).unwrap();

        // EUR→GLD = (EUR→USD) * (1 / GLD→USD) = 1.10 / 2000 = 0.00055
        let rate = s.get_exchange_rate("EUR", "GLD", date).unwrap().unwrap();
        assert_eq!(rate, dec!(1.10) / dec!(2000));
    }

    #[test]
    fn test_transitive_rate_inverse_second_leg() {
        let s = setup();
        s.create_currency(&make_currency("USD", "US Dollar", 2, true)).unwrap();
        s.create_currency(&make_currency("EUR", "Euro", 2, false)).unwrap();
        s.create_currency(&make_currency("GLD", "Gold", 4, false)).unwrap();

        let date = make_date(2024, 1, 15);
        // EUR→USD and USD→GLD on same date
        s.insert_exchange_rate(&ExchangeRate {
            id: Uuid::now_v7(), date,
            from_currency: "EUR".into(), from_currency_asset_type: String::new(), from_currency_param: String::new(),
            to_currency: "USD".into(), to_currency_asset_type: String::new(), to_currency_param: String::new(),
            rate: dec!(1.10), source: "api".into(),
        }).unwrap();
        s.insert_exchange_rate(&ExchangeRate {
            id: Uuid::now_v7(), date,
            from_currency: "USD".into(), from_currency_asset_type: String::new(), from_currency_param: String::new(),
            to_currency: "GLD".into(), to_currency_asset_type: String::new(), to_currency_param: String::new(),
            rate: dec!(0.0005), source: "api".into(),
        }).unwrap();

        // EUR→GLD = (EUR→USD) * (USD→GLD) = 1.10 * 0.0005 = 0.00055
        let rate = s.get_exchange_rate("EUR", "GLD", date).unwrap().unwrap();
        assert_eq!(rate, dec!(1.10) * dec!(0.0005));
    }

    #[test]
    fn test_direct_rate_preferred_over_transitive() {
        let s = setup();
        s.create_currency(&make_currency("USD", "US Dollar", 2, true)).unwrap();
        s.create_currency(&make_currency("EUR", "Euro", 2, false)).unwrap();
        s.create_currency(&make_currency("GLD", "Gold", 4, false)).unwrap();

        let date = make_date(2024, 1, 15);
        // Direct EUR→GLD
        s.insert_exchange_rate(&ExchangeRate {
            id: Uuid::now_v7(), date,
            from_currency: "EUR".into(), from_currency_asset_type: String::new(), from_currency_param: String::new(),
            to_currency: "GLD".into(), to_currency_asset_type: String::new(), to_currency_param: String::new(),
            rate: dec!(0.00060), source: "manual".into(),
        }).unwrap();
        // Transitive path EUR→USD→GLD
        s.insert_exchange_rate(&ExchangeRate {
            id: Uuid::now_v7(), date,
            from_currency: "EUR".into(), from_currency_asset_type: String::new(), from_currency_param: String::new(),
            to_currency: "USD".into(), to_currency_asset_type: String::new(), to_currency_param: String::new(),
            rate: dec!(1.10), source: "api".into(),
        }).unwrap();
        s.insert_exchange_rate(&ExchangeRate {
            id: Uuid::now_v7(), date,
            from_currency: "USD".into(), from_currency_asset_type: String::new(), from_currency_param: String::new(),
            to_currency: "GLD".into(), to_currency_asset_type: String::new(), to_currency_param: String::new(),
            rate: dec!(0.0005), source: "api".into(),
        }).unwrap();

        // Direct rate should be used
        let rate = s.get_exchange_rate("EUR", "GLD", date).unwrap().unwrap();
        assert_eq!(rate, dec!(0.00060));
    }

    #[test]
    fn test_transitive_within_staleness_window() {
        let s = setup();
        s.create_currency(&make_currency("USD", "US Dollar", 2, true)).unwrap();
        s.create_currency(&make_currency("EUR", "Euro", 2, false)).unwrap();
        s.create_currency(&make_currency("GLD", "Gold", 4, false)).unwrap();

        // EUR→USD on 2024-01-15, GLD→USD on 2024-01-12 (3-day gap, within 7-day window)
        s.insert_exchange_rate(&ExchangeRate {
            id: Uuid::now_v7(), date: make_date(2024, 1, 15),
            from_currency: "EUR".into(), from_currency_asset_type: String::new(), from_currency_param: String::new(),
            to_currency: "USD".into(), to_currency_asset_type: String::new(), to_currency_param: String::new(),
            rate: dec!(1.10), source: "api".into(),
        }).unwrap();
        s.insert_exchange_rate(&ExchangeRate {
            id: Uuid::now_v7(), date: make_date(2024, 1, 12),
            from_currency: "GLD".into(), from_currency_asset_type: String::new(), from_currency_param: String::new(),
            to_currency: "USD".into(), to_currency_asset_type: String::new(), to_currency_param: String::new(),
            rate: dec!(2000), source: "api".into(),
        }).unwrap();

        // 3 days apart — within 7-day window, should succeed
        let rate = s.get_exchange_rate("EUR", "GLD", make_date(2024, 1, 15)).unwrap();
        assert!(rate.is_some());
        // EUR→USD=1.10, GLD→USD=2000 → EUR→GLD = 1.10/2000
        assert_eq!(rate.unwrap(), dec!(1.10) / dec!(2000));
    }

    #[test]
    fn test_transitive_beyond_staleness_window() {
        let s = setup();
        s.create_currency(&make_currency("USD", "US Dollar", 2, true)).unwrap();
        s.create_currency(&make_currency("EUR", "Euro", 2, false)).unwrap();
        s.create_currency(&make_currency("GLD", "Gold", 4, false)).unwrap();

        // EUR→USD on 2024-01-15, GLD→USD on 2024-01-01 (14-day gap, beyond 7-day window)
        s.insert_exchange_rate(&ExchangeRate {
            id: Uuid::now_v7(), date: make_date(2024, 1, 15),
            from_currency: "EUR".into(), from_currency_asset_type: String::new(), from_currency_param: String::new(),
            to_currency: "USD".into(), to_currency_asset_type: String::new(), to_currency_param: String::new(),
            rate: dec!(1.10), source: "api".into(),
        }).unwrap();
        s.insert_exchange_rate(&ExchangeRate {
            id: Uuid::now_v7(), date: make_date(2024, 1, 1),
            from_currency: "GLD".into(), from_currency_asset_type: String::new(), from_currency_param: String::new(),
            to_currency: "USD".into(), to_currency_asset_type: String::new(), to_currency_param: String::new(),
            rate: dec!(2000), source: "api".into(),
        }).unwrap();

        // 14 days apart — beyond 7-day window, should fail
        let rate = s.get_exchange_rate("EUR", "GLD", make_date(2024, 1, 15)).unwrap();
        assert_eq!(rate, None);
    }

    #[test]
    fn test_transitive_on_or_before_second_leg() {
        let s = setup();
        s.create_currency(&make_currency("USD", "US Dollar", 2, true)).unwrap();
        s.create_currency(&make_currency("EUR", "Euro", 2, false)).unwrap();
        s.create_currency(&make_currency("GLD", "Gold", 4, false)).unwrap();

        // EUR→USD on 2024-01-13, GLD→USD on 2024-01-14 (second leg a day after first, both within window)
        s.insert_exchange_rate(&ExchangeRate {
            id: Uuid::now_v7(), date: make_date(2024, 1, 13),
            from_currency: "EUR".into(), from_currency_asset_type: String::new(), from_currency_param: String::new(),
            to_currency: "USD".into(), to_currency_asset_type: String::new(), to_currency_param: String::new(),
            rate: dec!(1.10), source: "api".into(),
        }).unwrap();
        s.insert_exchange_rate(&ExchangeRate {
            id: Uuid::now_v7(), date: make_date(2024, 1, 14),
            from_currency: "GLD".into(), from_currency_asset_type: String::new(), from_currency_param: String::new(),
            to_currency: "USD".into(), to_currency_asset_type: String::new(), to_currency_param: String::new(),
            rate: dec!(2000), source: "api".into(),
        }).unwrap();

        // Both within 7 days of target date (Jan 15), should succeed
        let rate = s.get_exchange_rate("EUR", "GLD", make_date(2024, 1, 15)).unwrap();
        assert!(rate.is_some());
        assert_eq!(rate.unwrap(), dec!(1.10) / dec!(2000));
    }

    #[test]
    fn test_no_transitive_when_no_path() {
        let s = setup();
        s.create_currency(&make_currency("USD", "US Dollar", 2, true)).unwrap();
        s.create_currency(&make_currency("EUR", "Euro", 2, false)).unwrap();
        s.create_currency(&make_currency("GBP", "British Pound", 2, false)).unwrap();
        s.create_currency(&make_currency("JPY", "Yen", 0, false)).unwrap();

        let date = make_date(2024, 1, 15);
        // EUR→USD exists, JPY→GBP exists — no path from EUR to GBP
        s.insert_exchange_rate(&ExchangeRate {
            id: Uuid::now_v7(), date,
            from_currency: "EUR".into(), from_currency_asset_type: String::new(), from_currency_param: String::new(),
            to_currency: "USD".into(), to_currency_asset_type: String::new(), to_currency_param: String::new(),
            rate: dec!(1.10), source: "api".into(),
        }).unwrap();
        s.insert_exchange_rate(&ExchangeRate {
            id: Uuid::now_v7(), date,
            from_currency: "JPY".into(), from_currency_asset_type: String::new(), from_currency_param: String::new(),
            to_currency: "GBP".into(), to_currency_asset_type: String::new(), to_currency_param: String::new(),
            rate: dec!(0.005), source: "api".into(),
        }).unwrap();

        let rate = s.get_exchange_rate("EUR", "GBP", date).unwrap();
        assert_eq!(rate, None);
    }

    // ---------------------------------------------------------------
    // 5. Currency rate source priority system
    // ---------------------------------------------------------------

    #[test]
    fn test_set_currency_rate_source_auto() {
        let s = setup();
        s.set_currency_rate_source("BTC", "coingecko", "auto").unwrap();

        let sources = s.get_currency_rate_sources().unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].currency, "BTC");
        assert_eq!(sources[0].rate_source, "coingecko");
        assert_eq!(sources[0].set_by, "auto");
    }

    #[test]
    fn test_currency_rate_source_priority_override() {
        let s = setup();

        // Set auto first
        s.set_currency_rate_source("ETH", "coingecko", "auto").unwrap();
        let sources = s.get_currency_rate_sources().unwrap();
        assert_eq!(sources[0].rate_source, "coingecko");

        // Handler should override auto
        s.set_currency_rate_source("ETH", "finnhub", "handler:etherscan").unwrap();
        let sources = s.get_currency_rate_sources().unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].rate_source, "finnhub");
        assert_eq!(sources[0].set_by, "handler:etherscan");

        // User should override handler
        s.set_currency_rate_source("ETH", "frankfurter", "user").unwrap();
        let sources = s.get_currency_rate_sources().unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].rate_source, "frankfurter");
        assert_eq!(sources[0].set_by, "user");

        // Auto should NOT override user
        s.set_currency_rate_source("ETH", "coingecko", "auto").unwrap();
        let sources = s.get_currency_rate_sources().unwrap();
        assert_eq!(sources[0].rate_source, "frankfurter");
        assert_eq!(sources[0].set_by, "user");
    }

    #[test]
    fn test_clear_auto_rate_sources() {
        let s = setup();
        s.set_currency_rate_source("BTC", "coingecko", "auto").unwrap();
        s.set_currency_rate_source("ETH", "finnhub", "user").unwrap();

        s.clear_auto_rate_sources().unwrap();
        let sources = s.get_currency_rate_sources().unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].currency, "ETH");
    }

    #[test]
    fn test_clear_non_user_rate_sources() {
        let s = setup();
        s.set_currency_rate_source("BTC", "coingecko", "auto").unwrap();
        s.set_currency_rate_source("ETH", "finnhub", "handler:etherscan").unwrap();
        s.set_currency_rate_source("SOL", "frankfurter", "user").unwrap();

        s.clear_non_user_rate_sources().unwrap();
        let sources = s.get_currency_rate_sources().unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].currency, "SOL");
        assert_eq!(sources[0].set_by, "user");
    }

    // ---------------------------------------------------------------
    // 6. Balance assertions
    // ---------------------------------------------------------------

    #[test]
    fn test_insert_and_get_balance_assertion() {
        let s = setup();
        let (asset_id, _) = seed_accounts_and_currency(&s);

        let assertion = BalanceAssertion {
            id: Uuid::now_v7(),
            account_id: asset_id,
            date: make_date(2024, 6, 30),
            currency: "USD".to_string(),
            currency_asset_type: String::new(),
            currency_param: String::new(),
            expected_balance: dec!(1000),
            is_passing: true,
            actual_balance: Some(dec!(1000)),
            is_strict: false,
            include_subaccounts: false,
        };
        s.insert_balance_assertion(&assertion).unwrap();

        let assertions = s.get_balance_assertions(Some(&asset_id)).unwrap();
        assert_eq!(assertions.len(), 1);
        assert_eq!(assertions[0].expected_balance, dec!(1000));
        assert!(assertions[0].is_passing);
        assert_eq!(assertions[0].actual_balance, Some(dec!(1000)));
    }

    #[test]
    fn test_update_balance_assertion_result_failing() {
        let s = setup();
        let (asset_id, _) = seed_accounts_and_currency(&s);

        let assertion = BalanceAssertion {
            id: Uuid::now_v7(),
            account_id: asset_id,
            date: make_date(2024, 6, 30),
            currency: "USD".to_string(),
            currency_asset_type: String::new(),
            currency_param: String::new(),
            expected_balance: dec!(1000),
            is_passing: true,
            actual_balance: None,
            is_strict: false,
            include_subaccounts: false,
        };
        s.insert_balance_assertion(&assertion).unwrap();

        // Update to failing
        s.update_balance_assertion_result(&assertion.id, false, dec!(500)).unwrap();

        let assertions = s.get_balance_assertions(Some(&asset_id)).unwrap();
        assert_eq!(assertions.len(), 1);
        assert!(!assertions[0].is_passing);
        assert_eq!(assertions[0].actual_balance, Some(dec!(500)));
    }

    #[test]
    fn test_get_balance_assertions_all() {
        let s = setup();
        s.create_currency(&make_currency("USD", "US Dollar", 2, true)).unwrap();

        let acct1 = make_account(None, AccountType::Asset, "A1", "Assets:A1");
        let acct2 = make_account(None, AccountType::Asset, "A2", "Assets:A2");
        s.create_account(&acct1).unwrap();
        s.create_account(&acct2).unwrap();

        for acct_id in [acct1.id, acct2.id] {
            let assertion = BalanceAssertion {
                id: Uuid::now_v7(),
                account_id: acct_id,
                date: make_date(2024, 12, 31),
                currency: "USD".to_string(),
                currency_asset_type: String::new(),
                currency_param: String::new(),
                expected_balance: dec!(0),
                is_passing: true,
                actual_balance: Some(dec!(0)),
                is_strict: false,
                include_subaccounts: false,
            };
            s.insert_balance_assertion(&assertion).unwrap();
        }

        // Get all (no account filter)
        let all = s.get_balance_assertions(None).unwrap();
        assert_eq!(all.len(), 2);
    }

    // ---------------------------------------------------------------
    // 7. Integrity checks
    // ---------------------------------------------------------------

    #[test]
    fn test_count_orphaned_line_items_clean() {
        let s = setup();
        let (asset_id, expense_id) = seed_accounts_and_currency(&s);

        let eid = Uuid::now_v7();
        let entry = JournalEntry {
            id: eid,
            date: make_date(2024, 1, 1),
            description: "Normal entry".to_string(),
            status: JournalEntryStatus::Confirmed,
            source: "manual".to_string(),
            voided_by: None,
            created_at: make_date(2024, 1, 1),
        };
        let items = vec![
            LineItem {
                id: Uuid::now_v7(),
                journal_entry_id: eid,
                account_id: expense_id,
                currency: "USD".to_string(),
                currency_asset_type: String::new(),
                currency_param: String::new(),
                amount: dec!(50),
                lot_id: None,
            },
            LineItem {
                id: Uuid::now_v7(),
                journal_entry_id: eid,
                account_id: asset_id,
                currency: "USD".to_string(),
                currency_asset_type: String::new(),
                currency_param: String::new(),
                amount: dec!(-50),
                lot_id: None,
            },
        ];
        s.insert_journal_entry(&entry, &items).unwrap();

        assert_eq!(s.count_orphaned_line_items().unwrap(), 0);
    }

    #[test]
    fn test_count_duplicate_sources_clean() {
        let s = setup();
        let (asset_id, expense_id) = seed_accounts_and_currency(&s);

        // Insert two entries with different sources
        for (i, source) in [(1, "etherscan:0x123:tx1"), (2, "etherscan:0x123:tx2")] {
            let eid = Uuid::now_v7();
            let entry = JournalEntry {
                id: eid,
                date: make_date(2024, 1, i),
                description: format!("Tx {i}"),
                status: JournalEntryStatus::Confirmed,
                source: source.to_string(),
                voided_by: None,
                created_at: make_date(2024, 1, i),
            };
            let items = vec![
                LineItem {
                    id: Uuid::now_v7(),
                    journal_entry_id: eid,
                    account_id: expense_id,
                    currency: "USD".to_string(),
                    currency_asset_type: String::new(),
                    currency_param: String::new(),
                    amount: dec!(10),
                    lot_id: None,
                },
                LineItem {
                    id: Uuid::now_v7(),
                    journal_entry_id: eid,
                    account_id: asset_id,
                    currency: "USD".to_string(),
                    currency_asset_type: String::new(),
                    currency_param: String::new(),
                    amount: dec!(-10),
                    lot_id: None,
                },
            ];
            s.insert_journal_entry(&entry, &items).unwrap();
        }

        // No duplicates since each source is unique
        assert_eq!(s.count_duplicate_sources().unwrap(), 0);
    }

    // ---------------------------------------------------------------
    // 8. Clear data methods
    // ---------------------------------------------------------------

    #[test]
    fn test_clear_ledger_data() {
        let s = setup();
        let (asset_id, expense_id) = seed_accounts_and_currency(&s);

        // Add exchange rate
        s.create_currency(&make_currency("EUR", "Euro", 2, false)).unwrap();
        let rate = ExchangeRate {
            id: Uuid::now_v7(),
            date: make_date(2024, 1, 1),
            from_currency: "EUR".to_string(),
            from_currency_asset_type: String::new(),
            from_currency_param: String::new(),
            to_currency: "USD".to_string(),
            to_currency_asset_type: String::new(),
            to_currency_param: String::new(),
            rate: dec!(1.10),
            source: "manual".to_string(),
        };
        s.insert_exchange_rate(&rate).unwrap();

        // Add a journal entry
        let eid = Uuid::now_v7();
        let entry = JournalEntry {
            id: eid,
            date: make_date(2024, 1, 1),
            description: "Test".to_string(),
            status: JournalEntryStatus::Confirmed,
            source: "manual".to_string(),
            voided_by: None,
            created_at: make_date(2024, 1, 1),
        };
        let items = vec![
            LineItem {
                id: Uuid::now_v7(),
                journal_entry_id: eid,
                account_id: expense_id,
                currency: "USD".to_string(),
                currency_asset_type: String::new(),
                currency_param: String::new(),
                amount: dec!(25),
                lot_id: None,
            },
            LineItem {
                id: Uuid::now_v7(),
                journal_entry_id: eid,
                account_id: asset_id,
                currency: "USD".to_string(),
                currency_asset_type: String::new(),
                currency_param: String::new(),
                amount: dec!(-25),
                lot_id: None,
            },
        ];
        s.insert_journal_entry(&entry, &items).unwrap();

        // Clear ledger data (accounts, currencies, entries — NOT exchange rates)
        s.clear_ledger_data().unwrap();

        assert!(s.list_currencies().unwrap().is_empty());
        assert!(s.list_accounts().unwrap().is_empty());
        let filter = TransactionFilter::default();
        assert!(s.query_journal_entries(&filter).unwrap().is_empty());

        // Exchange rates are also cleared by clear_ledger_data
        // (the implementation deletes exchange_rate via clear_all_data but not in clear_ledger_data)
        // Actually, looking at the implementation, clear_ledger_data does NOT delete exchange_rate.
        let rates = s.list_exchange_rates(None, None).unwrap();
        // Exchange rates should still exist
        assert_eq!(rates.len(), 1);
    }

    #[test]
    fn test_clear_all_data() {
        let s = setup();
        s.create_currency(&make_currency("USD", "US Dollar", 2, true)).unwrap();
        s.create_currency(&make_currency("EUR", "Euro", 2, false)).unwrap();

        let rate = ExchangeRate {
            id: Uuid::now_v7(),
            date: make_date(2024, 1, 1),
            from_currency: "EUR".to_string(),
            from_currency_asset_type: String::new(),
            from_currency_param: String::new(),
            to_currency: "USD".to_string(),
            to_currency_asset_type: String::new(),
            to_currency_param: String::new(),
            rate: dec!(1.10),
            source: "manual".to_string(),
        };
        s.insert_exchange_rate(&rate).unwrap();

        let acct = make_account(None, AccountType::Asset, "Assets", "Assets");
        s.create_account(&acct).unwrap();

        s.clear_all_data().unwrap();

        assert!(s.list_currencies().unwrap().is_empty());
        assert!(s.list_accounts().unwrap().is_empty());
        assert!(s.list_exchange_rates(None, None).unwrap().is_empty());
    }

    // ---------------------------------------------------------------
    // Additional coverage
    // ---------------------------------------------------------------

    #[test]
    fn test_metadata_insert_and_get() {
        let s = setup();
        let (asset_id, expense_id) = seed_accounts_and_currency(&s);

        let eid = Uuid::now_v7();
        let entry = JournalEntry {
            id: eid,
            date: make_date(2024, 1, 1),
            description: "Metadata test".to_string(),
            status: JournalEntryStatus::Confirmed,
            source: "manual".to_string(),
            voided_by: None,
            created_at: make_date(2024, 1, 1),
        };
        let items = vec![
            LineItem {
                id: Uuid::now_v7(),
                journal_entry_id: eid,
                account_id: expense_id,
                currency: "USD".to_string(),
                currency_asset_type: String::new(),
                currency_param: String::new(),
                amount: dec!(10),
                lot_id: None,
            },
            LineItem {
                id: Uuid::now_v7(),
                journal_entry_id: eid,
                account_id: asset_id,
                currency: "USD".to_string(),
                currency_asset_type: String::new(),
                currency_param: String::new(),
                amount: dec!(-10),
                lot_id: None,
            },
        ];
        s.insert_journal_entry(&entry, &items).unwrap();

        s.insert_metadata(&eid, "tx_hash", "0xabc123").unwrap();
        s.insert_metadata(&eid, "note", "test note").unwrap();

        let metadata = s.get_metadata(&eid).unwrap();
        assert_eq!(metadata.len(), 2);
        // Ordered by key
        assert_eq!(metadata[0].key, "note");
        assert_eq!(metadata[0].value, "test note");
        assert_eq!(metadata[1].key, "tx_hash");
        assert_eq!(metadata[1].value, "0xabc123");
    }

    #[test]
    fn test_update_journal_entry_status_void() {
        let s = setup();
        let (asset_id, expense_id) = seed_accounts_and_currency(&s);

        let eid = Uuid::now_v7();
        let entry = JournalEntry {
            id: eid,
            date: make_date(2024, 2, 1),
            description: "To be voided".to_string(),
            status: JournalEntryStatus::Confirmed,
            source: "manual".to_string(),
            voided_by: None,
            created_at: make_date(2024, 2, 1),
        };
        let items = vec![
            LineItem {
                id: Uuid::now_v7(),
                journal_entry_id: eid,
                account_id: expense_id,
                currency: "USD".to_string(),
                currency_asset_type: String::new(),
                currency_param: String::new(),
                amount: dec!(50),
                lot_id: None,
            },
            LineItem {
                id: Uuid::now_v7(),
                journal_entry_id: eid,
                account_id: asset_id,
                currency: "USD".to_string(),
                currency_asset_type: String::new(),
                currency_param: String::new(),
                amount: dec!(-50),
                lot_id: None,
            },
        ];
        s.insert_journal_entry(&entry, &items).unwrap();

        // Create the reversing entry that will be referenced by voided_by
        let reversal_id = Uuid::now_v7();
        let reversal_entry = JournalEntry {
            id: reversal_id,
            date: make_date(2024, 2, 2),
            description: "Reversal".to_string(),
            status: JournalEntryStatus::Confirmed,
            source: "manual".to_string(),
            voided_by: None,
            created_at: make_date(2024, 2, 2),
        };
        let reversal_items = vec![
            LineItem {
                id: Uuid::now_v7(),
                journal_entry_id: reversal_id,
                account_id: asset_id,
                currency: "USD".to_string(),
                currency_asset_type: String::new(),
                currency_param: String::new(),
                amount: dec!(50),
                lot_id: None,
            },
            LineItem {
                id: Uuid::now_v7(),
                journal_entry_id: reversal_id,
                account_id: expense_id,
                currency: "USD".to_string(),
                currency_asset_type: String::new(),
                currency_param: String::new(),
                amount: dec!(-50),
                lot_id: None,
            },
        ];
        s.insert_journal_entry(&reversal_entry, &reversal_items).unwrap();

        s.update_journal_entry_status(&eid, JournalEntryStatus::Voided, Some(reversal_id)).unwrap();

        let (fetched, _) = s.get_journal_entry(&eid).unwrap().unwrap();
        assert_eq!(fetched.status, JournalEntryStatus::Voided);
        assert_eq!(fetched.voided_by, Some(reversal_id));
    }

    #[test]
    fn test_list_exchange_rates_with_filter() {
        let s = setup();
        s.create_currency(&make_currency("USD", "US Dollar", 2, true)).unwrap();
        s.create_currency(&make_currency("EUR", "Euro", 2, false)).unwrap();
        s.create_currency(&make_currency("GBP", "British Pound", 2, false)).unwrap();

        let rate1 = ExchangeRate {
            id: Uuid::now_v7(),
            date: make_date(2024, 1, 1),
            from_currency: "EUR".to_string(),
            from_currency_asset_type: String::new(),
            from_currency_param: String::new(),
            to_currency: "USD".to_string(),
            to_currency_asset_type: String::new(),
            to_currency_param: String::new(),
            rate: dec!(1.10),
            source: "manual".to_string(),
        };
        let rate2 = ExchangeRate {
            id: Uuid::now_v7(),
            date: make_date(2024, 1, 1),
            from_currency: "GBP".to_string(),
            from_currency_asset_type: String::new(),
            from_currency_param: String::new(),
            to_currency: "USD".to_string(),
            to_currency_asset_type: String::new(),
            to_currency_param: String::new(),
            rate: dec!(1.27),
            source: "manual".to_string(),
        };
        s.insert_exchange_rate(&rate1).unwrap();
        s.insert_exchange_rate(&rate2).unwrap();

        // All rates
        let all = s.list_exchange_rates(None, None).unwrap();
        assert_eq!(all.len(), 2);

        // Filter by from_currency
        let eur_rates = s.list_exchange_rates(Some("EUR"), None).unwrap();
        assert_eq!(eur_rates.len(), 1);
        assert_eq!(eur_rates[0].from_currency, "EUR");

        // Filter by to_currency
        let to_usd = s.list_exchange_rates(None, Some("USD")).unwrap();
        assert_eq!(to_usd.len(), 2);
    }

    #[test]
    fn test_schema_version() {
        let s = setup();
        let version = s.get_schema_version().unwrap();
        assert_eq!(version, dledger_core::schema::SCHEMA_VERSION);
    }

    #[test]
    fn test_in_transaction_commit() {
        let s = setup();
        s.in_transaction(&mut |storage| {
            storage.create_currency(&make_currency("USD", "US Dollar", 2, true))?;
            Ok(())
        }).unwrap();

        // Currency should exist after successful transaction
        assert!(s.get_currency("USD").unwrap().is_some());
    }

    #[test]
    fn test_in_transaction_rollback() {
        let s = setup();
        let result = s.in_transaction(&mut |storage| {
            storage.create_currency(&make_currency("USD", "US Dollar", 2, true))?;
            // Force an error to trigger rollback
            Err(StorageError::Internal("deliberate error".to_string()))
        });
        assert!(result.is_err());

        // Currency should NOT exist after rolled-back transaction
        assert!(s.get_currency("USD").unwrap().is_none());
    }

    #[test]
    fn test_raw_transaction_store_and_query() {
        let s = setup();
        s.store_raw_transaction("etherscan:0x123:page1", r#"{"txs":[]}"#).unwrap();
        s.store_raw_transaction("etherscan:0x123:page2", r#"{"txs":[1]}"#).unwrap();
        s.store_raw_transaction("other:xyz", r#"data"#).unwrap();

        // Get single
        let data = s.get_raw_transaction("etherscan:0x123:page1").unwrap().unwrap();
        assert_eq!(data, r#"{"txs":[]}"#);

        // Query by prefix
        let results = s.query_raw_transactions("etherscan:0x123:").unwrap();
        assert_eq!(results.len(), 2);

        // Non-existent
        assert!(s.get_raw_transaction("nope").unwrap().is_none());
    }

    // ---------------------------------------------------------------
    // 9. Budget CRUD
    // ---------------------------------------------------------------

    #[test]
    fn test_budget_crud() {
        let s = setup();
        s.create_currency(&make_currency("USD", "US Dollar", 2, true)).unwrap();

        let budget = Budget {
            id: Uuid::now_v7(),
            account_pattern: "Expenses:Food".to_string(),
            period_type: "monthly".to_string(),
            amount: dec!(500),
            currency: "USD".to_string(),
            currency_asset_type: String::new(),
            currency_param: String::new(),
            start_date: Some(make_date(2024, 1, 1)),
            end_date: None,
            created_at: make_date(2024, 1, 1),
        };
        s.create_budget(&budget).unwrap();

        let budgets = s.list_budgets().unwrap();
        assert_eq!(budgets.len(), 1);
        assert_eq!(budgets[0].account_pattern, "Expenses:Food");
        assert_eq!(budgets[0].amount, dec!(500));

        // Update
        let mut updated = budget.clone();
        updated.amount = dec!(600);
        s.update_budget(&updated).unwrap();
        let budgets = s.list_budgets().unwrap();
        assert_eq!(budgets[0].amount, dec!(600));

        // Delete
        s.delete_budget(&budget.id).unwrap();
        let budgets = s.list_budgets().unwrap();
        assert!(budgets.is_empty());
    }

    // ---------------------------------------------------------------
    // 10. Reconciliation flow
    // ---------------------------------------------------------------

    #[test]
    fn test_reconciliation_flow() {
        let s = setup();
        s.create_currency(&make_currency("USD", "US Dollar", 2, true)).unwrap();

        let bank = make_account(None, AccountType::Asset, "Bank", "Assets:Bank");
        let equity = make_account(None, AccountType::Equity, "Opening", "Equity:Opening");
        s.create_account(&bank).unwrap();
        s.create_account(&equity).unwrap();

        let entry = JournalEntry {
            id: Uuid::now_v7(),
            date: make_date(2024, 6, 1),
            description: "Deposit".to_string(),
            status: JournalEntryStatus::Confirmed,
            source: "manual".to_string(),
            voided_by: None,
            created_at: make_date(2024, 6, 1),
        };
        let items = vec![
            LineItem {
                id: Uuid::now_v7(),
                journal_entry_id: entry.id,
                account_id: bank.id,
                currency: "USD".to_string(),
                currency_asset_type: String::new(),
                currency_param: String::new(),
                amount: dec!(1000),
                lot_id: None,
            },
            LineItem {
                id: Uuid::now_v7(),
                journal_entry_id: entry.id,
                account_id: equity.id,
                currency: "USD".to_string(),
                currency_asset_type: String::new(),
                currency_param: String::new(),
                amount: dec!(-1000),
                lot_id: None,
            },
        ];
        s.insert_journal_entry(&entry, &items).unwrap();

        // Get unreconciled
        let unreconciled = s.get_unreconciled_line_items(&bank.id, "USD", None).unwrap();
        assert_eq!(unreconciled.len(), 1);
        assert_eq!(unreconciled[0].amount, dec!(1000));

        // Mark reconciled
        let rec = Reconciliation {
            id: Uuid::now_v7(),
            account_id: bank.id,
            statement_date: make_date(2024, 6, 30),
            statement_balance: dec!(1000),
            currency: "USD".to_string(),
            reconciled_at: make_date(2024, 7, 1),
            line_item_count: 1,
        };
        s.mark_reconciled(&rec, &[items[0].id]).unwrap();

        // Now unreconciled should be empty
        let unreconciled = s.get_unreconciled_line_items(&bank.id, "USD", None).unwrap();
        assert!(unreconciled.is_empty());

        // List reconciliations
        let recs = s.list_reconciliations(Some(&bank.id)).unwrap();
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].statement_balance, dec!(1000));

        // Get detail
        let detail = s.get_reconciliation_detail(&rec.id).unwrap().unwrap();
        assert_eq!(detail.1.len(), 1);
        assert_eq!(detail.1[0], items[0].id);
    }

    // ---------------------------------------------------------------
    // 11. Recurring template CRUD
    // ---------------------------------------------------------------

    #[test]
    fn test_recurring_template_crud() {
        let s = setup();

        let template = RecurringTemplate {
            id: Uuid::now_v7(),
            description: "Monthly rent".to_string(),
            frequency: "monthly".to_string(),
            interval: 1,
            next_date: make_date(2024, 2, 1),
            end_date: None,
            is_active: true,
            line_items_json: r#"[{"account_id":"a","currency":"USD","amount":"1500"}]"#.to_string(),
            created_at: make_date(2024, 1, 1),
        };
        s.create_recurring_template(&template).unwrap();

        let templates = s.list_recurring_templates().unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0].description, "Monthly rent");

        // Update
        let mut updated = template.clone();
        updated.description = "Monthly rent (updated)".to_string();
        updated.next_date = make_date(2024, 3, 1);
        s.update_recurring_template(&updated).unwrap();
        let templates = s.list_recurring_templates().unwrap();
        assert_eq!(templates[0].description, "Monthly rent (updated)");

        // Delete
        s.delete_recurring_template(&template.id).unwrap();
        let templates = s.list_recurring_templates().unwrap();
        assert!(templates.is_empty());
    }

    // ---------------------------------------------------------------
    // 12. Count journal entries
    // ---------------------------------------------------------------

    #[test]
    fn test_count_journal_entries() {
        let s = setup();
        let (asset_id, expense_id) = seed_accounts_and_currency(&s);

        for i in 1..=3u32 {
            let eid = Uuid::now_v7();
            let entry = JournalEntry {
                id: eid,
                date: make_date(2024, 1, i),
                description: format!("Entry {i}"),
                status: JournalEntryStatus::Confirmed,
                source: "manual".to_string(),
                voided_by: None,
                created_at: make_date(2024, 1, i),
            };
            let items = vec![
                LineItem {
                    id: Uuid::now_v7(),
                    journal_entry_id: eid,
                    account_id: expense_id,
                    currency: "USD".to_string(),
                    currency_asset_type: String::new(),
                    currency_param: String::new(),
                    amount: dec!(100),
                    lot_id: None,
                },
                LineItem {
                    id: Uuid::now_v7(),
                    journal_entry_id: eid,
                    account_id: asset_id,
                    currency: "USD".to_string(),
                    currency_asset_type: String::new(),
                    currency_param: String::new(),
                    amount: dec!(-100),
                    lot_id: None,
                },
            ];
            s.insert_journal_entry(&entry, &items).unwrap();
        }

        // Count all
        let count = s.count_journal_entries(&TransactionFilter::default()).unwrap();
        assert_eq!(count, 3);

        // Count with date filter
        let filtered = s.count_journal_entries(&TransactionFilter {
            from_date: Some(make_date(2024, 1, 2)),
            to_date: Some(make_date(2024, 1, 3)),
            ..Default::default()
        }).unwrap();
        assert_eq!(filtered, 2);
    }

    // ---------------------------------------------------------------
    // 13. Schema migrations v7 → v11
    // ---------------------------------------------------------------

    #[test]
    fn test_migrations_v7_to_v10() {
        let storage = SqliteStorage::new_in_memory().unwrap();
        storage.execute_sql("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);").unwrap();
        storage.execute_sql(SCHEMA_SQL).unwrap();
        // Set version to 7 (simulating a pre-v8 database)
        storage.execute_sql("DELETE FROM schema_version").unwrap();
        storage.execute_sql("INSERT INTO schema_version (version) VALUES (7)").unwrap();

        apply_migrations(&storage).unwrap();

        assert_eq!(storage.get_schema_version().unwrap(), SCHEMA_VERSION);

        // Verify budget table exists
        storage.execute_sql("INSERT INTO budget (id, account_pattern, amount, currency, created_at) VALUES ('test', 'Expenses:*', '100', 'USD', '2024-01-01')").unwrap();

        // Verify reconciliation tables exist
        storage.execute_sql("INSERT INTO reconciliation (id, account_id, statement_date, statement_balance, currency, reconciled_at) VALUES ('test', 'acc', '2024-01-01', '100', 'USD', '2024-01-01')").unwrap();

        // Verify recurring_template table exists
        storage.execute_sql("INSERT INTO recurring_template (id, description, frequency, next_date, created_at) VALUES ('test', 'test', 'monthly', '2024-01-01', '2024-01-01')").unwrap();

        // Verify exchange_account table exists with passphrase column (v13)
        storage.execute_sql("INSERT INTO exchange_account (id, exchange, label, api_key, api_secret, passphrase, created_at) VALUES ('test', 'binance', 'My Binance', 'key', 'secret', 'pass', '2024-01-01')").unwrap();

        // Verify currency_token_address table exists (v17 has composite PK with asset_type, param)
        storage.execute_sql("INSERT INTO currency_token_address (currency, asset_type, param, chain, contract_address) VALUES ('USDC', '', '', 'ethereum', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')").unwrap();

        // Verify entry_link table exists (v16)
        storage.execute_sql("INSERT INTO journal_entry (id, date, description, status, source, created_at) VALUES ('test-je', '2024-01-01', 'test', 'confirmed', 'manual', '2024-01-01')").unwrap();
        storage.execute_sql("INSERT INTO entry_link (journal_entry_id, link_name) VALUES ('test-je', 'test-link')").unwrap();
    }
}
