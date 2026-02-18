use std::cell::RefCell;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};

use chrono::NaiveDate;
use rust_decimal::Decimal;
use rusqlite::{params, Connection};
use uuid::Uuid;

static SAVEPOINT_COUNTER: AtomicU64 = AtomicU64::new(0);

use dledger_core::models::*;
use dledger_core::schema::{MIGRATION_V2, SCHEMA_SQL, SCHEMA_VERSION};
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

/// Source priority: manual (3) > ledger-file (2) > API (1).
fn source_priority(source: &str) -> u8 {
    match source {
        "manual" => 3,
        "ledger-file" => 2,
        _ => 1,
    }
}

impl Storage for SqliteStorage {
    // -- Currency --

    fn create_currency(&self, currency: &Currency) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO currency (code, name, decimal_places, is_base) VALUES (?1, ?2, ?3, ?4)",
            params![
                currency.code,
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
            .prepare("SELECT code, name, decimal_places, is_base FROM currency WHERE code = ?1")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let result = stmt
            .query_row(params![code], |row| {
                Ok(Currency {
                    code: row.get(0)?,
                    name: row.get(1)?,
                    decimal_places: row.get::<_, u8>(2)?,
                    is_base: row.get::<_, i32>(3)? != 0,
                })
            })
            .optional()
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(result)
    }

