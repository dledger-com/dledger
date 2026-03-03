mod commands;
pub mod db;
mod dprice_commands;
mod etherscan;

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, RwLock};

use tauri::Manager;

use commands::AppState;
use db::{apply_migrations, SqliteStorage};
use dledger_core::LedgerEngine;
use dprice_commands::{DpriceMode, DpriceState};
use etherscan::EtherscanState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("dledger.db");

            let db_path_str = db_path
                .to_str()
                .ok_or("invalid db path")?;

            let storage =
                SqliteStorage::new(db_path_str).map_err(|e| e.to_string())?;

            apply_migrations(&storage).map_err(|e| e.to_string())?;

            let engine = Arc::new(LedgerEngine::new(Box::new(storage)));

            app.manage(AppState {
                engine: engine.clone(),
            });

            let etherscan_state =
                EtherscanState::new(db_path_str).map_err(|e| e.to_string())?;
            app.manage(etherscan_state);

            // Initialize dprice: co-located DB in app data dir + local XDG path
            let dprice_integrated_path = data_dir.join("dprice.db");
            // Open once to create DB and run migrations, then close
            let _dprice_db = dprice::db::PriceDb::open(&dprice_integrated_path)
                .map_err(|e| e.to_string())?;
            let dprice_config = dprice::config::DpriceConfig::load()
                .unwrap_or_default();
            let dprice_local_path = dprice_config.resolved_db_path();
            app.manage(DpriceState {
                integrated_db_path: dprice_integrated_path,
                local_db_path: dprice_local_path,
                mode: RwLock::new(DpriceMode::Integrated),
                config: dprice_config,
                syncing: AtomicBool::new(false),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_currencies,
            commands::create_currency,
            commands::set_currency_asset_type,
            commands::list_accounts,
            commands::get_account,
            commands::create_account,
            commands::archive_account,
            commands::update_account,
            commands::post_journal_entry,
            commands::post_journal_entry_with_lots,
            commands::void_journal_entry,
            commands::get_journal_entry,
            commands::query_journal_entries,
            commands::get_account_balance,
            commands::get_account_balance_with_children,
            commands::record_exchange_rate,
            commands::get_exchange_rate,
            commands::get_exchange_rate_currencies_on_date,
            commands::list_exchange_rates,
            commands::trial_balance,
            commands::income_statement,
            commands::balance_sheet,
            commands::gain_loss_report,
            commands::import_ledger_file,
            commands::export_ledger_file,
            commands::get_currency_origins,
            commands::clear_exchange_rates,
            commands::clear_ledger_data,
            commands::clear_all_data,
            commands::list_supported_chains,
            commands::list_etherscan_accounts,
            commands::add_etherscan_account,
            commands::remove_etherscan_account,
            commands::set_metadata,
            commands::get_metadata,
            commands::store_raw_transaction,
            commands::get_raw_transaction,
            commands::query_raw_transactions,
            commands::set_currency_hidden,
            commands::list_hidden_currencies,
            commands::get_currency_rate_sources,
            commands::set_currency_rate_source,
            commands::clear_auto_rate_sources,
            commands::clear_non_user_rate_sources,
            commands::count_orphaned_line_items,
            commands::count_duplicate_sources,
            commands::create_balance_assertion,
            commands::list_balance_assertions,
            commands::check_balance_assertions,
            commands::query_entries_by_metadata,
            commands::set_entry_links,
            commands::get_entry_links,
            commands::get_entries_by_link,
            commands::get_all_link_names,
            commands::get_all_links_with_counts,
            commands::list_open_lots,
            commands::create_budget,
            commands::list_budgets,
            commands::update_budget,
            commands::delete_budget,
            commands::get_unreconciled_line_items,
            commands::mark_reconciled,
            commands::list_reconciliations,
            commands::get_reconciliation_detail,
            commands::create_recurring_template,
            commands::list_recurring_templates,
            commands::update_recurring_template,
            commands::delete_recurring_template,
            commands::count_journal_entries,
            commands::proxy_fetch,
            commands::list_exchange_accounts,
            commands::add_exchange_account,
            commands::update_exchange_account,
            commands::remove_exchange_account,
            commands::set_currency_token_address,
            commands::get_currency_token_addresses,
            commands::get_currency_token_address,
            dprice_commands::dprice_health,
            dprice_commands::dprice_get_rate,
            dprice_commands::dprice_get_rates,
            dprice_commands::dprice_get_price_range,
            dprice_commands::dprice_sync,
            dprice_commands::dprice_sync_latest,
            dprice_commands::dprice_latest_date,
            dprice_commands::dprice_ensure_prices,
            dprice_commands::dprice_export_db,
            dprice_commands::dprice_import_db,
            dprice_commands::dprice_set_mode,
            dprice_commands::dprice_local_db_path,
            dprice_commands::dprice_vacuum,
            dprice_commands::dprice_export_parquet,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
