use std::sync::Arc;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use tauri::State;
use uuid::Uuid;

use dledger_core::ledger_file::{self, LedgerFormat, LedgerImportResult};
use dledger_core::models::*;
use dledger_core::reports;
use dledger_core::LedgerEngine;

use crate::etherscan::{ChainInfo, EtherscanAccount, EtherscanState, SUPPORTED_CHAINS};

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
pub fn get_exchange_rate_currencies_on_date(
    state: State<'_, AppState>,
    date: NaiveDate,
) -> Result<Vec<String>, String> {
    state
        .engine
        .get_exchange_rate_currencies_on_date(date)
        .map_err(|e| e.to_string())
}

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
    format: Option<String>,
) -> Result<LedgerImportResult, String> {
    let fmt = format.and_then(|s| LedgerFormat::from_str_opt(&s));
    ledger_file::import_ledger_with_format(&state.engine, &content, fmt)
}

#[tauri::command]
pub fn export_ledger_file(
    state: State<'_, AppState>,
    format: Option<String>,
) -> Result<String, String> {
    let fmt = format.and_then(|s| LedgerFormat::from_str_opt(&s)).unwrap_or(LedgerFormat::Ledger);
    ledger_file::export_ledger_with_format(&state.engine, fmt)
}

// -- Currency origins --

#[tauri::command]
pub fn get_currency_origins(
    state: State<'_, AppState>,
) -> Result<Vec<dledger_core::models::CurrencyOrigin>, String> {
    state
        .engine
        .get_currency_origins()
        .map_err(|e| e.to_string())
}

// -- Data management commands --

