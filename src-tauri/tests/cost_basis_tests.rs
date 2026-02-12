use std::path::PathBuf;
use std::sync::Arc;

use dledger_core::LedgerEngine;
use dledger_lib::db::{apply_migrations, SqliteStorage};
use dledger_lib::plugin::PluginManager;
use tempfile::TempDir;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("plugins")
}

fn setup_engine() -> (Arc<LedgerEngine>, TempDir) {
    let tmp = TempDir::new().expect("failed to create temp dir");
    let db_path = tmp.path().join("test.db");
    let storage = SqliteStorage::new(db_path.to_str().unwrap()).expect("failed to create storage");
    apply_migrations(&storage).expect("failed to apply migrations");
    let engine = Arc::new(LedgerEngine::new(Box::new(storage)));

    let eur = dledger_core::models::Currency {
        code: "EUR".to_string(),
        name: "Euro".to_string(),
        decimal_places: 2,
        is_base: true,
    };
    engine.create_currency(&eur).expect("failed to create EUR");

    let btc = dledger_core::models::Currency {
        code: "BTC".to_string(),
        name: "Bitcoin".to_string(),
        decimal_places: 8,
        is_base: false,
    };
    engine.create_currency(&btc).expect("failed to create BTC");

    let eth = dledger_core::models::Currency {
        code: "ETH".to_string(),
        name: "Ethereum".to_string(),
        decimal_places: 18,
        is_base: false,
    };
    engine.create_currency(&eth).expect("failed to create ETH");

    (engine, tmp)
}

fn setup_manager(engine: Arc<LedgerEngine>, tmp: &TempDir) -> PluginManager {
    let plugins_dir = tmp.path().join("plugins");
    copy_dir_all(&fixtures_dir(), &plugins_dir).expect("failed to copy fixtures");

    let kv_db_path = tmp.path().join("plugins.db");
    PluginManager::new(plugins_dir, kv_db_path.to_str().unwrap(), engine)
        .expect("failed to create PluginManager")
}

fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_all(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

/// Mock Kraken trades: buy 0.5 BTC @ 40000, then sell 0.25 BTC @ 42000
const MOCK_BTC_TRADES: &str = r#"{
    "error": [],
    "result": {
        "trades": {
            "TXID-001": {
                "pair": "XXBTZEUR",
                "time": 1704067200.0,
                "type": "buy",
                "vol": "0.50000000",
                "price": "40000.00",
                "cost": "20000.00",
                "fee": "32.00"
            },
            "TXID-002": {
                "pair": "XXBTZEUR",
                "time": 1706745600.0,
                "type": "sell",
                "vol": "0.25000000",
                "price": "42000.00",
                "cost": "10500.00",
                "fee": "16.80"
            }
        },
        "count": 2
    }
}"#;

fn populate_with_kraken_trades(manager: &mut PluginManager) {
    manager.discover().expect("discovery failed");

    let config = vec![
        ("api_key".into(), "test-key".into()),
        ("api_secret".into(), "dGVzdC1zZWNyZXQ=".into()),
        ("base_currency".into(), "EUR".into()),
        ("mock_data".into(), MOCK_BTC_TRADES.into()),
    ];
    manager
        .configure_plugin("kraken", config)
        .expect("configure failed");

    manager.sync_source("kraken").expect("sync failed");
}

fn handler_config() -> Vec<(String, String)> {
    vec![("base_currency".into(), "EUR".into())]
}

#[test]
fn test_cost_basis_discovery() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    let plugins = manager.discover().expect("discovery failed");
    let cb = plugins.iter().find(|p| p.id == "cost-basis");

    assert!(cb.is_some(), "should discover cost-basis plugin");
    let c = cb.unwrap();
    assert_eq!(c.name, "Cost Basis Calculator");
    assert_eq!(c.kind, "handler");
}

#[test]
fn test_cost_basis_configure() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    manager.discover().expect("discovery failed");
    let result = manager.configure_plugin("cost-basis", handler_config());
    assert!(result.is_ok(), "configure should succeed");
}

