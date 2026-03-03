use std::cell::RefCell;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};

use chrono::NaiveDate;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use dledger_core::models::*;
use dledger_core::schema::{SCHEMA_SQL, SCHEMA_VERSION};
use dledger_core::storage::*;
use dledger_core::{LedgerEngine, LotCostInfo};

// ============================================================================
// In-memory SQLite Storage for testing
// (Duplicated from src-tauri/src/db.rs to keep dledger-core's test deps minimal)
// ============================================================================

static SAVEPOINT_COUNTER: AtomicU64 = AtomicU64::new(0);

struct TestStorage {
    conn: RefCell<Connection>,
}

unsafe impl Send for TestStorage {}
unsafe impl Sync for TestStorage {}

impl TestStorage {
    fn new_in_memory() -> Self {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        // Insert schema version
        conn.execute("INSERT INTO schema_version (version) VALUES (?1)", params![SCHEMA_VERSION]).unwrap();
        Self { conn: RefCell::new(conn) }
    }

    fn insert_closure_entries(&self, account_id: &Uuid, parent_id: Option<&Uuid>) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO account_closure (ancestor_id, descendant_id, depth) VALUES (?1, ?2, 0)",
            params![account_id.to_string(), account_id.to_string()],
        ).map_err(|e| StorageError::Internal(e.to_string()))?;

        if let Some(pid) = parent_id {
            conn.execute(
                "INSERT INTO account_closure (ancestor_id, descendant_id, depth)
                 SELECT ancestor_id, ?1, depth + 1
                 FROM account_closure WHERE descendant_id = ?2",
                params![account_id.to_string(), pid.to_string()],
            ).map_err(|e| StorageError::Internal(e.to_string()))?;
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
    AccountType::from_str(s).ok_or_else(|| StorageError::Internal(format!("invalid type: {s}")))
}

fn parse_entry_status(s: &str) -> StorageResult<JournalEntryStatus> {
    JournalEntryStatus::from_str(s).ok_or_else(|| StorageError::Internal(format!("invalid status: {s}")))
}

