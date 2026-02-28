use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::State;

use dprice::config::DpriceConfig;
use dprice::cross_rate;
use dprice::db::PriceDb;

pub struct DpriceState {
    pub db_path: PathBuf,
    pub config: DpriceConfig,
    pub syncing: AtomicBool,
}

#[derive(Serialize)]
pub struct DpriceHealthResponse {
    pub assets: i64,
    pub prices: i64,
}

#[derive(Serialize)]
pub struct DpriceRateEntry {
    pub from: String,
    pub to: String,
    pub rate: String,
}

#[derive(Serialize)]
pub struct DpricePriceEntry {
    pub date: String,
    pub price_usd: String,
}

#[tauri::command]
pub async fn dprice_health(
    state: State<'_, DpriceState>,
) -> Result<DpriceHealthResponse, String> {
    let db_path = state.db_path.clone();
    tokio::task::spawn_blocking(move || {
        let db = PriceDb::open_readonly(&db_path).map_err(|e| e.to_string())?;
        let assets = db.count_assets().map_err(|e| e.to_string())?;
        let prices = db.count_prices().map_err(|e| e.to_string())?;
        Ok(DpriceHealthResponse { assets, prices })
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn dprice_get_rate(
    state: State<'_, DpriceState>,
    from: String,
    to: String,
    date: Option<String>,
) -> Result<Option<String>, String> {
    let db_path = state.db_path.clone();
    let date = date.unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%d").to_string());
    tokio::task::spawn_blocking(move || {
        let db = PriceDb::open_readonly(&db_path).map_err(|e| e.to_string())?;
        let rate =
            cross_rate::get_rate(&db, &from, &to, &date).map_err(|e| e.to_string())?;
        Ok(rate.map(|r| r.to_string()))
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn dprice_get_rates(
    state: State<'_, DpriceState>,
    currencies: Vec<String>,
    date: Option<String>,
) -> Result<Vec<DpriceRateEntry>, String> {
    let db_path = state.db_path.clone();
    let date = date.unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%d").to_string());
    tokio::task::spawn_blocking(move || {
        let db = PriceDb::open_readonly(&db_path).map_err(|e| e.to_string())?;
        let matrix = cross_rate::get_rate_matrix(&db, &currencies, &date)
            .map_err(|e| e.to_string())?;
        Ok(matrix
            .into_iter()
            .filter_map(|(from, to, rate)| {
                rate.map(|r| DpriceRateEntry {
                    from,
                    to,
                    rate: r.to_string(),
                })
            })
            .collect())
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn dprice_get_price_range(
    state: State<'_, DpriceState>,
    symbol: String,
    from_date: String,
    to_date: String,
) -> Result<Vec<DpricePriceEntry>, String> {
    let db_path = state.db_path.clone();
    tokio::task::spawn_blocking(move || {
        let db = PriceDb::open_readonly(&db_path).map_err(|e| e.to_string())?;
        let prices = db
            .get_price_range(&symbol, &from_date, &to_date)
            .map_err(|e| e.to_string())?;
        Ok(prices
            .into_iter()
            .map(|(date, price_usd)| DpricePriceEntry {
                date,
                price_usd: price_usd.to_string(),
            })
            .collect())
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn dprice_sync_latest(state: State<'_, DpriceState>) -> Result<String, String> {
    // Guard: prevent concurrent syncs
    if state
        .syncing
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("sync already in progress".to_string());
    }

    let db_path = state.db_path.clone();
    let config = state.config.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let mut db = PriceDb::open(&db_path).map_err(|e| e.to_string())?;
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("runtime error: {e}"))?;
        rt.block_on(dprice::sync::run_sync(&mut db, &config, true, None))
            .map_err(|e| e.to_string())?;
        Ok("latest sync completed".to_string())
    })
    .await;

    state.syncing.store(false, Ordering::SeqCst);
    result.map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn dprice_latest_date(
    state: State<'_, DpriceState>,
) -> Result<Option<String>, String> {
    let db_path = state.db_path.clone();
    tokio::task::spawn_blocking(move || {
        let db = PriceDb::open_readonly(&db_path).map_err(|e| e.to_string())?;
        let date = db.get_global_latest_date().map_err(|e| e.to_string())?;
        Ok(date.map(|d| d.format("%Y-%m-%d").to_string()))
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn dprice_ensure_prices(
    state: State<'_, DpriceState>,
    requests: Vec<(String, String)>,
) -> Result<Vec<String>, String> {
    let db_path = state.db_path.clone();
    tokio::task::spawn_blocking(move || {
        let db = PriceDb::open_readonly(&db_path).map_err(|e| e.to_string())?;
        let mut missing = Vec::new();
        for (symbol, date) in requests {
            let price = db.get_price(&symbol, &date).map_err(|e| e.to_string())?;
            if price.is_none() {
                missing.push(symbol);
            }
        }
        missing.sort();
        missing.dedup();
        Ok(missing)
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn dprice_export_db(
    state: State<'_, DpriceState>,
) -> Result<Vec<u8>, String> {
    let db_path = state.db_path.clone();
    tokio::task::spawn_blocking(move || {
        std::fs::read(&db_path).map_err(|e| format!("failed to read dprice.db: {e}"))
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn dprice_import_db(
    state: State<'_, DpriceState>,
    data: Vec<u8>,
) -> Result<String, String> {
    let db_path = state.db_path.clone();
    tokio::task::spawn_blocking(move || {
        // Validate: write to a temp file first, try to open as dprice DB
        let tmp_path = db_path.with_extension("db.tmp");
        std::fs::write(&tmp_path, &data)
            .map_err(|e| format!("failed to write temp file: {e}"))?;
        match PriceDb::open_readonly(&tmp_path) {
            Ok(db) => {
                // Verify it has the expected schema by querying
                let _ = db.count_assets().map_err(|e| {
                    let _ = std::fs::remove_file(&tmp_path);
                    format!("invalid dprice database: {e}")
                })?;
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp_path);
                return Err(format!("invalid dprice database: {e}"));
            }
        }
        // Replace the actual DB
        std::fs::rename(&tmp_path, &db_path)
            .map_err(|e| format!("failed to replace dprice.db: {e}"))?;
        Ok("dprice database imported".to_string())
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn dprice_sync(state: State<'_, DpriceState>) -> Result<String, String> {
    // Guard: prevent concurrent syncs
    if state
        .syncing
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("sync already in progress".to_string());
    }

    let db_path = state.db_path.clone();
    let config = state.config.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let mut db = PriceDb::open(&db_path).map_err(|e| e.to_string())?;
        // run_sync is async (uses reqwest) — create a nested current-thread runtime
        // same pattern as dprice daemon.rs:run_one_sync
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("runtime error: {e}"))?;
        rt.block_on(dprice::sync::run_sync(&mut db, &config, false, None))
            .map_err(|e| e.to_string())?;
        Ok("sync completed".to_string())
    })
    .await;

    // Always clear syncing flag, regardless of result
    state.syncing.store(false, Ordering::SeqCst);

    result.map_err(|e| format!("task join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dprice_health() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let _db = PriceDb::open(&db_path).unwrap();

        let db = PriceDb::open_readonly(&db_path).unwrap();
        let assets = db.count_assets().unwrap();
        let prices = db.count_prices().unwrap();
        assert_eq!(assets, 0);
        assert_eq!(prices, 0);
    }

    #[test]
    fn test_dprice_get_rate() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let _db = PriceDb::open(&db_path).unwrap();

        let db = PriceDb::open_readonly(&db_path).unwrap();
        let rate = cross_rate::get_rate(&db, "BTC", "USD", "2024-01-01").unwrap();
        assert!(rate.is_none()); // No data in fresh DB
    }

    #[test]
    fn test_dprice_get_rates() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let _db = PriceDb::open(&db_path).unwrap();

        let db = PriceDb::open_readonly(&db_path).unwrap();
        let currencies = vec!["BTC".to_string(), "ETH".to_string(), "USD".to_string()];
        let matrix = cross_rate::get_rate_matrix(&db, &currencies, "2024-01-01").unwrap();
        // No data → all rates are None, so filter_map yields empty
        let with_rates: Vec<_> = matrix.into_iter().filter(|(_, _, r)| r.is_some()).collect();
        assert!(with_rates.is_empty());
    }

    #[test]
    fn test_dprice_get_price_range() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let _db = PriceDb::open(&db_path).unwrap();

        let db = PriceDb::open_readonly(&db_path).unwrap();
        let prices = db.get_price_range("BTC", "2024-01-01", "2024-12-31").unwrap();
        assert!(prices.is_empty());
    }

    #[test]
    fn test_dprice_latest_date_empty() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let _db = PriceDb::open(&db_path).unwrap();

        let db = PriceDb::open_readonly(&db_path).unwrap();
        let date = db.get_global_latest_date().unwrap();
        assert!(date.is_none());
    }

    #[test]
    fn test_dprice_ensure_prices() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let _db = PriceDb::open(&db_path).unwrap();

        let db = PriceDb::open_readonly(&db_path).unwrap();
        // No data → all requests should be missing
        let price = db.get_price("BTC", "2024-01-01").unwrap();
        assert!(price.is_none());
    }

    #[test]
    fn test_dprice_export_import() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        // Create DB with schema
        let _db = PriceDb::open(&db_path).unwrap();
        drop(_db);

        // Export: read the file bytes
        let data = std::fs::read(&db_path).unwrap();
        assert!(!data.is_empty());

        // Import: write to a new path and validate via open_readonly
        let import_path = dir.path().join("imported.db");
        std::fs::write(&import_path, &data).unwrap();
        let db = PriceDb::open_readonly(&import_path).unwrap();
        assert_eq!(db.count_assets().unwrap(), 0);
        assert_eq!(db.count_prices().unwrap(), 0);
    }

    #[test]
    fn test_dprice_import_invalid_rejects() {
        let dir = tempfile::tempdir().unwrap();
        let bad_path = dir.path().join("bad.db");
        std::fs::write(&bad_path, b"not a database").unwrap();

        // open_readonly may succeed, but queries on an invalid file should fail
        match PriceDb::open_readonly(&bad_path) {
            Err(_) => {} // open itself failed — good
            Ok(db) => {
                // If open succeeded, querying should fail
                assert!(db.count_assets().is_err());
            }
        }
    }
}
