mod commands;
pub mod db;
mod etherscan;

use std::sync::Arc;

use tauri::Manager;

use commands::AppState;
use db::{apply_migrations, SqliteStorage};
use dledger_core::LedgerEngine;
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

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_currencies,
            commands::create_currency,
            commands::list_accounts,
            commands::get_account,
            commands::create_account,
            commands::archive_account,
            commands::post_journal_entry,
            commands::post_journal_entry_with_lots,
            commands::void_journal_entry,
            commands::get_journal_entry,
            commands::query_journal_entries,
            commands::get_account_balance,
            commands::get_account_balance_with_children,
            commands::record_exchange_rate,
            commands::get_exchange_rate,
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
            commands::sync_etherscan,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