impl Storage for TestStorage {
    fn create_currency(&self, currency: &Currency) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO currency (code, name, decimal_places, is_base) VALUES (?1, ?2, ?3, ?4)",
            params![currency.code, currency.name, currency.decimal_places, currency.is_base as i32],
        ).map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn get_currency(&self, code: &str) -> StorageResult<Option<Currency>> {
        let conn = self.conn.borrow();
        let r = conn.query_row(
            "SELECT code, name, decimal_places, is_base FROM currency WHERE code = ?1",
            params![code],
            |row| Ok(Currency {
                code: row.get(0)?,
                asset_type: String::new(),
                param: String::new(),
                name: row.get(1)?,
                decimal_places: row.get::<_, u8>(2)?,
                is_base: row.get::<_, i32>(3)? != 0,
            }),
        ).optional().map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(r)
    }

    fn list_currencies(&self) -> StorageResult<Vec<Currency>> {
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare("SELECT code, name, decimal_places, is_base FROM currency ORDER BY code")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt.query_map([], |row| Ok(Currency {
            code: row.get(0)?,
            asset_type: String::new(),
            param: String::new(),
            name: row.get(1)?,
            decimal_places: row.get::<_, u8>(2)?,
            is_base: row.get::<_, i32>(3)? != 0,
        })).map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| StorageError::Internal(e.to_string()))
    }

    fn set_currency_asset_type(&self, code: &str, asset_type: &str, param: &str) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "UPDATE currency SET asset_type = ? WHERE code = ? AND param = ?",
            params![asset_type, code, param],
        ).map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn create_account(&self, account: &Account) -> StorageResult<()> {
        let allowed = serde_json::to_string(&account.allowed_currencies).unwrap_or_else(|_| "[]".into());
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
                    allowed,
                    account.is_postable as i32,
                    account.is_archived as i32,
                    account.created_at.format("%Y-%m-%d").to_string(),
                ],
            ).map_err(|e| StorageError::Internal(e.to_string()))?;
        }
        self.insert_closure_entries(&account.id, account.parent_id.as_ref())?;
        Ok(())
    }

    fn get_account(&self, id: &Uuid) -> StorageResult<Option<Account>> {
        let conn = self.conn.borrow();
        let r = conn.query_row(
            "SELECT id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at FROM account WHERE id = ?1",
            params![id.to_string()],
            |row| {
                let id_s: String = row.get(0)?;
                let pid_s: Option<String> = row.get(1)?;
                let at_s: String = row.get(2)?;
                let name: String = row.get(3)?;
                let full_name: String = row.get(4)?;
                let ac_s: String = row.get(5)?;
                let ip: i32 = row.get(6)?;
                let ia: i32 = row.get(7)?;
                let ca_s: String = row.get(8)?;
                Ok((id_s, pid_s, at_s, name, full_name, ac_s, ip, ia, ca_s))
            },
        ).optional().map_err(|e| StorageError::Internal(e.to_string()))?;
        match r {
            None => Ok(None),
            Some((id_s, pid_s, at_s, name, full_name, ac_s, ip, ia, ca_s)) => {
                Ok(Some(Account {
                    id: parse_uuid(&id_s)?,
                    parent_id: pid_s.as_deref().map(parse_uuid).transpose()?,
                    account_type: parse_account_type(&at_s)?,
                    name,
                    full_name,
                    allowed_currencies: serde_json::from_str(&ac_s).unwrap_or_default(),
                    is_postable: ip != 0,
                    is_archived: ia != 0,
                    created_at: parse_date(&ca_s)?,
                    opened_at: None,
                }))
            }
        }
    }

    fn get_account_by_full_name(&self, full_name: &str) -> StorageResult<Option<Account>> {
        let conn = self.conn.borrow();
        let r = conn.query_row(
            "SELECT id FROM account WHERE full_name = ?1",
            params![full_name],
            |row| row.get::<_, String>(0),
        ).optional().map_err(|e| StorageError::Internal(e.to_string()))?;
        match r {
            None => Ok(None),
            Some(id_s) => self.get_account(&parse_uuid(&id_s)?),
        }
    }

    fn list_accounts(&self) -> StorageResult<Vec<Account>> {
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare(
            "SELECT id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at FROM account ORDER BY full_name"
        ).map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt.query_map([], |row| {
            let id_s: String = row.get(0)?;
            let pid_s: Option<String> = row.get(1)?;
            let at_s: String = row.get(2)?;
            let name: String = row.get(3)?;
            let full_name: String = row.get(4)?;
            let ac_s: String = row.get(5)?;
            let ip: i32 = row.get(6)?;
            let ia: i32 = row.get(7)?;
            let ca_s: String = row.get(8)?;
            Ok((id_s, pid_s, at_s, name, full_name, ac_s, ip, ia, ca_s))
        }).map_err(|e| StorageError::Internal(e.to_string()))?;

        let mut accounts = Vec::new();
        for r in rows {
            let (id_s, pid_s, at_s, name, full_name, ac_s, ip, ia, ca_s) =
                r.map_err(|e| StorageError::Internal(e.to_string()))?;
            accounts.push(Account {
                id: parse_uuid(&id_s)?,
                parent_id: pid_s.as_deref().map(parse_uuid).transpose()?,
                account_type: parse_account_type(&at_s)?,
                name,
                full_name,
                allowed_currencies: serde_json::from_str(&ac_s).unwrap_or_default(),
                is_postable: ip != 0,
                is_archived: ia != 0,
                created_at: parse_date(&ca_s)?,
                opened_at: None,
            });
        }
        Ok(accounts)
    }

    fn update_account_archived(&self, id: &Uuid, is_archived: bool) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute("UPDATE account SET is_archived = ?1 WHERE id = ?2", params![is_archived as i32, id.to_string()])
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn update_account_opened_at(&self, id: &Uuid, opened_at: Option<NaiveDate>) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "UPDATE account SET opened_at = ?1 WHERE id = ?2",
            params![opened_at.map(|d| d.format("%Y-%m-%d").to_string()), id.to_string()],
        ).map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn get_account_subtree_ids(&self, id: &Uuid) -> StorageResult<Vec<Uuid>> {
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare("SELECT descendant_id FROM account_closure WHERE ancestor_id = ?1 ORDER BY depth")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt.query_map(params![id.to_string()], |row| row.get::<_, String>(0))
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.map(|r| {
            let s = r.map_err(|e| StorageError::Internal(e.to_string()))?;
            parse_uuid(&s)
        }).collect()
    }

    fn insert_journal_entry(&self, entry: &JournalEntry, items: &[LineItem]) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO journal_entry (id, date, description, status, source, voided_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                entry.id.to_string(),
                entry.date.format("%Y-%m-%d").to_string(),
                entry.description,
                entry.status.as_str(),
                entry.source,
                entry.voided_by.map(|id| id.to_string()),
                entry.created_at.format("%Y-%m-%d").to_string(),
            ],
        ).map_err(|e| StorageError::Internal(e.to_string()))?;

        for item in items {
            conn.execute(
                "INSERT INTO line_item (id, journal_entry_id, account_id, currency, amount, lot_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    item.id.to_string(),
                    item.journal_entry_id.to_string(),
                    item.account_id.to_string(),
                    item.currency,
                    item.amount.to_string(),
                    item.lot_id.map(|id| id.to_string()),
                ],
            ).map_err(|e| StorageError::Internal(e.to_string()))?;
        }
        Ok(())
    }

    fn get_journal_entry(&self, id: &Uuid) -> StorageResult<Option<(JournalEntry, Vec<LineItem>)>> {
        let conn = self.conn.borrow();
        let entry = conn.query_row(
            "SELECT id, date, description, status, source, voided_by, created_at FROM journal_entry WHERE id = ?1",
            params![id.to_string()],
            |row| {
                let id_s: String = row.get(0)?;
                let d: String = row.get(1)?;
                let desc: String = row.get(2)?;
                let st: String = row.get(3)?;
                let src: String = row.get(4)?;
                let vb: Option<String> = row.get(5)?;
                let ca: String = row.get(6)?;
                Ok((id_s, d, desc, st, src, vb, ca))
            },
        ).optional().map_err(|e| StorageError::Internal(e.to_string()))?;

        match entry {
            None => Ok(None),
            Some((id_s, d, desc, st, src, vb, ca)) => {
                let je = JournalEntry {
                    id: parse_uuid(&id_s)?,
                    date: parse_date(&d)?,
                    description: desc,
                    status: parse_entry_status(&st)?,
                    source: src,
                    voided_by: vb.as_deref().map(parse_uuid).transpose()?,
                    created_at: parse_date(&ca)?,
                };
                let mut stmt = conn.prepare(
                    "SELECT id, journal_entry_id, account_id, currency, amount, lot_id FROM line_item WHERE journal_entry_id = ?1"
                ).map_err(|e| StorageError::Internal(e.to_string()))?;
                let rows = stmt.query_map(params![id.to_string()], |row| {
                    let i: String = row.get(0)?;
                    let ji: String = row.get(1)?;
                    let ai: String = row.get(2)?;
                    let c: String = row.get(3)?;
                    let a: String = row.get(4)?;
                    let li: Option<String> = row.get(5)?;
                    Ok((i, ji, ai, c, a, li))
                }).map_err(|e| StorageError::Internal(e.to_string()))?;
                let mut items = Vec::new();
                for r in rows {
                    let (i, ji, ai, c, a, li) = r.map_err(|e| StorageError::Internal(e.to_string()))?;
                    items.push(LineItem {
                        id: parse_uuid(&i)?,
                        journal_entry_id: parse_uuid(&ji)?,
                        account_id: parse_uuid(&ai)?,
                        currency: c,
                        currency_asset_type: String::new(),
                        currency_param: String::new(),
                        amount: parse_decimal(&a)?,
                        lot_id: li.as_deref().map(parse_uuid).transpose()?,
                    });
                }
                Ok(Some((je, items)))
            }
        }
    }

    fn query_journal_entries(&self, filter: &TransactionFilter) -> StorageResult<Vec<(JournalEntry, Vec<LineItem>)>> {
        // Simplified: just get all non-voided entries ordered by date
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare("SELECT id FROM journal_entry ORDER BY date DESC")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let ids: Vec<String> = stmt.query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| StorageError::Internal(e.to_string()))?
            .collect::<Result<_, _>>()
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        drop(stmt);
        drop(conn);

        let mut results = Vec::new();
        for id_s in ids {
            let id = parse_uuid(&id_s)?;
            if let Some(entry) = self.get_journal_entry(&id)? {
                results.push(entry);
            }
        }
        Ok(results)
    }

    fn update_journal_entry_status(&self, id: &Uuid, status: JournalEntryStatus, voided_by: Option<Uuid>) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "UPDATE journal_entry SET status = ?1, voided_by = ?2 WHERE id = ?3",
            params![status.as_str(), voided_by.map(|id| id.to_string()), id.to_string()],
        ).map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn insert_lot(&self, lot: &Lot) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO lot (id, account_id, currency, acquired_date, original_quantity, remaining_quantity, cost_basis_per_unit, cost_basis_currency, journal_entry_id, is_closed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                lot.id.to_string(), lot.account_id.to_string(), lot.currency,
                lot.acquired_date.format("%Y-%m-%d").to_string(),
                lot.original_quantity.to_string(), lot.remaining_quantity.to_string(),
                lot.cost_basis_per_unit.to_string(), lot.cost_basis_currency,
                lot.journal_entry_id.to_string(), lot.is_closed as i32,
            ],
        ).map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn get_lot(&self, id: &Uuid) -> StorageResult<Option<Lot>> {
        let conn = self.conn.borrow();
        let r = conn.query_row(
            "SELECT id, account_id, currency, acquired_date, original_quantity, remaining_quantity, cost_basis_per_unit, cost_basis_currency, journal_entry_id, is_closed FROM lot WHERE id = ?1",
            params![id.to_string()],
            |row| {
                let ids: String = row.get(0)?;
                let ai: String = row.get(1)?;
                let c: String = row.get(2)?;
                let ad: String = row.get(3)?;
                let oq: String = row.get(4)?;
                let rq: String = row.get(5)?;
                let cb: String = row.get(6)?;
                let cbc: String = row.get(7)?;
                let ji: String = row.get(8)?;
                let ic: i32 = row.get(9)?;
                Ok((ids, ai, c, ad, oq, rq, cb, cbc, ji, ic))
            },
        ).optional().map_err(|e| StorageError::Internal(e.to_string()))?;
        match r {
            None => Ok(None),
            Some((ids, ai, c, ad, oq, rq, cb, cbc, ji, ic)) => Ok(Some(Lot {
                id: parse_uuid(&ids)?,
                account_id: parse_uuid(&ai)?,
                currency: c,
                currency_asset_type: String::new(),
                currency_param: String::new(),
                acquired_date: parse_date(&ad)?,
                original_quantity: parse_decimal(&oq)?,
                remaining_quantity: parse_decimal(&rq)?,
                cost_basis_per_unit: parse_decimal(&cb)?,
                cost_basis_currency: cbc,
                cost_basis_currency_asset_type: String::new(),
                cost_basis_currency_param: String::new(),
                journal_entry_id: parse_uuid(&ji)?,
                is_closed: ic != 0,
            })),
        }
    }

    fn get_open_lots_fifo(&self, account_id: &Uuid, currency: &str) -> StorageResult<Vec<Lot>> {
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare(
            "SELECT id, account_id, currency, acquired_date, original_quantity, remaining_quantity, cost_basis_per_unit, cost_basis_currency, journal_entry_id, is_closed
             FROM lot WHERE account_id = ?1 AND currency = ?2 AND is_closed = 0 ORDER BY acquired_date ASC"
        ).map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt.query_map(params![account_id.to_string(), currency], |row| {
            let ids: String = row.get(0)?;
            let ai: String = row.get(1)?;
            let c: String = row.get(2)?;
            let ad: String = row.get(3)?;
            let oq: String = row.get(4)?;
            let rq: String = row.get(5)?;
            let cb: String = row.get(6)?;
            let cbc: String = row.get(7)?;
            let ji: String = row.get(8)?;
            let ic: i32 = row.get(9)?;
            Ok((ids, ai, c, ad, oq, rq, cb, cbc, ji, ic))
        }).map_err(|e| StorageError::Internal(e.to_string()))?;

        let mut lots = Vec::new();
        for r in rows {
            let (ids, ai, c, ad, oq, rq, cb, cbc, ji, ic) = r.map_err(|e| StorageError::Internal(e.to_string()))?;
            lots.push(Lot {
                id: parse_uuid(&ids)?,
                account_id: parse_uuid(&ai)?,
                currency: c,
                currency_asset_type: String::new(),
                currency_param: String::new(),
                acquired_date: parse_date(&ad)?,
                original_quantity: parse_decimal(&oq)?,
                remaining_quantity: parse_decimal(&rq)?,
                cost_basis_per_unit: parse_decimal(&cb)?,
                cost_basis_currency: cbc,
                cost_basis_currency_asset_type: String::new(),
                cost_basis_currency_param: String::new(),
                journal_entry_id: parse_uuid(&ji)?,
                is_closed: ic != 0,
            });
        }
        Ok(lots)
    }

    fn update_lot_remaining(&self, id: &Uuid, remaining: Decimal, is_closed: bool) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute("UPDATE lot SET remaining_quantity = ?1, is_closed = ?2 WHERE id = ?3",
            params![remaining.to_string(), is_closed as i32, id.to_string()])
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn insert_lot_disposal(&self, disposal: &LotDisposal) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO lot_disposal (id, lot_id, journal_entry_id, quantity, proceeds_per_unit, proceeds_currency, realized_gain_loss, disposal_date)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                disposal.id.to_string(), disposal.lot_id.to_string(), disposal.journal_entry_id.to_string(),
                disposal.quantity.to_string(), disposal.proceeds_per_unit.to_string(), disposal.proceeds_currency,
                disposal.realized_gain_loss.to_string(), disposal.disposal_date.format("%Y-%m-%d").to_string(),
            ],
        ).map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn get_lot_disposals_for_period(&self, from_date: NaiveDate, to_date: NaiveDate) -> StorageResult<Vec<LotDisposal>> {
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare(
            "SELECT id, lot_id, journal_entry_id, quantity, proceeds_per_unit, proceeds_currency, realized_gain_loss, disposal_date
             FROM lot_disposal WHERE disposal_date >= ?1 AND disposal_date <= ?2 ORDER BY disposal_date ASC"
        ).map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt.query_map(params![
            from_date.format("%Y-%m-%d").to_string(),
            to_date.format("%Y-%m-%d").to_string(),
        ], |row| {
            let i: String = row.get(0)?;
            let li: String = row.get(1)?;
            let ji: String = row.get(2)?;
            let q: String = row.get(3)?;
            let pp: String = row.get(4)?;
            let pc: String = row.get(5)?;
            let gl: String = row.get(6)?;
            let dd: String = row.get(7)?;
            Ok((i, li, ji, q, pp, pc, gl, dd))
        }).map_err(|e| StorageError::Internal(e.to_string()))?;

        let mut disposals = Vec::new();
        for r in rows {
            let (i, li, ji, q, pp, pc, gl, dd) = r.map_err(|e| StorageError::Internal(e.to_string()))?;
            disposals.push(LotDisposal {
                id: parse_uuid(&i)?,
                lot_id: parse_uuid(&li)?,
                journal_entry_id: parse_uuid(&ji)?,
                quantity: parse_decimal(&q)?,
                proceeds_per_unit: parse_decimal(&pp)?,
                proceeds_currency: pc,
                proceeds_currency_asset_type: String::new(),
                proceeds_currency_param: String::new(),
                realized_gain_loss: parse_decimal(&gl)?,
                disposal_date: parse_date(&dd)?,
            });
        }
        Ok(disposals)
    }

    fn insert_exchange_rate(&self, rate: &ExchangeRate) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO exchange_rate (id, date, from_currency, to_currency, rate, source) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![rate.id.to_string(), rate.date.format("%Y-%m-%d").to_string(), rate.from_currency, rate.to_currency, rate.rate.to_string(), rate.source],
        ).map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn get_exchange_rate(&self, from: &str, to: &str, date: NaiveDate) -> StorageResult<Option<Decimal>> {
        let conn = self.conn.borrow();
        let r = conn.query_row(
            "SELECT rate FROM exchange_rate WHERE from_currency = ?1 AND to_currency = ?2 AND date <= ?3 ORDER BY date DESC LIMIT 1",
            params![from, to, date.format("%Y-%m-%d").to_string()],
            |row| row.get::<_, String>(0),
        ).optional().map_err(|e| StorageError::Internal(e.to_string()))?;
        match r {
            None => Ok(None),
            Some(s) => Ok(Some(parse_decimal(&s)?)),
        }
    }

    fn get_exchange_rate_source(&self, from: &str, to: &str, date: NaiveDate) -> StorageResult<Option<String>> {
        let conn = self.conn.borrow();
        let r = conn.query_row(
            "SELECT source FROM exchange_rate WHERE date = ?1 AND from_currency = ?2 AND to_currency = ?3",
            params![date.format("%Y-%m-%d").to_string(), from, to],
            |row| row.get::<_, String>(0),
        ).optional().map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(r)
    }

    fn list_exchange_rates(&self, from: Option<&str>, to: Option<&str>) -> StorageResult<Vec<ExchangeRate>> {
        let conn = self.conn.borrow();
        let mut sql = String::from("SELECT id, date, from_currency, to_currency, rate, source FROM exchange_rate");
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
        let mut stmt = conn.prepare(&sql).map_err(|e| StorageError::Internal(e.to_string()))?;
        let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |row| {
            Ok((|| -> StorageResult<ExchangeRate> {
                Ok(ExchangeRate {
                    id: parse_uuid(&row.get::<_, String>(0).map_err(|e| StorageError::Internal(e.to_string()))?)?,
                    date: parse_date(&row.get::<_, String>(1).map_err(|e| StorageError::Internal(e.to_string()))?)?,
                    from_currency: row.get::<_, String>(2).map_err(|e| StorageError::Internal(e.to_string()))?,
                    from_currency_asset_type: String::new(),
                    from_currency_param: String::new(),
                    to_currency: row.get::<_, String>(3).map_err(|e| StorageError::Internal(e.to_string()))?,
                    to_currency_asset_type: String::new(),
                    to_currency_param: String::new(),
                    rate: parse_decimal(&row.get::<_, String>(4).map_err(|e| StorageError::Internal(e.to_string()))?)?,
                    source: row.get::<_, String>(5).map_err(|e| StorageError::Internal(e.to_string()))?,
                })
            })())
        }).map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.map(|r| r.map_err(|e| StorageError::Internal(e.to_string()))?).collect()
    }

    fn get_exchange_rate_currencies_on_date(
        &self,
        date: NaiveDate,
    ) -> StorageResult<Vec<String>> {
        let conn = self.conn.borrow();
        let date_str = date.format("%Y-%m-%d").to_string();
        let mut stmt = conn
            .prepare("SELECT DISTINCT from_currency FROM exchange_rate WHERE date = ?1")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map(rusqlite::params![&date_str], |row| row.get::<_, String>(0))
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| StorageError::Internal(e.to_string()))?);
        }
        Ok(result)
    }

    fn sum_line_items(&self, account_ids: &[Uuid], before_date: Option<NaiveDate>) -> StorageResult<Vec<CurrencyBalance>> {
        if account_ids.is_empty() { return Ok(vec![]); }

        let placeholders: Vec<String> = (1..=account_ids.len()).map(|i| format!("?{i}")).collect();
        let mut sql = format!(
            "SELECT li.currency, li.amount FROM line_item li
             JOIN journal_entry je ON je.id = li.journal_entry_id
             WHERE li.account_id IN ({}) ",
            placeholders.join(", ")
        );
        let mut param_values: Vec<String> = account_ids.iter().map(|id| id.to_string()).collect();
        if let Some(ref date) = before_date {
            param_values.push(date.format("%Y-%m-%d").to_string());
            sql.push_str(&format!(" AND je.date < ?{}", param_values.len()));
        }

        let conn = self.conn.borrow();
        let mut stmt = conn.prepare(&sql).map_err(|e| StorageError::Internal(e.to_string()))?;
        let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }).map_err(|e| StorageError::Internal(e.to_string()))?;

        let mut totals: HashMap<String, Decimal> = HashMap::new();
        for row in rows {
            let (currency, amount_str) = row.map_err(|e| StorageError::Internal(e.to_string()))?;
            let amount = parse_decimal(&amount_str)?;
            *totals.entry(currency).or_default() += amount;
        }

        let mut balances: Vec<CurrencyBalance> = totals.into_iter()
            .map(|(currency, amount)| CurrencyBalance { currency, amount })
            .collect();
        balances.sort_by(|a, b| a.currency.cmp(&b.currency));
        Ok(balances)
    }

    fn insert_balance_assertion(&self, a: &BalanceAssertion) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO balance_assertion (id, account_id, date, currency, expected_balance, is_passing, actual_balance) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![a.id.to_string(), a.account_id.to_string(), a.date.format("%Y-%m-%d").to_string(), a.currency, a.expected_balance.to_string(), a.is_passing as i32, a.actual_balance.map(|d| d.to_string())],
        ).map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn update_balance_assertion_result(&self, id: &Uuid, is_passing: bool, actual: Decimal) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute("UPDATE balance_assertion SET is_passing = ?1, actual_balance = ?2 WHERE id = ?3",
            params![is_passing as i32, actual.to_string(), id.to_string()])
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn get_balance_assertions(&self, _account_id: Option<&Uuid>) -> StorageResult<Vec<BalanceAssertion>> {
        Ok(vec![]) // simplified for tests
    }

    fn insert_metadata(&self, journal_entry_id: &Uuid, key: &str, value: &str) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO journal_entry_metadata (journal_entry_id, key, value) VALUES (?1, ?2, ?3)",
            params![journal_entry_id.to_string(), key, value],
        ).map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn get_metadata(&self, journal_entry_id: &Uuid) -> StorageResult<Vec<Metadata>> {
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare("SELECT journal_entry_id, key, value FROM journal_entry_metadata WHERE journal_entry_id = ?1")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt.query_map(params![journal_entry_id.to_string()], |row| {
            let ji: String = row.get(0)?;
            let k: String = row.get(1)?;
            let v: String = row.get(2)?;
            Ok((ji, k, v))
        }).map_err(|e| StorageError::Internal(e.to_string()))?;
        let mut result = Vec::new();
        for r in rows {
            let (ji, k, v) = r.map_err(|e| StorageError::Internal(e.to_string()))?;
            result.push(Metadata { journal_entry_id: parse_uuid(&ji)?, key: k, value: v });
        }
        Ok(result)
    }

    fn insert_audit_log(&self, entry: &AuditLogEntry) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO audit_log (id, timestamp, action, entity_type, entity_id, details) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![entry.id.to_string(), entry.timestamp.format("%Y-%m-%d").to_string(), entry.action, entry.entity_type, entry.entity_id.to_string(), entry.details],
        ).map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn in_transaction(&self, f: &mut dyn FnMut(&dyn Storage) -> StorageResult<()>) -> StorageResult<()> {
        let id = SAVEPOINT_COUNTER.fetch_add(1, Ordering::Relaxed);
        let sp = format!("sp_{id}");
        { let c = self.conn.borrow(); c.execute_batch(&format!("SAVEPOINT {sp}")).map_err(|e| StorageError::Internal(e.to_string()))?; }
        match f(self) {
            Ok(()) => { let c = self.conn.borrow(); c.execute_batch(&format!("RELEASE {sp}")).map_err(|e| StorageError::Internal(e.to_string()))?; Ok(()) }
            Err(e) => { let c = self.conn.borrow(); let _ = c.execute_batch(&format!("ROLLBACK TO {sp}")); let _ = c.execute_batch(&format!("RELEASE {sp}")); Err(e) }
        }
    }

    fn execute_sql(&self, sql: &str) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute_batch(sql).map_err(|e| StorageError::Internal(e.to_string()))
    }

    fn get_schema_version(&self) -> StorageResult<u32> {
        let conn = self.conn.borrow();
        let r = conn.query_row("SELECT version FROM schema_version LIMIT 1", [], |row| row.get::<_, u32>(0))
            .optional().map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(r.unwrap_or(0))
    }

    fn set_schema_version(&self, version: u32) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute("DELETE FROM schema_version", []).map_err(|e| StorageError::Internal(e.to_string()))?;
        conn.execute("INSERT INTO schema_version (version) VALUES (?1)", params![version]).map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    // -- Hidden currencies --

    fn set_currency_hidden(&self, code: &str, is_hidden: bool) -> StorageResult<()> {
        let conn = self.conn.borrow();
        let affected = conn.execute(
            "UPDATE currency SET is_hidden = ?1 WHERE code = ?2",
            params![is_hidden as i32, code],
        ).map_err(|e| StorageError::Internal(e.to_string()))?;
        if affected == 0 {
            return Err(StorageError::NotFound(format!("currency {code}")));
        }
        Ok(())
    }

    fn list_hidden_currencies(&self) -> StorageResult<Vec<String>> {
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare("SELECT code FROM currency WHERE is_hidden = 1")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| StorageError::Internal(e.to_string()))
    }

    // -- Currency rate sources --

    fn get_currency_rate_sources(&self) -> StorageResult<Vec<CurrencyRateSource>> {
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare("SELECT currency, rate_source, set_by FROM currency_rate_source")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt.query_map([], |row| {
            Ok(CurrencyRateSource {
                currency: row.get(0)?,
                asset_type: String::new(),
                param: String::new(),
                rate_source: row.get(1)?,
                set_by: row.get(2)?,
            })
        }).map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| StorageError::Internal(e.to_string()))
    }

    fn set_currency_rate_source(&self, currency: &str, rate_source: &str, set_by: &str) -> StorageResult<()> {
        let conn = self.conn.borrow();
        let priority = match set_by {
            "user" => 3i32,
            s if s.starts_with("handler:") => 2,
            _ => 1,
        };
        conn.execute(
            "INSERT INTO currency_rate_source (currency, rate_source, set_by, updated_at)
             VALUES (?1, ?2, ?3, datetime('now'))
             ON CONFLICT(currency) DO UPDATE SET
               rate_source = CASE WHEN ?4 >= (CASE WHEN set_by = 'user' THEN 3 WHEN set_by LIKE 'handler:%' THEN 2 ELSE 1 END) THEN ?2 ELSE rate_source END,
               set_by = CASE WHEN ?4 >= (CASE WHEN set_by = 'user' THEN 3 WHEN set_by LIKE 'handler:%' THEN 2 ELSE 1 END) THEN ?3 ELSE set_by END,
               updated_at = CASE WHEN ?4 >= (CASE WHEN set_by = 'user' THEN 3 WHEN set_by LIKE 'handler:%' THEN 2 ELSE 1 END) THEN datetime('now') ELSE updated_at END",
            params![currency, rate_source, set_by, priority],
        ).map_err(|e| StorageError::Internal(e.to_string()))?;
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
        let count: u64 = conn.query_row(
            "SELECT COUNT(*) FROM line_item WHERE journal_entry_id NOT IN (SELECT id FROM journal_entry)",
            [],
            |row| row.get(0),
        ).map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(count)
    }

    fn count_duplicate_sources(&self) -> StorageResult<u64> {
        let conn = self.conn.borrow();
        let count: u64 = conn.query_row(
            "SELECT COUNT(*) FROM (SELECT source, COUNT(*) as cnt FROM journal_entry WHERE source IS NOT NULL AND source != '' AND status = 'posted' GROUP BY source HAVING cnt > 1)",
            [],
            |row| row.get(0),
        ).map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(count)
    }

    fn clear_exchange_rates(&self) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute_batch("DELETE FROM exchange_rate").map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn get_currency_origins(&self) -> StorageResult<Vec<CurrencyOrigin>> {
        let conn = self.conn.borrow();
        let mut stmt = conn.prepare(
            "SELECT DISTINCT li.currency,
               CASE WHEN je.source LIKE 'etherscan:%' THEN 'etherscan' ELSE je.source END AS origin
             FROM line_item li JOIN journal_entry je ON li.journal_entry_id = je.id
             WHERE je.status != 'voided'",
        ).map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }).map_err(|e| StorageError::Internal(e.to_string()))?;
        let mut results = Vec::new();
        for row in rows {
            let (currency, origin) = row.map_err(|e| StorageError::Internal(e.to_string()))?;
            results.push(CurrencyOrigin { currency, origin });
        }
        Ok(results)
    }

    fn clear_ledger_data(&self) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute_batch(
            "PRAGMA foreign_keys=OFF;
             DELETE FROM lot_disposal; DELETE FROM lot; DELETE FROM line_item;
             DELETE FROM journal_entry_metadata; DELETE FROM balance_assertion;
             DELETE FROM audit_log; DELETE FROM journal_entry;
             DELETE FROM account_closure; DELETE FROM account; DELETE FROM currency;
             DELETE FROM currency_rate_source;
             PRAGMA foreign_keys=ON;"
        ).map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn clear_all_data(&self) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute_batch(
            "DELETE FROM lot_disposal; DELETE FROM lot; DELETE FROM line_item;
             DELETE FROM journal_entry_metadata; DELETE FROM balance_assertion;
             DELETE FROM audit_log; DELETE FROM journal_entry; DELETE FROM exchange_rate;
             DELETE FROM account_closure; DELETE FROM account; DELETE FROM currency;
             DELETE FROM currency_rate_source;"
        ).map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn store_raw_transaction(&self, source: &str, data: &str) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT OR REPLACE INTO raw_transaction (source, data) VALUES (?1, ?2)",
            rusqlite::params![source, data],
        ).map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn get_raw_transaction(&self, source: &str) -> StorageResult<Option<String>> {
        let conn = self.conn.borrow();
        let result = conn
            .prepare("SELECT data FROM raw_transaction WHERE source = ?1")
            .map_err(|e| StorageError::Internal(e.to_string()))?
            .query_row(rusqlite::params![source], |row| row.get::<_, String>(0))
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
            .query_map(rusqlite::params![pattern], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| StorageError::Internal(e.to_string()))
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
            .query_map(rusqlite::params![key, value], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.map(|r| {
            let s = r.map_err(|e| StorageError::Internal(e.to_string()))?;
            parse_uuid(&s)
        })
        .collect()
    }

    // -- Entry links (stub) --
    fn set_entry_links(&self, _entry_id: &Uuid, _links: &[String]) -> StorageResult<()> { Ok(()) }
    fn get_entry_links(&self, _entry_id: &Uuid) -> StorageResult<Vec<String>> { Ok(vec![]) }
    fn get_entries_by_link(&self, _link_name: &str) -> StorageResult<Vec<Uuid>> { Ok(vec![]) }
    fn get_all_link_names(&self) -> StorageResult<Vec<String>> { Ok(vec![]) }
    fn get_all_links_with_counts(&self) -> StorageResult<Vec<(String, u64)>> { Ok(vec![]) }

    fn list_all_open_lots(&self) -> StorageResult<Vec<Lot>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare(
                "SELECT id, account_id, currency, acquired_date, original_quantity,
                        remaining_quantity, cost_basis_per_unit, cost_basis_currency,
                        journal_entry_id, is_closed
                 FROM lot
                 WHERE is_closed = 0 AND CAST(remaining_quantity AS REAL) > 0
                 ORDER BY currency, acquired_date",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                let id_str: String = row.get(0)?;
                let acc_str: String = row.get(1)?;
                let cur: String = row.get(2)?;
                let ad_str: String = row.get(3)?;
                let oq_str: String = row.get(4)?;
                let rq_str: String = row.get(5)?;
                let cb_str: String = row.get(6)?;
                let cbc: String = row.get(7)?;
                let je_str: String = row.get(8)?;
                let ic: i32 = row.get(9)?;
                Ok((id_str, acc_str, cur, ad_str, oq_str, rq_str, cb_str, cbc, je_str, ic))
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let mut result = Vec::new();
        for r in rows {
            let (id_str, acc_str, cur, ad_str, oq_str, rq_str, cb_str, cbc, je_str, ic) =
                r.map_err(|e| StorageError::Internal(e.to_string()))?;
            result.push(Lot {
                id: parse_uuid(&id_str)?,
                account_id: parse_uuid(&acc_str)?,
                currency: cur,
                currency_asset_type: String::new(),
                currency_param: String::new(),
                acquired_date: NaiveDate::parse_from_str(&ad_str, "%Y-%m-%d")
                    .map_err(|e| StorageError::Internal(e.to_string()))?,
                original_quantity: Decimal::from_str(&oq_str)
                    .map_err(|e| StorageError::Internal(e.to_string()))?,
                remaining_quantity: Decimal::from_str(&rq_str)
                    .map_err(|e| StorageError::Internal(e.to_string()))?,
                cost_basis_per_unit: Decimal::from_str(&cb_str)
                    .map_err(|e| StorageError::Internal(e.to_string()))?,
                cost_basis_currency: cbc,
                cost_basis_currency_asset_type: String::new(),
                cost_basis_currency_param: String::new(),
                journal_entry_id: parse_uuid(&je_str)?,
                is_closed: ic != 0,
            });
        }
        Ok(result)
    }

    // -- Budgets (stub) --
    fn create_budget(&self, _budget: &Budget) -> StorageResult<()> { Ok(()) }
    fn list_budgets(&self) -> StorageResult<Vec<Budget>> { Ok(vec![]) }
    fn update_budget(&self, _budget: &Budget) -> StorageResult<()> { Ok(()) }
    fn delete_budget(&self, _id: &Uuid) -> StorageResult<()> { Ok(()) }

    // -- Reconciliation (stub) --
    fn get_unreconciled_line_items(&self, _account_id: &Uuid, _currency: &str, _up_to_date: Option<NaiveDate>) -> StorageResult<Vec<UnreconciledLineItem>> { Ok(vec![]) }
    fn mark_reconciled(&self, _reconciliation: &Reconciliation, _line_item_ids: &[Uuid]) -> StorageResult<()> { Ok(()) }
    fn list_reconciliations(&self, _account_id: Option<&Uuid>) -> StorageResult<Vec<Reconciliation>> { Ok(vec![]) }
    fn get_reconciliation_detail(&self, _id: &Uuid) -> StorageResult<Option<(Reconciliation, Vec<Uuid>)>> { Ok(None) }

    // -- Recurring templates (stub) --
    fn create_recurring_template(&self, _template: &RecurringTemplate) -> StorageResult<()> { Ok(()) }
    fn list_recurring_templates(&self) -> StorageResult<Vec<RecurringTemplate>> { Ok(vec![]) }
    fn update_recurring_template(&self, _template: &RecurringTemplate) -> StorageResult<()> { Ok(()) }
    fn delete_recurring_template(&self, _id: &Uuid) -> StorageResult<()> { Ok(()) }

    // -- Pagination (stub) --
    fn count_journal_entries(&self, _filter: &TransactionFilter) -> StorageResult<u64> { Ok(0) }

    // -- Exchange accounts (stub) --
    fn list_exchange_accounts(&self) -> StorageResult<Vec<serde_json::Value>> { Ok(vec![]) }
    fn add_exchange_account(&self, _account: &serde_json::Value) -> StorageResult<()> { Ok(()) }
    fn update_exchange_account(&self, _id: &str, _updates: &serde_json::Value) -> StorageResult<()> { Ok(()) }
    fn remove_exchange_account(&self, _id: &str) -> StorageResult<()> { Ok(()) }

    fn set_currency_token_address(&self, _currency: &str, _chain: &str, _contract_address: &str) -> StorageResult<()> { Ok(()) }
    fn get_currency_token_addresses(&self) -> StorageResult<Vec<(String, String, String)>> { Ok(vec![]) }
    fn get_currency_token_address(&self, _currency: &str) -> StorageResult<Option<(String, String)>> { Ok(None) }
}

