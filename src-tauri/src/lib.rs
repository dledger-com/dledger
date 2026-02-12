mod commands;
pub mod db;
pub mod plugin;
mod plugin_commands;

use std::sync::{Arc, Mutex};

use tauri::Manager;

use commands::AppState;
use db::{apply_migrations, SqliteStorage};
use dledger_core::LedgerEngine;
use plugin::PluginManager;
use plugin_commands::PluginManagerState;

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

            // Set up plugin manager
            let plugins_dir = match std::env::var("DLEDGER_PLUGINS_DIR") {
                Ok(dir) => {
                    let path = std::path::PathBuf::from(&dir);
                    std::fs::canonicalize(&path).unwrap_or(path)
                }
                Err(_) => data_dir.join("plugins"),
            };
            let plugin_db_path = data_dir.join("plugins.db");
            let plugin_db_str = plugin_db_path
                .to_str()
                .ok_or("invalid plugin db path")?;

            let plugin_manager = PluginManager::new(
                plugins_dir,
                plugin_db_str,
                engine,
            )
            .map_err(|e| e.to_string())?;

            app.manage(PluginManagerState {
                manager: Mutex::new(plugin_manager),
            });

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
            plugin_commands::discover_plugins,
            plugin_commands::list_plugins,
            plugin_commands::configure_plugin,
            plugin_commands::sync_plugin,
            plugin_commands::run_handler_plugin,
            plugin_commands::generate_report_plugin,
            plugin_commands::import_csv,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