    fn list_currencies(&self) -> StorageResult<Vec<Currency>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare("SELECT code, name, decimal_places, is_base FROM currency ORDER BY code")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Currency {
                    code: row.get(0)?,
                    name: row.get(1)?,
                    decimal_places: row.get::<_, u8>(2)?,
                    is_base: row.get::<_, i32>(3)? != 0,
                })
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| StorageError::Internal(e.to_string()))
    }

    // -- Accounts --

    fn create_account(&self, account: &Account) -> StorageResult<()> {
        let allowed_json =
            serde_json::to_string(&account.allowed_currencies).unwrap_or_else(|_| "[]".to_string());
        {
            let conn = self.conn.borrow();
            conn.execute(
                "INSERT INTO account (id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
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
                        is_postable, is_archived, created_at
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
                        is_postable, is_archived, created_at
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
                        is_postable, is_archived, created_at
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
                "INSERT INTO line_item (id, journal_entry_id, account_id, currency, amount, lot_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    item.id.to_string(),
                    item.journal_entry_id.to_string(),
                    item.account_id.to_string(),
                    item.currency,
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

        if filter.account_id.is_some() {
            sql.push_str(" JOIN line_item li ON li.journal_entry_id = je.id");
        }

        if let Some(ref account_id) = filter.account_id {
            param_values.push(account_id.to_string());
            conditions.push(format!("li.account_id = ?{}", param_values.len()));
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

        if !conditions.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&conditions.join(" AND "));
        }

        sql.push_str(" ORDER BY je.date DESC, je.created_at DESC");

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
            "INSERT INTO lot (id, account_id, currency, acquired_date, original_quantity,
                              remaining_quantity, cost_basis_per_unit, cost_basis_currency,
                              journal_entry_id, is_closed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                lot.id.to_string(),
                lot.account_id.to_string(),
                lot.currency,
                lot.acquired_date.format("%Y-%m-%d").to_string(),
                lot.original_quantity.to_string(),
                lot.remaining_quantity.to_string(),
                lot.cost_basis_per_unit.to_string(),
                lot.cost_basis_currency,
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
                "SELECT id, account_id, currency, acquired_date, original_quantity,
                        remaining_quantity, cost_basis_per_unit, cost_basis_currency,
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
                "SELECT id, account_id, currency, acquired_date, original_quantity,
                        remaining_quantity, cost_basis_per_unit, cost_basis_currency,
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
                                       realized_gain_loss, disposal_date)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                disposal.id.to_string(),
                disposal.lot_id.to_string(),
                disposal.journal_entry_id.to_string(),
                disposal.quantity.to_string(),
                disposal.proceeds_per_unit.to_string(),
                disposal.proceeds_currency,
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
            "INSERT INTO exchange_rate (id, date, from_currency, to_currency, rate, source)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                rate.id.to_string(),
                date_str,
                rate.from_currency,
                rate.to_currency,
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

        match inv_result {
            Some(s) => {
                let rate = parse_decimal(&s)?;
                if rate.is_zero() {
                    Ok(None)
                } else {
                    Ok(Some(Decimal::ONE / rate))
                }
            }
            None => Ok(None),
        }
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
            "SELECT id, date, from_currency, to_currency, rate, source FROM exchange_rate",
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
            "INSERT INTO balance_assertion (id, account_id, date, currency, expected_balance, is_passing, actual_balance)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                assertion.id.to_string(),
                assertion.account_id.to_string(),
                assertion.date.format("%Y-%m-%d").to_string(),
                assertion.currency,
                assertion.expected_balance.to_string(),
                assertion.is_passing as i32,
                assertion.actual_balance.map(|d| d.to_string()),
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
                "SELECT id, account_id, date, currency, expected_balance, is_passing, actual_balance
                 FROM balance_assertion WHERE account_id = ?1 ORDER BY date",
                Some(id.to_string()),
            ),
            None => (
                "SELECT id, account_id, date, currency, expected_balance, is_passing, actual_balance
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
             DELETE FROM lot_disposal;
             DELETE FROM lot;
             DELETE FROM line_item;
             DELETE FROM journal_entry_metadata;
             DELETE FROM balance_assertion;
             DELETE FROM audit_log;
             DELETE FROM journal_entry;
             DELETE FROM account_closure;
             DELETE FROM account;
             DELETE FROM currency;
             PRAGMA foreign_keys=ON;",
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn clear_all_data(&self) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute_batch(
            "DELETE FROM lot_disposal;
             DELETE FROM lot;
             DELETE FROM line_item;
             DELETE FROM journal_entry_metadata;
             DELETE FROM balance_assertion;
             DELETE FROM audit_log;
             DELETE FROM journal_entry;
             DELETE FROM exchange_rate;
             DELETE FROM account_closure;
             DELETE FROM account;
             DELETE FROM currency;",
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
    let amount_str: String = row
        .get(4)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let lot_id_str: Option<String> = row
        .get(5)
        .map_err(|e| StorageError::Internal(e.to_string()))?;

    Ok(LineItem {
        id: parse_uuid(&id_str)?,
        journal_entry_id: parse_uuid(&je_id_str)?,
        account_id: parse_uuid(&account_id_str)?,
        currency,
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
    let acquired_date_str: String = row
        .get(3)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let original_quantity_str: String = row
        .get(4)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let remaining_quantity_str: String = row
        .get(5)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let cost_basis_str: String = row
        .get(6)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let cost_basis_currency: String = row
        .get(7)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let je_id_str: String = row
        .get(8)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let is_closed: i32 = row
        .get(9)
        .map_err(|e| StorageError::Internal(e.to_string()))?;

    Ok(Lot {
        id: parse_uuid(&id_str)?,
        account_id: parse_uuid(&account_id_str)?,
        currency,
        acquired_date: parse_date(&acquired_date_str)?,
        original_quantity: parse_decimal(&original_quantity_str)?,
        remaining_quantity: parse_decimal(&remaining_quantity_str)?,
        cost_basis_per_unit: parse_decimal(&cost_basis_str)?,
        cost_basis_currency,
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
    let gain_loss_str: String = row
        .get(6)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let disposal_date_str: String = row
        .get(7)
        .map_err(|e| StorageError::Internal(e.to_string()))?;

    Ok(LotDisposal {
        id: parse_uuid(&id_str)?,
        lot_id: parse_uuid(&lot_id_str)?,
        journal_entry_id: parse_uuid(&je_id_str)?,
        quantity: parse_decimal(&quantity_str)?,
        proceeds_per_unit: parse_decimal(&proceeds_str)?,
        proceeds_currency,
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
    let to_currency: String = row
        .get(3)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let rate_str: String = row
        .get(4)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let source: String = row
        .get(5)
        .map_err(|e| StorageError::Internal(e.to_string()))?;

    Ok(ExchangeRate {
        id: parse_uuid(&id_str)?,
        date: parse_date(&date_str)?,
        from_currency,
        to_currency,
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
    let expected_str: String = row
        .get(4)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let is_passing: i32 = row
        .get(5)
        .map_err(|e| StorageError::Internal(e.to_string()))?;
    let actual_str: Option<String> = row
        .get(6)
        .map_err(|e| StorageError::Internal(e.to_string()))?;

    Ok(BalanceAssertion {
        id: parse_uuid(&id_str)?,
        account_id: parse_uuid(&account_id_str)?,
        date: parse_date(&date_str)?,
        currency,
        expected_balance: parse_decimal(&expected_str)?,
        is_passing: is_passing != 0,
        actual_balance: actual_str
            .as_deref()
            .map(parse_decimal)
            .transpose()?,
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

fn fetch_line_items_for_entry(
    conn: &Connection,
    entry_id: &Uuid,
) -> StorageResult<Vec<LineItem>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, journal_entry_id, account_id, currency, amount, lot_id
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
