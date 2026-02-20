use std::cell::RefCell;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};

use chrono::NaiveDate;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use dledger_core::ledger_file::{export_ledger, import_ledger};
use dledger_core::models::*;
use dledger_core::schema::{SCHEMA_SQL, SCHEMA_VERSION};
use dledger_core::storage::*;
use dledger_core::LedgerEngine;

// ============================================================================
// In-memory SQLite Storage for testing (same as integration_tests.rs)
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
        conn.execute(
            "INSERT INTO schema_version (version) VALUES (?1)",
            params![SCHEMA_VERSION],
        )
        .unwrap();
        Self {
            conn: RefCell::new(conn),
        }
    }

    fn insert_closure_entries(
        &self,
        account_id: &Uuid,
        parent_id: Option<&Uuid>,
    ) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO account_closure (ancestor_id, descendant_id, depth) VALUES (?1, ?2, 0)",
            params![account_id.to_string(), account_id.to_string()],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;

        if let Some(pid) = parent_id {
            conn.execute(
                "INSERT INTO account_closure (ancestor_id, descendant_id, depth)
                 SELECT ancestor_id, ?1, depth + 1
                 FROM account_closure WHERE descendant_id = ?2",
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
    AccountType::from_str(s).ok_or_else(|| StorageError::Internal(format!("invalid type: {s}")))
}

fn parse_entry_status(s: &str) -> StorageResult<JournalEntryStatus> {
    JournalEntryStatus::from_str(s)
        .ok_or_else(|| StorageError::Internal(format!("invalid status: {s}")))
}

impl Storage for TestStorage {
    fn create_currency(&self, currency: &Currency) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO currency (code, name, decimal_places, is_base) VALUES (?1, ?2, ?3, ?4)",
            params![
                currency.code,
                currency.name,
                currency.decimal_places,
                currency.is_base as i32
            ],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn get_currency(&self, code: &str) -> StorageResult<Option<Currency>> {
        let conn = self.conn.borrow();
        let r = conn
            .query_row(
                "SELECT code, name, decimal_places, is_base FROM currency WHERE code = ?1",
                params![code],
                |row| {
                    Ok(Currency {
                        code: row.get(0)?,
                        name: row.get(1)?,
                        decimal_places: row.get::<_, u8>(2)?,
                        is_base: row.get::<_, i32>(3)? != 0,
                    })
                },
            )
            .optional()
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(r)
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

    fn create_account(&self, account: &Account) -> StorageResult<()> {
        let allowed =
            serde_json::to_string(&account.allowed_currencies).unwrap_or_else(|_| "[]".into());
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
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        }
        self.insert_closure_entries(&account.id, account.parent_id.as_ref())?;
        Ok(())
    }

    fn get_account(&self, id: &Uuid) -> StorageResult<Option<Account>> {
        let conn = self.conn.borrow();
        let r = conn
            .query_row(
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
            )
            .optional()
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        match r {
            None => Ok(None),
            Some((id_s, pid_s, at_s, name, full_name, ac_s, ip, ia, ca_s)) => Ok(Some(Account {
                id: parse_uuid(&id_s)?,
                parent_id: pid_s.as_deref().map(parse_uuid).transpose()?,
                account_type: parse_account_type(&at_s)?,
                name,
                full_name,
                allowed_currencies: serde_json::from_str(&ac_s).unwrap_or_default(),
                is_postable: ip != 0,
                is_archived: ia != 0,
                created_at: parse_date(&ca_s)?,
            })),
        }
    }

    fn get_account_by_full_name(&self, full_name: &str) -> StorageResult<Option<Account>> {
        let conn = self.conn.borrow();
        let r = conn
            .query_row(
                "SELECT id FROM account WHERE full_name = ?1",
                params![full_name],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        match r {
            None => Ok(None),
            Some(id_s) => self.get_account(&parse_uuid(&id_s)?),
        }
    }

    fn list_accounts(&self) -> StorageResult<Vec<Account>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare(
                "SELECT id, parent_id, account_type, name, full_name, allowed_currencies, is_postable, is_archived, created_at FROM account ORDER BY full_name",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
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
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;

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
            });
        }
        Ok(accounts)
    }

    fn update_account_archived(&self, id: &Uuid, is_archived: bool) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "UPDATE account SET is_archived = ?1 WHERE id = ?2",
            params![is_archived as i32, id.to_string()],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
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
            .query_map(params![id.to_string()], |row| row.get::<_, String>(0))
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.map(|r| {
            let s = r.map_err(|e| StorageError::Internal(e.to_string()))?;
            parse_uuid(&s)
        })
        .collect()
    }

    fn insert_journal_entry(
        &self,
        entry: &JournalEntry,
        items: &[LineItem],
    ) -> StorageResult<()> {
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
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;

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
        let entry = conn
            .query_row(
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
            )
            .optional()
            .map_err(|e| StorageError::Internal(e.to_string()))?;

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
                let mut stmt = conn
                    .prepare(
                        "SELECT id, journal_entry_id, account_id, currency, amount, lot_id FROM line_item WHERE journal_entry_id = ?1",
                    )
                    .map_err(|e| StorageError::Internal(e.to_string()))?;
                let rows = stmt
                    .query_map(params![id.to_string()], |row| {
                        let i: String = row.get(0)?;
                        let ji: String = row.get(1)?;
                        let ai: String = row.get(2)?;
                        let c: String = row.get(3)?;
                        let a: String = row.get(4)?;
                        let li: Option<String> = row.get(5)?;
                        Ok((i, ji, ai, c, a, li))
                    })
                    .map_err(|e| StorageError::Internal(e.to_string()))?;
                let mut items = Vec::new();
                for r in rows {
                    let (i, ji, ai, c, a, li) =
                        r.map_err(|e| StorageError::Internal(e.to_string()))?;
                    items.push(LineItem {
                        id: parse_uuid(&i)?,
                        journal_entry_id: parse_uuid(&ji)?,
                        account_id: parse_uuid(&ai)?,
                        currency: c,
                        amount: parse_decimal(&a)?,
                        lot_id: li.as_deref().map(parse_uuid).transpose()?,
                    });
                }
                Ok(Some((je, items)))
            }
        }
    }

    fn query_journal_entries(
        &self,
        _filter: &TransactionFilter,
    ) -> StorageResult<Vec<(JournalEntry, Vec<LineItem>)>> {
        let conn = self.conn.borrow();
        let mut stmt = conn
            .prepare("SELECT id FROM journal_entry ORDER BY date DESC")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let ids: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
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

    fn update_journal_entry_status(
        &self,
        id: &Uuid,
        status: JournalEntryStatus,
        voided_by: Option<Uuid>,
    ) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "UPDATE journal_entry SET status = ?1, voided_by = ?2 WHERE id = ?3",
            params![
                status.as_str(),
                voided_by.map(|id| id.to_string()),
                id.to_string()
            ],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn insert_lot(&self, lot: &Lot) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO lot (id, account_id, currency, acquired_date, original_quantity, remaining_quantity, cost_basis_per_unit, cost_basis_currency, journal_entry_id, is_closed)
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
        let r = conn
            .query_row(
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
            )
            .optional()
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        match r {
            None => Ok(None),
            Some((ids, ai, c, ad, oq, rq, cb, cbc, ji, ic)) => Ok(Some(Lot {
                id: parse_uuid(&ids)?,
                account_id: parse_uuid(&ai)?,
                currency: c,
                acquired_date: parse_date(&ad)?,
                original_quantity: parse_decimal(&oq)?,
                remaining_quantity: parse_decimal(&rq)?,
                cost_basis_per_unit: parse_decimal(&cb)?,
                cost_basis_currency: cbc,
                journal_entry_id: parse_uuid(&ji)?,
                is_closed: ic != 0,
            })),
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
                "SELECT id, account_id, currency, acquired_date, original_quantity, remaining_quantity, cost_basis_per_unit, cost_basis_currency, journal_entry_id, is_closed
                 FROM lot WHERE account_id = ?1 AND currency = ?2 AND is_closed = 0 ORDER BY acquired_date ASC",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map(params![account_id.to_string(), currency], |row| {
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
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;

        let mut lots = Vec::new();
        for r in rows {
            let (ids, ai, c, ad, oq, rq, cb, cbc, ji, ic) =
                r.map_err(|e| StorageError::Internal(e.to_string()))?;
            lots.push(Lot {
                id: parse_uuid(&ids)?,
                account_id: parse_uuid(&ai)?,
                currency: c,
                acquired_date: parse_date(&ad)?,
                original_quantity: parse_decimal(&oq)?,
                remaining_quantity: parse_decimal(&rq)?,
                cost_basis_per_unit: parse_decimal(&cb)?,
                cost_basis_currency: cbc,
                journal_entry_id: parse_uuid(&ji)?,
                is_closed: ic != 0,
            });
        }
        Ok(lots)
    }

    fn update_lot_remaining(
        &self,
        id: &Uuid,
        remaining: Decimal,
        is_closed: bool,
    ) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "UPDATE lot SET remaining_quantity = ?1, is_closed = ?2 WHERE id = ?3",
            params![remaining.to_string(), is_closed as i32, id.to_string()],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn insert_lot_disposal(&self, disposal: &LotDisposal) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO lot_disposal (id, lot_id, journal_entry_id, quantity, proceeds_per_unit, proceeds_currency, realized_gain_loss, disposal_date)
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
                "SELECT id, lot_id, journal_entry_id, quantity, proceeds_per_unit, proceeds_currency, realized_gain_loss, disposal_date
                 FROM lot_disposal WHERE disposal_date >= ?1 AND disposal_date <= ?2 ORDER BY disposal_date ASC",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map(
                params![
                    from_date.format("%Y-%m-%d").to_string(),
                    to_date.format("%Y-%m-%d").to_string(),
                ],
                |row| {
                    let i: String = row.get(0)?;
                    let li: String = row.get(1)?;
                    let ji: String = row.get(2)?;
                    let q: String = row.get(3)?;
                    let pp: String = row.get(4)?;
                    let pc: String = row.get(5)?;
                    let gl: String = row.get(6)?;
                    let dd: String = row.get(7)?;
                    Ok((i, li, ji, q, pp, pc, gl, dd))
                },
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;

        let mut disposals = Vec::new();
        for r in rows {
            let (i, li, ji, q, pp, pc, gl, dd) =
                r.map_err(|e| StorageError::Internal(e.to_string()))?;
            disposals.push(LotDisposal {
                id: parse_uuid(&i)?,
                lot_id: parse_uuid(&li)?,
                journal_entry_id: parse_uuid(&ji)?,
                quantity: parse_decimal(&q)?,
                proceeds_per_unit: parse_decimal(&pp)?,
                proceeds_currency: pc,
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
            params![
                rate.id.to_string(),
                rate.date.format("%Y-%m-%d").to_string(),
                rate.from_currency,
                rate.to_currency,
                rate.rate.to_string(),
                rate.source
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
        let r = conn
            .query_row(
                "SELECT rate FROM exchange_rate WHERE from_currency = ?1 AND to_currency = ?2 AND date <= ?3 ORDER BY date DESC LIMIT 1",
                params![from, to, date.format("%Y-%m-%d").to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        match r {
            None => Ok(None),
            Some(s) => Ok(Some(parse_decimal(&s)?)),
        }
    }

    fn get_exchange_rate_source(
        &self,
        from: &str,
        to: &str,
        date: NaiveDate,
    ) -> StorageResult<Option<String>> {
        let conn = self.conn.borrow();
        let r = conn
            .query_row(
                "SELECT source FROM exchange_rate WHERE date = ?1 AND from_currency = ?2 AND to_currency = ?3",
                params![date.format("%Y-%m-%d").to_string(), from, to],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(r)
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
            .query_map(params_refs.as_slice(), |row| {
                Ok((|| -> StorageResult<ExchangeRate> {
                    Ok(ExchangeRate {
                        id: parse_uuid(
                            &row.get::<_, String>(0)
                                .map_err(|e| StorageError::Internal(e.to_string()))?,
                        )?,
                        date: parse_date(
                            &row.get::<_, String>(1)
                                .map_err(|e| StorageError::Internal(e.to_string()))?,
                        )?,
                        from_currency: row
                            .get::<_, String>(2)
                            .map_err(|e| StorageError::Internal(e.to_string()))?,
                        to_currency: row
                            .get::<_, String>(3)
                            .map_err(|e| StorageError::Internal(e.to_string()))?,
                        rate: parse_decimal(
                            &row.get::<_, String>(4)
                                .map_err(|e| StorageError::Internal(e.to_string()))?,
                        )?,
                        source: row
                            .get::<_, String>(5)
                            .map_err(|e| StorageError::Internal(e.to_string()))?,
                    })
                })())
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        rows.map(|r| r.map_err(|e| StorageError::Internal(e.to_string()))?)
            .collect()
    }

    fn sum_line_items(
        &self,
        account_ids: &[Uuid],
        before_date: Option<NaiveDate>,
    ) -> StorageResult<Vec<CurrencyBalance>> {
        if account_ids.is_empty() {
            return Ok(vec![]);
        }

        let placeholders: Vec<String> =
            (1..=account_ids.len()).map(|i| format!("?{i}")).collect();
        let mut sql = format!(
            "SELECT li.currency, li.amount FROM line_item li
             JOIN journal_entry je ON je.id = li.journal_entry_id
             WHERE li.account_id IN ({}) ",
            placeholders.join(", ")
        );
        let mut param_values: Vec<String> =
            account_ids.iter().map(|id| id.to_string()).collect();
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
        let rows = stmt
            .query_map(params_refs.as_slice(), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;

        let mut totals: HashMap<String, Decimal> = HashMap::new();
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

    fn insert_balance_assertion(&self, a: &BalanceAssertion) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO balance_assertion (id, account_id, date, currency, expected_balance, is_passing, actual_balance) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                a.id.to_string(),
                a.account_id.to_string(),
                a.date.format("%Y-%m-%d").to_string(),
                a.currency,
                a.expected_balance.to_string(),
                a.is_passing as i32,
                a.actual_balance.map(|d| d.to_string())
            ],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn update_balance_assertion_result(
        &self,
        id: &Uuid,
        is_passing: bool,
        actual: Decimal,
    ) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "UPDATE balance_assertion SET is_passing = ?1, actual_balance = ?2 WHERE id = ?3",
            params![is_passing as i32, actual.to_string(), id.to_string()],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn get_balance_assertions(
        &self,
        _account_id: Option<&Uuid>,
    ) -> StorageResult<Vec<BalanceAssertion>> {
        Ok(vec![])
    }

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
                "SELECT journal_entry_id, key, value FROM journal_entry_metadata WHERE journal_entry_id = ?1",
            )
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map(params![journal_entry_id.to_string()], |row| {
                let ji: String = row.get(0)?;
                let k: String = row.get(1)?;
                let v: String = row.get(2)?;
                Ok((ji, k, v))
            })
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        let mut result = Vec::new();
        for r in rows {
            let (ji, k, v) = r.map_err(|e| StorageError::Internal(e.to_string()))?;
            result.push(Metadata {
                journal_entry_id: parse_uuid(&ji)?,
                key: k,
                value: v,
            });
        }
        Ok(result)
    }

    fn insert_audit_log(&self, entry: &AuditLogEntry) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute(
            "INSERT INTO audit_log (id, timestamp, action, entity_type, entity_id, details) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                entry.id.to_string(),
                entry.timestamp.format("%Y-%m-%d").to_string(),
                entry.action,
                entry.entity_type,
                entry.entity_id.to_string(),
                entry.details
            ],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn in_transaction(
        &self,
        f: &mut dyn FnMut(&dyn Storage) -> StorageResult<()>,
    ) -> StorageResult<()> {
        let id = SAVEPOINT_COUNTER.fetch_add(1, Ordering::Relaxed);
        let sp = format!("sp_{id}");
        {
            let c = self.conn.borrow();
            c.execute_batch(&format!("SAVEPOINT {sp}"))
                .map_err(|e| StorageError::Internal(e.to_string()))?;
        }
        match f(self) {
            Ok(()) => {
                let c = self.conn.borrow();
                c.execute_batch(&format!("RELEASE {sp}"))
                    .map_err(|e| StorageError::Internal(e.to_string()))?;
                Ok(())
            }
            Err(e) => {
                let c = self.conn.borrow();
                let _ = c.execute_batch(&format!("ROLLBACK TO {sp}"));
                let _ = c.execute_batch(&format!("RELEASE {sp}"));
                Err(e)
            }
        }
    }

    fn execute_sql(&self, sql: &str) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute_batch(sql)
            .map_err(|e| StorageError::Internal(e.to_string()))
    }

    fn get_schema_version(&self) -> StorageResult<u32> {
        let conn = self.conn.borrow();
        let r = conn
            .query_row(
                "SELECT version FROM schema_version LIMIT 1",
                [],
                |row| row.get::<_, u32>(0),
            )
            .optional()
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(r.unwrap_or(0))
    }

    fn set_schema_version(&self, version: u32) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute("DELETE FROM schema_version", [])
            .map_err(|e| StorageError::Internal(e.to_string()))?;
        conn.execute(
            "INSERT INTO schema_version (version) VALUES (?1)",
            params![version],
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
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
        conn.execute_batch("DELETE FROM exchange_rate")
            .map_err(|e| StorageError::Internal(e.to_string()))?;
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
             PRAGMA foreign_keys=ON;",
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
        Ok(())
    }

    fn clear_all_data(&self) -> StorageResult<()> {
        let conn = self.conn.borrow();
        conn.execute_batch(
            "DELETE FROM lot_disposal; DELETE FROM lot; DELETE FROM line_item;
             DELETE FROM journal_entry_metadata; DELETE FROM balance_assertion;
             DELETE FROM audit_log; DELETE FROM journal_entry; DELETE FROM exchange_rate;
             DELETE FROM account_closure; DELETE FROM account; DELETE FROM currency;
             DELETE FROM currency_rate_source;",
        )
        .map_err(|e| StorageError::Internal(e.to_string()))?;
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
}

// ============================================================================
// Test helpers
// ============================================================================

fn new_engine() -> LedgerEngine {
    let storage = TestStorage::new_in_memory();
    LedgerEngine::new(Box::new(storage))
}

// ============================================================================
// Tests
// ============================================================================

#[test]
fn test_parse_open_directives() {
    let engine = new_engine();
    let content = "\
2000-01-01 open Assets:Bank:Checking  USD
2000-01-01 open Liabilities:Credit:VISA  USD
2000-01-01 open Income:Salary
2000-01-01 open Expenses:Food
2000-01-01 open Equity:Opening
";
    let result = import_ledger(&engine, content).unwrap();
    assert_eq!(result.currencies_created, 1); // USD
    // Accounts: Assets, Assets:Bank, Assets:Bank:Checking, Liabilities, Liabilities:Credit,
    //           Liabilities:Credit:VISA, Income, Income:Salary, Expenses, Expenses:Food,
    //           Equity, Equity:Opening = 12
    assert!(result.accounts_created >= 12);

    let accounts = engine.list_accounts().unwrap();
    let checking = accounts.iter().find(|a| a.full_name == "Assets:Bank:Checking").unwrap();
    assert_eq!(checking.account_type, AccountType::Asset);
    assert_eq!(checking.allowed_currencies, vec!["USD".to_string()]);

    let visa = accounts.iter().find(|a| a.full_name == "Liabilities:Credit:VISA").unwrap();
    assert_eq!(visa.account_type, AccountType::Liability);

    let salary = accounts.iter().find(|a| a.full_name == "Income:Salary").unwrap();
    assert_eq!(salary.account_type, AccountType::Revenue);

    let food = accounts.iter().find(|a| a.full_name == "Expenses:Food").unwrap();
    assert_eq!(food.account_type, AccountType::Expense);

    let opening = accounts.iter().find(|a| a.full_name == "Equity:Opening").unwrap();
    assert_eq!(opening.account_type, AccountType::Equity);
}

#[test]
fn test_parse_transaction_explicit_amounts() {
    let engine = new_engine();
    let content = "\
2000-01-01 open Assets:Checking  USD
2000-01-01 open Income:Salary  USD

2008-01-10 * Salary from employer
  Assets:Checking        2000.00 USD
  Income:Salary         -2000.00 USD
";
    let result = import_ledger(&engine, content).unwrap();
    assert_eq!(result.transactions_imported, 1);

    let entries = engine
        .query_journal_entries(&TransactionFilter::default())
        .unwrap();
    assert_eq!(entries.len(), 1);
    let (entry, items) = &entries[0];
    assert_eq!(entry.description, "Salary from employer");
    assert_eq!(entry.status, JournalEntryStatus::Confirmed);
    assert_eq!(items.len(), 2);
}

#[test]
fn test_parse_transaction_elided_amount() {
    let engine = new_engine();
    let content = "\
2000-01-01 open Assets:Checking  USD
2000-01-01 open Income:Salary  USD

2008-01-25 * Salary
  Assets:Checking        2000.00 USD
  Income:Salary
";
    let result = import_ledger(&engine, content).unwrap();
    assert_eq!(result.transactions_imported, 1);

    let entries = engine
        .query_journal_entries(&TransactionFilter::default())
        .unwrap();
    let (_, items) = &entries[0];
    assert_eq!(items.len(), 2);

    // The elided posting should be auto-balanced to -2000 USD
    let salary_item = items
        .iter()
        .find(|i| {
            let acc = engine.get_account(&i.account_id).unwrap().unwrap();
            acc.full_name == "Income:Salary"
        })
        .unwrap();
    assert_eq!(salary_item.amount, dec!(-2000.00));
    assert_eq!(salary_item.currency, "USD");
}

#[test]
fn test_parse_status_markers() {
    let engine = new_engine();
    let content = "\
2000-01-01 open Assets:Checking  USD
2000-01-01 open Income:Salary  USD

2008-01-10 * Confirmed transaction
  Assets:Checking        100.00 USD
  Income:Salary         -100.00 USD

2008-01-11 ! Pending transaction
  Assets:Checking        200.00 USD
  Income:Salary         -200.00 USD

2008-01-12 No marker transaction
  Assets:Checking        300.00 USD
  Income:Salary         -300.00 USD
";
    let result = import_ledger(&engine, content).unwrap();
    assert_eq!(result.transactions_imported, 3);

    let entries = engine
        .query_journal_entries(&TransactionFilter::default())
        .unwrap();

    let confirmed = entries.iter().find(|(e, _)| e.description == "Confirmed transaction").unwrap();
    assert_eq!(confirmed.0.status, JournalEntryStatus::Confirmed);

    let pending = entries.iter().find(|(e, _)| e.description == "Pending transaction").unwrap();
    assert_eq!(pending.0.status, JournalEntryStatus::Pending);

    let unmarked = entries.iter().find(|(e, _)| e.description == "No marker transaction").unwrap();
    assert_eq!(unmarked.0.status, JournalEntryStatus::Confirmed);
}

#[test]
fn test_parse_price_directive() {
    let engine = new_engine();
    let content = "\
P 2008-01-08 AAPL 185.40 USD
P 2008-02-28 AAPL 193.02 USD
";
    let result = import_ledger(&engine, content).unwrap();
    assert_eq!(result.prices_imported, 2);
    assert_eq!(result.currencies_created, 2); // AAPL and USD

    let rate = engine
        .get_exchange_rate("AAPL", "USD", NaiveDate::from_ymd_opt(2008, 1, 10).unwrap())
        .unwrap();
    assert_eq!(rate, Some(dec!(185.40)));

    let rate = engine
        .get_exchange_rate("AAPL", "USD", NaiveDate::from_ymd_opt(2008, 3, 1).unwrap())
        .unwrap();
    assert_eq!(rate, Some(dec!(193.02)));
}

#[test]
fn test_parse_balance_directive() {
    let engine = new_engine();
    let content = "\
2000-01-01 open Assets:Checking  USD
2000-01-01 open Income:Salary  USD

2008-01-10 * Salary
  Assets:Checking        1412.24 USD
  Income:Salary         -1412.24 USD

;; Balance check — the assertion date means 'balance before this date'
;; Our sum_line_items uses < date, so we check at a date after the transaction
2008-01-11 balance Assets:Checking  1412.24 USD
";
    let result = import_ledger(&engine, content).unwrap();
    assert_eq!(result.transactions_imported, 1);
    // The balance assertion should pass (no warning about it failing)
    let balance_warnings: Vec<&String> = result
        .warnings
        .iter()
        .filter(|w| w.contains("balance assertion failed"))
        .collect();
    assert!(
        balance_warnings.is_empty(),
        "Expected no balance assertion failures, got: {:?}",
        balance_warnings
    );
}

#[test]
fn test_parse_close_directive() {
    let engine = new_engine();
    let content = "\
2000-01-01 open Expenses:Charity

2009-01-01 close Expenses:Charity
";
    let result = import_ledger(&engine, content).unwrap();
    let acc = engine
        .storage()
        .get_account_by_full_name("Expenses:Charity")
        .unwrap()
        .unwrap();
    assert!(acc.is_archived);
    assert!(result.warnings.is_empty() || !result.warnings.iter().any(|w| w.contains("close")));
}

#[test]
fn test_import_demo_ledger() {
    let engine = new_engine();
    let content = include_str!("../../../tmp/demo.ledger");
    let result = import_ledger(&engine, content).unwrap();

    // Should have created accounts
    assert!(
        result.accounts_created > 30,
        "Expected >30 accounts, got {}",
        result.accounts_created
    );

    // Should have imported transactions (the demo has ~40 transactions)
    assert!(
        result.transactions_imported > 30,
        "Expected >30 transactions, got {}",
        result.transactions_imported
    );

    // Should have at least USD and CAD currencies and likely AAPL, EWJ
    assert!(
        result.currencies_created >= 2,
        "Expected >= 2 currencies, got {}",
        result.currencies_created
    );

    // pad directives should generate warnings
    let pad_warnings: Vec<&String> = result
        .warnings
        .iter()
        .filter(|w| w.contains("pad"))
        .collect();
    assert!(
        !pad_warnings.is_empty(),
        "Expected at least one pad warning"
    );

    // BOOK posting should generate a warning
    let book_warnings: Vec<&String> = result
        .warnings
        .iter()
        .filter(|w| w.contains("BOOK"))
        .collect();
    assert!(
        !book_warnings.is_empty(),
        "Expected BOOK warning, got none. All warnings: {:?}",
        result.warnings
    );

    // Verify a known account exists
    let checking = engine
        .storage()
        .get_account_by_full_name("Assets:Current:BestBank:Checking")
        .unwrap();
    assert!(checking.is_some());

    // Verify Expenses:Charity is archived (close directive)
    let charity = engine
        .storage()
        .get_account_by_full_name("Expenses:Charity")
        .unwrap()
        .unwrap();
    assert!(charity.is_archived);
}

#[test]
fn test_export_roundtrip() {
    let engine = new_engine();

    // Import a simple ledger
    let original = "\
2000-01-01 open Assets:Checking  USD
2000-01-01 open Income:Salary  USD
2000-01-01 open Expenses:Rent  USD

2008-01-10 * Salary
  Assets:Checking        3000.00 USD
  Income:Salary         -3000.00 USD

2008-01-20 * Rent payment
  Assets:Checking       -1000.00 USD
  Expenses:Rent          1000.00 USD

P 2008-01-10 BTC 42000 USD
";
    let import_result = import_ledger(&engine, original).unwrap();
    assert_eq!(import_result.transactions_imported, 2);
    assert_eq!(import_result.prices_imported, 1);

    // Export
    let exported = export_ledger(&engine).unwrap();

    // Re-import into a fresh engine
    let engine2 = new_engine();
    let reimport_result = import_ledger(&engine2, &exported).unwrap();

    // Should have same number of transactions and prices
    assert_eq!(
        reimport_result.transactions_imported,
        import_result.transactions_imported,
        "Transaction count mismatch on roundtrip"
    );
    assert_eq!(
        reimport_result.prices_imported,
        import_result.prices_imported,
        "Price count mismatch on roundtrip"
    );

    // Verify account balances match
    let accounts1 = engine.list_accounts().unwrap();
    let accounts2 = engine2.list_accounts().unwrap();

    let checking1 = accounts1
        .iter()
        .find(|a| a.full_name == "Assets:Checking")
        .unwrap();
    let checking2 = accounts2
        .iter()
        .find(|a| a.full_name == "Assets:Checking")
        .unwrap();

    let bal1 = engine
        .get_account_balance(&checking1.id, None)
        .unwrap();
    let bal2 = engine2
        .get_account_balance(&checking2.id, None)
        .unwrap();
    assert_eq!(bal1.len(), bal2.len());
    assert_eq!(bal1[0].amount, bal2[0].amount);
}

#[test]
fn test_error_malformed_date() {
    let engine = new_engine();
    let content = "\
2000-01-01 open Assets:Checking  USD
2000-01-01 open Income:Salary  USD

not-a-date * Bad transaction
  Assets:Checking        100.00 USD
  Income:Salary         -100.00 USD
";
    // The line with "not-a-date" won't match the date prefix pattern,
    // so it's treated as an unknown line and skipped.
    // This shouldn't cause an error — just 0 transactions imported from that block.
    let result = import_ledger(&engine, content).unwrap();
    assert_eq!(result.transactions_imported, 0);
}