// ============================================================================
// Test helpers
// ============================================================================

fn date(y: i32, m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, d).unwrap()
}

fn new_engine() -> LedgerEngine {
    let storage = TestStorage::new_in_memory();
    LedgerEngine::new(Box::new(storage))
}

fn setup_currencies(engine: &LedgerEngine) {
    engine.create_currency(&Currency {
        code: "EUR".into(), asset_type: String::new(), param: String::new(), name: "Euro".into(), decimal_places: 2, is_base: true,
    }).unwrap();
    engine.create_currency(&Currency {
        code: "BTC".into(), asset_type: String::new(), param: String::new(), name: "Bitcoin".into(), decimal_places: 8, is_base: false,
    }).unwrap();
    engine.create_currency(&Currency {
        code: "ETH".into(), asset_type: String::new(), param: String::new(), name: "Ethereum".into(), decimal_places: 18, is_base: false,
    }).unwrap();
}

fn make_account(name: &str, full_name: &str, account_type: AccountType, parent_id: Option<Uuid>) -> Account {
    Account {
        id: Uuid::now_v7(),
        parent_id,
        account_type,
        name: name.into(),
        full_name: full_name.into(),
        allowed_currencies: vec![],
        is_postable: true,
        is_archived: false,
        created_at: date(2025, 1, 1),
        opened_at: None,
    }
}

