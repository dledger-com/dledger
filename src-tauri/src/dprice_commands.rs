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
}
