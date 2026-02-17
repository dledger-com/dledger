use std::sync::Arc;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use tauri::State;
use uuid::Uuid;

use dledger_core::ledger_file::{self, LedgerImportResult};
use dledger_core::models::*;
use dledger_core::reports;
use dledger_core::LedgerEngine;

pub struct AppState {
    pub engine: Arc<LedgerEngine>,
}

// -- Currency commands --

#[tauri::command]
pub fn list_currencies(state: State<'_, AppState>) -> Result<Vec<Currency>, String> {
    state.engine.list_currencies().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_currency(state: State<'_, AppState>, currency: Currency) -> Result<(), String> {
    state
        .engine
        .create_currency(&currency)
        .map_err(|e| e.to_string())
}

// -- Account commands --

#[tauri::command]
pub fn list_accounts(state: State<'_, AppState>) -> Result<Vec<Account>, String> {
    state.engine.list_accounts().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_account(state: State<'_, AppState>, id: Uuid) -> Result<Option<Account>, String> {
    state.engine.get_account(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_account(state: State<'_, AppState>, account: Account) -> Result<(), String> {
    state
        .engine
        .create_account(&account)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn archive_account(state: State<'_, AppState>, id: Uuid) -> Result<(), String> {
    state.engine.archive_account(&id).map_err(|e| e.to_string())
}

// -- Journal entry commands --

#[tauri::command]
pub fn post_journal_entry(
    state: State<'_, AppState>,
    entry: JournalEntry,
    items: Vec<LineItem>,
) -> Result<(), String> {
    state
        .engine
        .post_journal_entry(&entry, &items)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn post_journal_entry_with_lots(
    state: State<'_, AppState>,
    entry: JournalEntry,
    items: Vec<LineItem>,
    cost_basis_per_unit: Option<Decimal>,
    proceeds_per_unit: Option<Decimal>,
) -> Result<(), String> {
    let cost_info = dledger_core::LotCostInfo {
        cost_basis_per_unit,
        proceeds_per_unit,
    };
    state
        .engine
        .post_journal_entry_with_lots(&entry, &items, &cost_info)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn void_journal_entry(
    state: State<'_, AppState>,
    id: Uuid,
) -> Result<JournalEntry, String> {
    state
        .engine
        .void_journal_entry(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_journal_entry(
    state: State<'_, AppState>,
    id: Uuid,
) -> Result<Option<(JournalEntry, Vec<LineItem>)>, String> {
    state
        .engine
        .get_journal_entry(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn query_journal_entries(
    state: State<'_, AppState>,
    filter: TransactionFilter,
) -> Result<Vec<(JournalEntry, Vec<LineItem>)>, String> {
    state
        .engine
        .query_journal_entries(&filter)
        .map_err(|e| e.to_string())
}

// -- Balance commands --

#[tauri::command]
pub fn get_account_balance(
    state: State<'_, AppState>,
    account_id: Uuid,
    as_of: Option<NaiveDate>,
) -> Result<Vec<CurrencyBalance>, String> {
    state
        .engine
        .get_account_balance(&account_id, as_of)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_account_balance_with_children(
    state: State<'_, AppState>,
    account_id: Uuid,
    as_of: Option<NaiveDate>,
) -> Result<Vec<CurrencyBalance>, String> {
    state
        .engine
        .get_account_balance_with_children(&account_id, as_of)
        .map_err(|e| e.to_string())
}

// -- Exchange rate commands --

#[tauri::command]
pub fn record_exchange_rate(
    state: State<'_, AppState>,
    rate: ExchangeRate,
) -> Result<(), String> {
    state
        .engine
        .record_exchange_rate(&rate)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_exchange_rate(
    state: State<'_, AppState>,
    from: String,
    to: String,
    date: NaiveDate,
) -> Result<Option<Decimal>, String> {
    state
        .engine
        .get_exchange_rate(&from, &to, date)
        .map_err(|e| e.to_string())
}

// -- Exchange rate listing --

#[tauri::command]
pub fn list_exchange_rates(
    state: State<'_, AppState>,
    from: Option<String>,
    to: Option<String>,
) -> Result<Vec<ExchangeRate>, String> {
    state
        .engine
        .list_exchange_rates(from.as_deref(), to.as_deref())
        .map_err(|e| e.to_string())
}

// -- Report commands --

#[tauri::command]
pub fn trial_balance(
    state: State<'_, AppState>,
    as_of: NaiveDate,
) -> Result<reports::TrialBalance, String> {
    state
        .engine
        .trial_balance(as_of)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn income_statement(
    state: State<'_, AppState>,
    from_date: NaiveDate,
    to_date: NaiveDate,
) -> Result<reports::IncomeStatement, String> {
    state
        .engine
        .income_statement(from_date, to_date)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn balance_sheet(
    state: State<'_, AppState>,
    as_of: NaiveDate,
) -> Result<reports::BalanceSheet, String> {
    state
        .engine
        .balance_sheet(as_of)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn gain_loss_report(
    state: State<'_, AppState>,
    from_date: NaiveDate,
    to_date: NaiveDate,
) -> Result<reports::GainLossReport, String> {
    state
        .engine
        .gain_loss_report(from_date, to_date)
        .map_err(|e| e.to_string())
}

// -- Ledger file import/export --

#[tauri::command]
pub fn import_ledger_file(
    state: State<'_, AppState>,
    content: String,
) -> Result<LedgerImportResult, String> {
    ledger_file::import_ledger(&state.engine, &content)
}

#[tauri::command]
pub fn export_ledger_file(
    state: State<'_, AppState>,
) -> Result<String, String> {
    ledger_file::export_ledger(&state.engine)
}