fn make_entry(desc: &str, d: NaiveDate) -> JournalEntry {
    let id = Uuid::now_v7();
    JournalEntry {
        id,
        date: d,
        description: desc.into(),
        status: JournalEntryStatus::Confirmed,
        source: "manual".into(),
        voided_by: None,
        created_at: d,
    }
}

fn make_line(entry_id: Uuid, account_id: Uuid, currency: &str, amount: Decimal) -> LineItem {
    LineItem {
        id: Uuid::now_v7(),
        journal_entry_id: entry_id,
        account_id,
        currency: currency.into(),
        currency_asset_type: String::new(),
        currency_param: String::new(),
        amount,
        lot_id: None,
    }
}

// ============================================================================
// Tests
// ============================================================================

#[test]
fn test_create_and_list_currencies() {
    let engine = new_engine();
    setup_currencies(&engine);
    let currencies = engine.list_currencies().unwrap();
    assert_eq!(currencies.len(), 3);
    assert!(currencies.iter().any(|c| c.code == "EUR" && c.is_base));
    assert!(currencies.iter().any(|c| c.code == "BTC" && !c.is_base));
}

#[test]
fn test_create_and_list_accounts() {
    let engine = new_engine();
    let bank = make_account("Bank", "Assets:Bank", AccountType::Asset, None);
    let checking = make_account("Checking", "Assets:Bank:Checking", AccountType::Asset, Some(bank.id));
    engine.create_account(&bank).unwrap();
    engine.create_account(&checking).unwrap();
    let accounts = engine.list_accounts().unwrap();
    assert_eq!(accounts.len(), 2);
}