#[tauri::command]
pub fn clear_exchange_rates(state: State<'_, AppState>) -> Result<(), String> {
    state
        .engine
        .clear_exchange_rates()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_ledger_data(state: State<'_, AppState>) -> Result<(), String> {
    state
        .engine
        .clear_ledger_data()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_all_data(state: State<'_, AppState>) -> Result<(), String> {
    state
        .engine
        .clear_all_data()
        .map_err(|e| e.to_string())
}

// -- Metadata query commands --

#[tauri::command]
pub fn query_entries_by_metadata(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<Vec<Uuid>, String> {
    state
        .engine
        .query_entries_by_metadata(&key, &value)
        .map_err(|e| e.to_string())
}

// -- Entry link commands --

#[tauri::command]
pub fn set_entry_links(
    state: State<'_, AppState>,
    entry_id: Uuid,
    links: Vec<String>,
) -> Result<(), String> {
    state
        .engine
        .set_entry_links(&entry_id, &links)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_entry_links(
    state: State<'_, AppState>,
    entry_id: Uuid,
) -> Result<Vec<String>, String> {
    state
        .engine
        .get_entry_links(&entry_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_entries_by_link(
    state: State<'_, AppState>,
    link_name: String,
) -> Result<Vec<Uuid>, String> {
    state
        .engine
        .get_entries_by_link(&link_name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_all_link_names(
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    state
        .engine
        .get_all_link_names()
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct LinkWithCount {
    pub link_name: String,
    pub entry_count: u64,
}

#[tauri::command]
pub fn get_all_links_with_counts(
    state: State<'_, AppState>,
) -> Result<Vec<LinkWithCount>, String> {
    state
        .engine
        .get_all_links_with_counts()
        .map_err(|e| e.to_string())
        .map(|pairs| {
            pairs
                .into_iter()
                .map(|(link_name, entry_count)| LinkWithCount {
                    link_name,
                    entry_count,
                })
                .collect()
        })
}

// -- Open lots command --

#[derive(serde::Serialize)]
pub struct OpenLotResult {
    pub id: String,
    pub account_id: String,
    pub account_name: String,
    pub currency: String,
    pub acquired_date: String,
    pub remaining_quantity: String,
    pub cost_basis_per_unit: String,
    pub cost_basis_currency: String,
}

#[tauri::command]
pub fn list_open_lots(
    state: State<'_, AppState>,
) -> Result<Vec<OpenLotResult>, String> {
    let lots = state
        .engine
        .list_all_open_lots()
        .map_err(|e| e.to_string())?;
    let mut results = Vec::new();
    for lot in lots {
        let account_name = state
            .engine
            .get_account(&lot.account_id)
            .map_err(|e| e.to_string())?
            .map(|a| a.full_name)
            .unwrap_or_default();
        results.push(OpenLotResult {
            id: lot.id.to_string(),
            account_id: lot.account_id.to_string(),
            account_name,
            currency: lot.currency,
            acquired_date: lot.acquired_date.format("%Y-%m-%d").to_string(),
            remaining_quantity: lot.remaining_quantity.to_string(),
            cost_basis_per_unit: lot.cost_basis_per_unit.to_string(),
            cost_basis_currency: lot.cost_basis_currency,
        });
    }
    Ok(results)
}

// -- Metadata commands --

#[tauri::command]
pub fn set_metadata(
    state: State<'_, AppState>,
    entry_id: Uuid,
    entries: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    for (key, value) in &entries {
        state
            .engine
            .set_metadata(&entry_id, key, value)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_metadata(
    state: State<'_, AppState>,
    entry_id: Uuid,
) -> Result<std::collections::HashMap<String, String>, String> {
    let meta = state
        .engine
        .get_metadata(&entry_id)
        .map_err(|e| e.to_string())?;
    let mut map = std::collections::HashMap::new();
    for m in meta {
        map.insert(m.key, m.value);
    }
    Ok(map)
}

// -- Raw transaction commands --

#[tauri::command]
pub fn store_raw_transaction(
    state: State<'_, AppState>,
    source: String,
    data: String,
) -> Result<(), String> {
    state
        .engine
        .store_raw_transaction(&source, &data)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_raw_transaction(
    state: State<'_, AppState>,
    source: String,
) -> Result<Option<String>, String> {
    state
        .engine
        .get_raw_transaction(&source)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn query_raw_transactions(
    state: State<'_, AppState>,
    source_prefix: String,
) -> Result<Vec<(String, String)>, String> {
    state
        .engine
        .query_raw_transactions(&source_prefix)
        .map_err(|e| e.to_string())
}

// -- Hidden currency commands --

#[tauri::command]
pub fn set_currency_hidden(state: State<'_, AppState>, code: String, is_hidden: bool) -> Result<(), String> {
    state
        .engine
        .set_currency_hidden(&code, is_hidden)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_hidden_currencies(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    state
        .engine
        .list_hidden_currencies()
        .map_err(|e| e.to_string())
}

// -- Currency rate source commands --

#[tauri::command]
pub fn get_currency_rate_sources(state: State<'_, AppState>) -> Result<Vec<CurrencyRateSource>, String> {
    state
        .engine
        .get_currency_rate_sources()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_currency_rate_source(state: State<'_, AppState>, currency: String, rate_source: String, set_by: String) -> Result<(), String> {
    state
        .engine
        .set_currency_rate_source(&currency, &rate_source, &set_by)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_auto_rate_sources(state: State<'_, AppState>) -> Result<(), String> {
    state
        .engine
        .clear_auto_rate_sources()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_non_user_rate_sources(state: State<'_, AppState>) -> Result<(), String> {
    state
        .engine
        .clear_non_user_rate_sources()
        .map_err(|e| e.to_string())
}

// -- Integrity check commands --

#[tauri::command]
pub fn count_orphaned_line_items(state: State<'_, AppState>) -> Result<u64, String> {
    state
        .engine
        .count_orphaned_line_items()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn count_duplicate_sources(state: State<'_, AppState>) -> Result<u64, String> {
    state
        .engine
        .count_duplicate_sources()
        .map_err(|e| e.to_string())
}

// -- Balance assertion commands --

#[tauri::command]
pub fn create_balance_assertion(state: State<'_, AppState>, assertion: BalanceAssertion) -> Result<(), String> {
    state
        .engine
        .create_balance_assertion(&assertion)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_balance_assertions(state: State<'_, AppState>, account_id: Option<Uuid>) -> Result<Vec<BalanceAssertion>, String> {
    state
        .engine
        .list_balance_assertions(account_id.as_ref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn check_balance_assertions(state: State<'_, AppState>) -> Result<Vec<BalanceAssertion>, String> {
    state
        .engine
        .check_all_balance_assertions()
        .map_err(|e| e.to_string())
}

// -- Budget commands --

#[tauri::command]
pub fn create_budget(state: State<'_, AppState>, budget: Budget) -> Result<(), String> {
    state.engine.create_budget(&budget).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_budgets(state: State<'_, AppState>) -> Result<Vec<Budget>, String> {
    state.engine.list_budgets().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_budget(state: State<'_, AppState>, budget: Budget) -> Result<(), String> {
    state.engine.update_budget(&budget).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_budget(state: State<'_, AppState>, id: Uuid) -> Result<(), String> {
    state.engine.delete_budget(&id).map_err(|e| e.to_string())
}

// -- Reconciliation commands --

#[tauri::command]
pub fn get_unreconciled_line_items(
    state: State<'_, AppState>,
    account_id: Uuid,
    currency: String,
    up_to_date: Option<NaiveDate>,
) -> Result<Vec<UnreconciledLineItem>, String> {
    state.engine
        .get_unreconciled_line_items(&account_id, &currency, up_to_date)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mark_reconciled(
    state: State<'_, AppState>,
    reconciliation: Reconciliation,
    line_item_ids: Vec<Uuid>,
) -> Result<(), String> {
    state.engine
        .mark_reconciled(&reconciliation, &line_item_ids)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_reconciliations(
    state: State<'_, AppState>,
    account_id: Option<Uuid>,
) -> Result<Vec<Reconciliation>, String> {
    state.engine
        .list_reconciliations(account_id.as_ref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_reconciliation_detail(
    state: State<'_, AppState>,
    id: Uuid,
) -> Result<Option<(Reconciliation, Vec<Uuid>)>, String> {
    state.engine
        .get_reconciliation_detail(&id)
        .map_err(|e| e.to_string())
}

// -- Recurring template commands --

#[tauri::command]
pub fn create_recurring_template(
    state: State<'_, AppState>,
    template: RecurringTemplate,
) -> Result<(), String> {
    state.engine
        .create_recurring_template(&template)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_recurring_templates(state: State<'_, AppState>) -> Result<Vec<RecurringTemplate>, String> {
    state.engine
        .list_recurring_templates()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_recurring_template(
    state: State<'_, AppState>,
    template: RecurringTemplate,
) -> Result<(), String> {
    state.engine
        .update_recurring_template(&template)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_recurring_template(state: State<'_, AppState>, id: Uuid) -> Result<(), String> {
    state.engine
        .delete_recurring_template(&id)
        .map_err(|e| e.to_string())
}

// -- Pagination command --

#[tauri::command]
pub fn count_journal_entries(
    state: State<'_, AppState>,
    filter: TransactionFilter,
) -> Result<u64, String> {
    state.engine
        .count_journal_entries(&filter)
        .map_err(|e| e.to_string())
}

// -- Exchange account commands (CEX) --

#[tauri::command]
pub fn list_exchange_accounts(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    state.engine.list_exchange_accounts().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_exchange_account(
    state: State<'_, AppState>,
    account: serde_json::Value,
) -> Result<(), String> {
    state.engine.add_exchange_account(&account).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_exchange_account(
    state: State<'_, AppState>,
    id: String,
    updates: serde_json::Value,
) -> Result<(), String> {
    state.engine.update_exchange_account(&id, &updates).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_exchange_account(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.engine.remove_exchange_account(&id).map_err(|e| e.to_string())
}

// -- Currency token address commands --

#[tauri::command]
pub fn set_currency_token_address(state: State<'_, AppState>, currency: String, chain: String, contract_address: String) -> Result<(), String> {
    state.engine.set_currency_token_address(&currency, &chain, &contract_address).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_currency_token_addresses(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let rows = state.engine.get_currency_token_addresses().map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|(currency, chain, contract_address)| {
        serde_json::json!({ "currency": currency, "chain": chain, "contract_address": contract_address })
    }).collect())
}

#[tauri::command]
pub fn get_currency_token_address(state: State<'_, AppState>, currency: String) -> Result<Option<serde_json::Value>, String> {
    let result = state.engine.get_currency_token_address(&currency).map_err(|e| e.to_string())?;
    Ok(result.map(|(chain, contract_address)| {
        serde_json::json!({ "chain": chain, "contract_address": contract_address })
    }))
}

// -- HTTP proxy command (bypasses CORS for APIs that don't support it) --

#[tauri::command]
pub fn proxy_fetch(
    url: String,
    method: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut resp = if method == "POST" {
        let mut req = ureq::post(&url);
        for (k, v) in &headers {
            req = req.header(k, v);
        }
        req.send(body.as_deref().unwrap_or(""))
            .map_err(|e| e.to_string())?
    } else {
        let mut req = ureq::get(&url);
        for (k, v) in &headers {
            req = req.header(k, v);
        }
        req.call().map_err(|e| e.to_string())?
    };

    let status = resp.status().as_u16();
    let body_str: String = resp.body_mut().read_to_string().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "status": status, "body": body_str }))
}

// -- Etherscan commands --

#[tauri::command]
pub fn list_supported_chains() -> Vec<ChainInfo> {
    SUPPORTED_CHAINS.to_vec()
}

#[tauri::command]
pub fn list_etherscan_accounts(
    state: State<'_, EtherscanState>,
) -> Result<Vec<EtherscanAccount>, String> {
    state.list_accounts()
}

#[tauri::command]
pub fn add_etherscan_account(
    state: State<'_, EtherscanState>,
    address: String,
    chain_id: u64,
    label: String,
) -> Result<(), String> {
    state.add_account(&address, chain_id, &label)
}

#[tauri::command]
pub fn remove_etherscan_account(
    state: State<'_, EtherscanState>,
    address: String,
    chain_id: u64,
) -> Result<(), String> {
    state.remove_account(&address, chain_id)
}

