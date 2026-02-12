use std::sync::Mutex;

use tauri::State;

use crate::plugin::PluginManager;

pub struct PluginManagerState {
    pub manager: Mutex<PluginManager>,
}

#[tauri::command]
pub fn discover_plugins(
    state: State<'_, PluginManagerState>,
) -> Result<Vec<crate::plugin::PluginInfo>, String> {
    let mut manager = state.manager.lock().map_err(|e| e.to_string())?;
    manager.discover()
}

#[tauri::command]
pub fn list_plugins(
    state: State<'_, PluginManagerState>,
) -> Result<Vec<crate::plugin::PluginInfo>, String> {
    let manager = state.manager.lock().map_err(|e| e.to_string())?;
    Ok(manager.list_plugins())
}

#[tauri::command]
pub fn configure_plugin(
    state: State<'_, PluginManagerState>,
    plugin_id: String,
    config: Vec<(String, String)>,
) -> Result<(), String> {
    let mut manager = state.manager.lock().map_err(|e| e.to_string())?;
    manager.configure_plugin(&plugin_id, config)
}

#[tauri::command]
pub fn sync_plugin(
    state: State<'_, PluginManagerState>,
    plugin_id: String,
) -> Result<String, String> {
    let manager = state.manager.lock().map_err(|e| e.to_string())?;
    let result = manager.sync_source(&plugin_id)?;
    serde_json::to_string(&result.summary).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn run_handler_plugin(
    state: State<'_, PluginManagerState>,
    plugin_id: String,
    params: String,
) -> Result<String, String> {
    let manager = state.manager.lock().map_err(|e| e.to_string())?;
    manager.run_handler(&plugin_id, &params)
}

#[tauri::command]
pub fn generate_report_plugin(
    state: State<'_, PluginManagerState>,
    plugin_id: String,
    format: String,
    params: String,
) -> Result<Vec<u8>, String> {
    let manager = state.manager.lock().map_err(|e| e.to_string())?;
    manager.generate_report(&plugin_id, &format, &params)
}

/// Import transactions from CSV data. Convenience command that configures
/// the csv-import plugin and runs a sync in one step.
#[tauri::command]
pub fn import_csv(
    state: State<'_, PluginManagerState>,
    csv_data: String,
    account: String,
    contra_account: String,
    currency: String,
    date_column: u32,
    description_column: u32,
    amount_column: u32,
    date_format: String,
    skip_header: bool,
    delimiter: String,
) -> Result<String, String> {
    let mut manager = state.manager.lock().map_err(|e| e.to_string())?;

    // Ensure csv-import plugin is discovered
    let plugins = manager.list_plugins();
    if !plugins.iter().any(|p| p.id == "csv-import") {
        manager.discover()?;
    }

    let config = vec![
        ("account".to_string(), account),
        ("contra_account".to_string(), contra_account),
        ("account_type".to_string(), "asset".to_string()),
        ("contra_account_type".to_string(), "expense".to_string()),
        ("currency".to_string(), currency),
        ("date_column".to_string(), date_column.to_string()),
        ("description_column".to_string(), description_column.to_string()),
        ("amount_column".to_string(), amount_column.to_string()),
        ("date_format".to_string(), date_format),
        ("skip_header".to_string(), skip_header.to_string()),
        ("delimiter".to_string(), delimiter),
        ("csv_data".to_string(), csv_data),
    ];

    manager.configure_plugin("csv-import", config)?;
    let result = manager.sync_source("csv-import")?;
    Ok(result.summary)
}