#[test]
fn test_account_hierarchy() {
    let engine = new_engine();
    let assets = make_account("Assets", "Assets", AccountType::Asset, None);
    let bank = make_account("Bank", "Assets:Bank", AccountType::Asset, Some(assets.id));
    let checking = make_account("Checking", "Assets:Bank:Checking", AccountType::Asset, Some(bank.id));

    engine.create_account(&assets).unwrap();
    engine.create_account(&bank).unwrap();
    engine.create_account(&checking).unwrap();

    // Assets subtree should include all three
    let subtree = engine.storage().get_account_subtree_ids(&assets.id).unwrap();
    assert_eq!(subtree.len(), 3);
    assert!(subtree.contains(&assets.id));
    assert!(subtree.contains(&bank.id));
    assert!(subtree.contains(&checking.id));

    // Bank subtree should include Bank and Checking
    let subtree = engine.storage().get_account_subtree_ids(&bank.id).unwrap();
    assert_eq!(subtree.len(), 2);
}

#[test]
fn test_post_balanced_entry() {
    let engine = new_engine();
    setup_currencies(&engine);

    let checking = make_account("Checking", "Assets:Checking", AccountType::Asset, None);
    let salary = make_account("Salary", "Revenue:Salary", AccountType::Revenue, None);
    engine.create_account(&checking).unwrap();
    engine.create_account(&salary).unwrap();

    let entry = make_entry("Monthly salary", date(2025, 1, 15));
    let items = vec![
        make_line(entry.id, checking.id, "EUR", dec!(3000)),
        make_line(entry.id, salary.id, "EUR", dec!(-3000)),
    ];

    engine.post_journal_entry(&entry, &items).unwrap();

    // Verify entry was stored
    let (stored, stored_items) = engine.get_journal_entry(&entry.id).unwrap().unwrap();
    assert_eq!(stored.description, "Monthly salary");
    assert_eq!(stored_items.len(), 2);
}