#[test]
fn test_cost_basis_process_with_trades() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    populate_with_kraken_trades(&mut manager);
    manager
        .configure_plugin("cost-basis", handler_config())
        .expect("configure failed");

    let result = manager
        .run_handler("cost-basis", "{}")
        .expect("process failed");

    // Should contain BTC asset data
    assert!(
        result.contains("BTC"),
        "report should mention BTC, got: {}",
        result
    );
    assert!(
        result.contains("assets"),
        "report should have assets section, got: {}",
        result
    );
}

#[test]
fn test_cost_basis_fifo_gain_calculation() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    populate_with_kraken_trades(&mut manager);
    manager
        .configure_plugin("cost-basis", handler_config())
        .expect("configure failed");

    let result = manager
        .run_handler("cost-basis", "{}")
        .expect("process failed");

    // Buy 0.5 BTC @ 40000 EUR = 20000 EUR cost
    // Sell 0.25 BTC @ 42000 EUR = 10500 EUR proceeds
    // FIFO cost basis for 0.25 BTC = 0.25 * 40000 = 10000 EUR
    // Gain = 10500 - 10000 = 500 EUR
    assert!(
        result.contains("500"),
        "should show ~500 EUR gain, got: {}",
        result
    );
}

#[test]
fn test_cost_basis_remaining_holdings() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    populate_with_kraken_trades(&mut manager);
    manager
        .configure_plugin("cost-basis", handler_config())
        .expect("configure failed");

    let result = manager
        .run_handler("cost-basis", "{}")
        .expect("process failed");

    // Should have remaining BTC holdings (0.25 BTC bought, 0.25 BTC sold leaves 0.25)
    assert!(
        result.contains("holdings"),
        "report should have holdings section, got: {}",
        result
    );
    assert!(
        result.contains("0.25"),
        "should show 0.25 BTC remaining, got: {}",
        result
    );
}

#[test]
fn test_cost_basis_csv_report() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    populate_with_kraken_trades(&mut manager);
    manager
        .configure_plugin("cost-basis", handler_config())
        .expect("configure failed");

    let csv_bytes = manager
        .generate_report("cost-basis", "csv", "{}")
        .expect("report generation failed");

    let csv = String::from_utf8(csv_bytes).expect("invalid UTF-8");

    assert!(
        csv.contains("Asset,Acquired Date,Disposed Date"),
        "CSV should have header, got: {}",
        csv
    );
    assert!(
        csv.contains("BTC"),
        "CSV should contain BTC disposals, got: {}",
        csv
    );
}

#[test]
fn test_cost_basis_json_report() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    populate_with_kraken_trades(&mut manager);
    manager
        .configure_plugin("cost-basis", handler_config())
        .expect("configure failed");

    let json_bytes = manager
        .generate_report("cost-basis", "json", "{}")
        .expect("report generation failed");

    let json = String::from_utf8(json_bytes).expect("invalid UTF-8");

    assert!(
        json.contains("total_gain_loss"),
        "JSON should have total_gain_loss, got: {}",
        json
    );
}

#[test]
fn test_cost_basis_empty_ledger() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    manager.discover().expect("discovery failed");
    manager
        .configure_plugin("cost-basis", handler_config())
        .expect("configure failed");

    let result = manager
        .run_handler("cost-basis", "{}")
        .expect("process failed");

    // Empty ledger: no assets, no gains
    assert!(
        result.contains("\"total_gain_loss\":\"0.00\""),
        "empty ledger should show 0 gain/loss, got: {}",
        result
    );
}

#[test]
fn test_cost_basis_unsupported_format() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    manager.discover().expect("discovery failed");
    manager
        .configure_plugin("cost-basis", handler_config())
        .expect("configure failed");

    let result = manager.generate_report("cost-basis", "pdf", "{}");
    assert!(
        result.is_err(),
        "PDF format should not be supported yet"
    );
}