#[test]
fn test_reject_unbalanced_entry() {
    let engine = new_engine();
    setup_currencies(&engine);

    let checking = make_account("Checking", "Assets:Checking", AccountType::Asset, None);
    let salary = make_account("Salary", "Revenue:Salary", AccountType::Revenue, None);
    engine.create_account(&checking).unwrap();
    engine.create_account(&salary).unwrap();

    let entry = make_entry("Bad entry", date(2025, 1, 15));
    let items = vec![
        make_line(entry.id, checking.id, "EUR", dec!(3000)),
        make_line(entry.id, salary.id, "EUR", dec!(-2000)),
    ];

    let result = engine.post_journal_entry(&entry, &items);
    assert!(result.is_err());
}

#[test]
fn test_reject_nonexistent_account() {
    let engine = new_engine();
    setup_currencies(&engine);

    let fake_id = Uuid::now_v7();
    let real = make_account("Checking", "Assets:Checking", AccountType::Asset, None);
    engine.create_account(&real).unwrap();

    let entry = make_entry("Bad ref", date(2025, 1, 15));
    let items = vec![
        make_line(entry.id, real.id, "EUR", dec!(100)),
        make_line(entry.id, fake_id, "EUR", dec!(-100)),
    ];

    let result = engine.post_journal_entry(&entry, &items);
    assert!(result.is_err());
}

#[test]
fn test_account_balance() {
    let engine = new_engine();
    setup_currencies(&engine);

    let checking = make_account("Checking", "Assets:Checking", AccountType::Asset, None);
    let salary = make_account("Salary", "Revenue:Salary", AccountType::Revenue, None);
    let rent = make_account("Rent", "Expense:Rent", AccountType::Expense, None);
    engine.create_account(&checking).unwrap();
    engine.create_account(&salary).unwrap();
    engine.create_account(&rent).unwrap();

    // Receive salary
    let e1 = make_entry("Salary Jan", date(2025, 1, 15));
    engine.post_journal_entry(&e1, &[
        make_line(e1.id, checking.id, "EUR", dec!(3000)),
        make_line(e1.id, salary.id, "EUR", dec!(-3000)),
    ]).unwrap();

    // Pay rent
    let e2 = make_entry("Rent Jan", date(2025, 1, 20));
    engine.post_journal_entry(&e2, &[
        make_line(e2.id, checking.id, "EUR", dec!(-1000)),
        make_line(e2.id, rent.id, "EUR", dec!(1000)),
    ]).unwrap();

    let balance = engine.get_account_balance(&checking.id, None).unwrap();
    assert_eq!(balance.len(), 1);
    assert_eq!(balance[0].currency, "EUR");
    assert_eq!(balance[0].amount, dec!(2000));
}

#[test]
fn test_void_journal_entry() {
    let engine = new_engine();
    setup_currencies(&engine);

    let checking = make_account("Checking", "Assets:Checking", AccountType::Asset, None);
    let salary = make_account("Salary", "Revenue:Salary", AccountType::Revenue, None);
    engine.create_account(&checking).unwrap();
    engine.create_account(&salary).unwrap();

    let entry = make_entry("Salary", date(2025, 1, 15));
    engine.post_journal_entry(&entry, &[
        make_line(entry.id, checking.id, "EUR", dec!(3000)),
        make_line(entry.id, salary.id, "EUR", dec!(-3000)),
    ]).unwrap();

    // Balance should be 3000
    let balance = engine.get_account_balance(&checking.id, None).unwrap();
    assert_eq!(balance[0].amount, dec!(3000));

    // Void
    engine.void_journal_entry(&entry.id).unwrap();

    // Balance should be 0 (original is voided, reversal is net zero)
    let balance = engine.get_account_balance(&checking.id, None).unwrap();
    // After void: original (voided, excluded) + reversal (-3000 debit, +3000 credit)
    // Net = 0, so empty or zero
    let eur_balance = balance.iter().find(|b| b.currency == "EUR").map(|b| b.amount).unwrap_or_default();
    assert_eq!(eur_balance, dec!(0));
}

#[test]
fn test_void_already_voided_fails() {
    let engine = new_engine();
    setup_currencies(&engine);

    let checking = make_account("Checking", "Assets:Checking", AccountType::Asset, None);
    let salary = make_account("Salary", "Revenue:Salary", AccountType::Revenue, None);
    engine.create_account(&checking).unwrap();
    engine.create_account(&salary).unwrap();

    let entry = make_entry("Salary", date(2025, 1, 15));
    engine.post_journal_entry(&entry, &[
        make_line(entry.id, checking.id, "EUR", dec!(3000)),
        make_line(entry.id, salary.id, "EUR", dec!(-3000)),
    ]).unwrap();

    engine.void_journal_entry(&entry.id).unwrap();
    let result = engine.void_journal_entry(&entry.id);
    assert!(result.is_err());
}

#[test]
fn test_multi_currency_entry_with_lots() {
    let engine = new_engine();
    setup_currencies(&engine);

    let eur_bank = make_account("EUR Bank", "Assets:EUR Bank", AccountType::Asset, None);
    let btc_wallet = make_account("BTC Wallet", "Assets:BTC Wallet", AccountType::Asset, None);
    engine.create_account(&eur_bank).unwrap();
    engine.create_account(&btc_wallet).unwrap();

    // Buy 0.1 BTC for 5000 EUR (cost basis = 50000 EUR/BTC)
    let entry = make_entry("Buy BTC", date(2025, 1, 10));
    let items = vec![
        make_line(entry.id, btc_wallet.id, "BTC", dec!(0.1)),
        make_line(entry.id, btc_wallet.id, "EUR", dec!(-5000)),  // This won't work for balance per-currency
    ];
    // Actually, in double-entry, we need to balance each currency separately.
    // A multi-currency buy is:
    //   BTC Wallet +0.1 BTC (debit)
    //   EUR Bank -5000 EUR (credit)
    // These are different currencies, each balances within its own currency? No!
    // The convention: SUM per currency = 0. So we need:
    //   BTC +0.1, BTC -0.1 in BTC currency
    //   EUR +5000, EUR -5000 in EUR currency
    // But that's not how crypto purchases work.
    //
    // Actually, for multi-currency transactions, we need a different approach.
    // The entry balances per currency. A BTC purchase would be:
    //   Debit: Assets:BTC Wallet  0.1 BTC
    //   Credit: Assets:BTC Wallet -0.1 BTC  (wait, that makes no sense)
    //
    // The correct approach for multi-currency in Beancount-style:
    //   Assets:BTC Wallet  0.1 BTC {50000 EUR}
    //   Assets:EUR Bank   -5000 EUR
    // Total in BTC: +0.1, -0.1 (implicit via cost) = 0
    // Total in EUR: -5000, +5000 (from cost) = 0
    //
    // In our model, we track this differently: each currency must balance to zero.
    // For a BTC purchase, we'd have:
    //   Debit: Assets:BTC Wallet  +0.1 BTC
    //   Credit: Exchange:BTC/EUR  -0.1 BTC
    //   Debit: Exchange:BTC/EUR   +5000 EUR
    //   Credit: Assets:EUR Bank   -5000 EUR
    // Both BTC and EUR balance to zero.
    //
    // Let's test that approach:

    let exchange_acc = make_account("Exchange", "Exchange:BTC-EUR", AccountType::Equity, None);
    engine.create_account(&exchange_acc).unwrap();

    let entry = make_entry("Buy BTC", date(2025, 1, 10));
    let items = vec![
        make_line(entry.id, btc_wallet.id, "BTC", dec!(0.1)),
        make_line(entry.id, exchange_acc.id, "BTC", dec!(-0.1)),
        make_line(entry.id, exchange_acc.id, "EUR", dec!(5000)),
        make_line(entry.id, eur_bank.id, "EUR", dec!(-5000)),
    ];

    let cost_info = LotCostInfo {
        cost_basis_per_unit: Some(dec!(50000)),
        proceeds_per_unit: None,
    };
    engine.post_journal_entry_with_lots(&entry, &items, &cost_info).unwrap();

    // Verify BTC balance
    let btc_bal = engine.get_account_balance(&btc_wallet.id, None).unwrap();
    let btc = btc_bal.iter().find(|b| b.currency == "BTC").unwrap();
    assert_eq!(btc.amount, dec!(0.1));

    // Verify EUR balance
    let eur_bal = engine.get_account_balance(&eur_bank.id, None).unwrap();
    let eur = eur_bal.iter().find(|b| b.currency == "EUR").unwrap();
    assert_eq!(eur.amount, dec!(-5000));

    // Verify a lot was created
    let lots = engine.storage().get_open_lots_fifo(&btc_wallet.id, "BTC").unwrap();
    assert_eq!(lots.len(), 1);
    assert_eq!(lots[0].original_quantity, dec!(0.1));
    assert_eq!(lots[0].cost_basis_per_unit, dec!(50000));
}

#[test]
fn test_fifo_lot_disposal() {
    let engine = new_engine();
    setup_currencies(&engine);

    let btc_wallet = make_account("BTC Wallet", "Assets:BTC Wallet", AccountType::Asset, None);
    let exchange_acc = make_account("Exchange", "Exchange:BTC-EUR", AccountType::Equity, None);
    let eur_bank = make_account("EUR Bank", "Assets:EUR Bank", AccountType::Asset, None);
    engine.create_account(&btc_wallet).unwrap();
    engine.create_account(&exchange_acc).unwrap();
    engine.create_account(&eur_bank).unwrap();

    // Buy lot 1: 0.5 BTC @ 40000 EUR on Jan 1
    let e1 = make_entry("Buy BTC #1", date(2025, 1, 1));
    engine.post_journal_entry_with_lots(&e1, &[
        make_line(e1.id, btc_wallet.id, "BTC", dec!(0.5)),
        make_line(e1.id, exchange_acc.id, "BTC", dec!(-0.5)),
        make_line(e1.id, exchange_acc.id, "EUR", dec!(20000)),
        make_line(e1.id, eur_bank.id, "EUR", dec!(-20000)),
    ], &LotCostInfo { cost_basis_per_unit: Some(dec!(40000)), proceeds_per_unit: None }).unwrap();

    // Buy lot 2: 0.3 BTC @ 60000 EUR on Feb 1
    let e2 = make_entry("Buy BTC #2", date(2025, 2, 1));
    engine.post_journal_entry_with_lots(&e2, &[
        make_line(e2.id, btc_wallet.id, "BTC", dec!(0.3)),
        make_line(e2.id, exchange_acc.id, "BTC", dec!(-0.3)),
        make_line(e2.id, exchange_acc.id, "EUR", dec!(18000)),
        make_line(e2.id, eur_bank.id, "EUR", dec!(-18000)),
    ], &LotCostInfo { cost_basis_per_unit: Some(dec!(60000)), proceeds_per_unit: None }).unwrap();

    // Verify 2 open lots
    let lots = engine.storage().get_open_lots_fifo(&btc_wallet.id, "BTC").unwrap();
    assert_eq!(lots.len(), 2);
    assert_eq!(lots[0].cost_basis_per_unit, dec!(40000)); // FIFO: oldest first
    assert_eq!(lots[1].cost_basis_per_unit, dec!(60000));

    // Sell 0.6 BTC @ 70000 EUR on Mar 1
    // FIFO: consumes all of lot 1 (0.5) + 0.1 of lot 2
    let e3 = make_entry("Sell BTC", date(2025, 3, 1));
    engine.post_journal_entry_with_lots(&e3, &[
        make_line(e3.id, btc_wallet.id, "BTC", dec!(-0.6)),
        make_line(e3.id, exchange_acc.id, "BTC", dec!(0.6)),
        make_line(e3.id, exchange_acc.id, "EUR", dec!(-42000)),
        make_line(e3.id, eur_bank.id, "EUR", dec!(42000)),
    ], &LotCostInfo { cost_basis_per_unit: None, proceeds_per_unit: Some(dec!(70000)) }).unwrap();

    // Verify lots
    let lots = engine.storage().get_open_lots_fifo(&btc_wallet.id, "BTC").unwrap();
    assert_eq!(lots.len(), 1); // Only lot 2 remains (partially)
    assert_eq!(lots[0].remaining_quantity, dec!(0.2)); // 0.3 - 0.1 = 0.2
    assert_eq!(lots[0].cost_basis_per_unit, dec!(60000));

    // Verify gain/loss report
    let gl = engine.gain_loss_report(date(2025, 1, 1), date(2025, 12, 31)).unwrap();
    assert_eq!(gl.lines.len(), 2); // Two disposal records (lot 1 full, lot 2 partial)

    // Lot 1: sold 0.5 @ 70000, cost 40000 -> gain = 0.5 * (70000 - 40000) = 15000
    // Lot 2: sold 0.1 @ 70000, cost 60000 -> gain = 0.1 * (70000 - 60000) = 1000
    // Total: 16000
    assert_eq!(gl.total_gain_loss, dec!(16000));
}

#[test]
fn test_trial_balance_debits_equal_credits() {
    let engine = new_engine();
    setup_currencies(&engine);

    let checking = make_account("Checking", "Assets:Checking", AccountType::Asset, None);
    let salary = make_account("Salary", "Revenue:Salary", AccountType::Revenue, None);
    let rent = make_account("Rent", "Expense:Rent", AccountType::Expense, None);
    engine.create_account(&checking).unwrap();
    engine.create_account(&salary).unwrap();
    engine.create_account(&rent).unwrap();

    let e1 = make_entry("Salary", date(2025, 1, 15));
    engine.post_journal_entry(&e1, &[
        make_line(e1.id, checking.id, "EUR", dec!(3000)),
        make_line(e1.id, salary.id, "EUR", dec!(-3000)),
    ]).unwrap();

    let e2 = make_entry("Rent", date(2025, 1, 20));
    engine.post_journal_entry(&e2, &[
        make_line(e2.id, checking.id, "EUR", dec!(-1000)),
        make_line(e2.id, rent.id, "EUR", dec!(1000)),
    ]).unwrap();

    let tb = engine.trial_balance(date(2025, 12, 31)).unwrap();

    // Total debits should equal total credits for each currency
    for currency in ["EUR"] {
        let total_debit = tb.total_debits.iter()
            .find(|b| b.currency == currency)
            .map(|b| b.amount)
            .unwrap_or_default();
        let total_credit = tb.total_credits.iter()
            .find(|b| b.currency == currency)
            .map(|b| b.amount)
            .unwrap_or_default();
        assert_eq!(total_debit, total_credit, "Trial balance doesn't balance for {currency}");
    }
}

#[test]
fn test_balance_assertion_passing() {
    let engine = new_engine();
    setup_currencies(&engine);

    let checking = make_account("Checking", "Assets:Checking", AccountType::Asset, None);
    let salary = make_account("Salary", "Revenue:Salary", AccountType::Revenue, None);
    engine.create_account(&checking).unwrap();
    engine.create_account(&salary).unwrap();

    let e1 = make_entry("Salary", date(2025, 1, 15));
    engine.post_journal_entry(&e1, &[
        make_line(e1.id, checking.id, "EUR", dec!(3000)),
        make_line(e1.id, salary.id, "EUR", dec!(-3000)),
    ]).unwrap();

    let assertion = BalanceAssertion {
        id: Uuid::now_v7(),
        account_id: checking.id,
        date: date(2025, 2, 1), // After the entry date
        currency: "EUR".into(),
        currency_asset_type: String::new(),
        currency_param: String::new(),
        expected_balance: dec!(3000),
        is_passing: false,
        actual_balance: None,
        is_strict: false,
        include_subaccounts: false,
    };

    let result = engine.check_balance_assertion(&assertion).unwrap();
    assert!(result, "Balance assertion should pass");
}

#[test]
fn test_balance_assertion_failing() {
    let engine = new_engine();
    setup_currencies(&engine);

    let checking = make_account("Checking", "Assets:Checking", AccountType::Asset, None);
    let salary = make_account("Salary", "Revenue:Salary", AccountType::Revenue, None);
    engine.create_account(&checking).unwrap();
    engine.create_account(&salary).unwrap();

    let e1 = make_entry("Salary", date(2025, 1, 15));
    engine.post_journal_entry(&e1, &[
        make_line(e1.id, checking.id, "EUR", dec!(3000)),
        make_line(e1.id, salary.id, "EUR", dec!(-3000)),
    ]).unwrap();

    let assertion = BalanceAssertion {
        id: Uuid::now_v7(),
        account_id: checking.id,
        date: date(2025, 2, 1),
        currency: "EUR".into(),
        currency_asset_type: String::new(),
        currency_param: String::new(),
        expected_balance: dec!(5000), // Wrong!
        is_passing: false,
        actual_balance: None,
        is_strict: false,
        include_subaccounts: false,
    };

    let result = engine.check_balance_assertion(&assertion).unwrap();
    assert!(!result, "Balance assertion should fail");
}

#[test]
fn test_metadata() {
    let engine = new_engine();
    setup_currencies(&engine);

    let checking = make_account("Checking", "Assets:Checking", AccountType::Asset, None);
    let salary = make_account("Salary", "Revenue:Salary", AccountType::Revenue, None);
    engine.create_account(&checking).unwrap();
    engine.create_account(&salary).unwrap();

    let entry = make_entry("Salary", date(2025, 1, 15));
    engine.post_journal_entry(&entry, &[
        make_line(entry.id, checking.id, "EUR", dec!(3000)),
        make_line(entry.id, salary.id, "EUR", dec!(-3000)),
    ]).unwrap();

    engine.add_metadata(&entry.id, "source_ref", "WIRE-12345").unwrap();
    engine.add_metadata(&entry.id, "category", "income").unwrap();

    let metadata = engine.get_metadata(&entry.id).unwrap();
    assert_eq!(metadata.len(), 2);
    assert!(metadata.iter().any(|m| m.key == "source_ref" && m.value == "WIRE-12345"));
}

#[test]
fn test_exchange_rate() {
    let engine = new_engine();
    setup_currencies(&engine);

    engine.record_exchange_rate(&ExchangeRate {
        id: Uuid::now_v7(),
        date: date(2025, 1, 1),
        from_currency: "BTC".into(),
        from_currency_asset_type: String::new(),
        from_currency_param: String::new(),
        to_currency: "EUR".into(),
        to_currency_asset_type: String::new(),
        to_currency_param: String::new(),
        rate: dec!(42000),
        source: "manual".into(),
    }).unwrap();

    engine.record_exchange_rate(&ExchangeRate {
        id: Uuid::now_v7(),
        date: date(2025, 1, 15),
        from_currency: "BTC".into(),
        from_currency_asset_type: String::new(),
        from_currency_param: String::new(),
        to_currency: "EUR".into(),
        to_currency_asset_type: String::new(),
        to_currency_param: String::new(),
        rate: dec!(45000),
        source: "manual".into(),
    }).unwrap();

    // Should get closest rate on or before the date
    let rate = engine.get_exchange_rate("BTC", "EUR", date(2025, 1, 10)).unwrap();
    assert_eq!(rate, Some(dec!(42000))); // Jan 1 rate (Jan 15 is in the future)

    let rate = engine.get_exchange_rate("BTC", "EUR", date(2025, 1, 20)).unwrap();
    assert_eq!(rate, Some(dec!(45000))); // Jan 15 rate

    let rate = engine.get_exchange_rate("BTC", "EUR", date(2024, 12, 31)).unwrap();
    assert_eq!(rate, None); // No rate before this date
}

#[test]
fn test_archive_account() {
    let engine = new_engine();
    setup_currencies(&engine);

    let checking = make_account("Checking", "Assets:Checking", AccountType::Asset, None);
    engine.create_account(&checking).unwrap();
    engine.archive_account(&checking.id).unwrap();

    let acc = engine.get_account(&checking.id).unwrap().unwrap();
    assert!(acc.is_archived);

    // Posting to archived account should fail
    let salary = make_account("Salary", "Revenue:Salary", AccountType::Revenue, None);
    engine.create_account(&salary).unwrap();
    let entry = make_entry("Test", date(2025, 1, 1));
    let result = engine.post_journal_entry(&entry, &[
        make_line(entry.id, checking.id, "EUR", dec!(100)),
        make_line(entry.id, salary.id, "EUR", dec!(-100)),
    ]);
    assert!(result.is_err());
}
