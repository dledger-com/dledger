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

/// Mock Kraken trades in 2024: buy 0.5 BTC @ 40000 EUR, sell 0.25 BTC @ 42000 EUR
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

fn tax_config() -> Vec<(String, String)> {
    vec![
        ("base_currency".into(), "EUR".into()),
        ("fiscal_year".into(), "2024".into()),
    ]
}

#[test]
fn test_tax_report_discovery() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    let plugins = manager.discover().expect("discovery failed");
    let tr = plugins.iter().find(|p| p.id == "tax-report-fr");

    assert!(tr.is_some(), "should discover tax-report-fr plugin");
    let t = tr.unwrap();
    assert_eq!(t.name, "French Tax Report");
    assert_eq!(t.kind, "handler");
}

#[test]
fn test_tax_report_missing_fiscal_year() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    manager.discover().expect("discovery failed");

    let config = vec![("base_currency".into(), "EUR".into())];
    let result = manager.configure_plugin("tax-report-fr", config);
    assert!(
        result.is_err(),
        "should fail without fiscal year"
    );
}

#[test]
fn test_tax_report_empty_ledger() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    manager.discover().expect("discovery failed");
    manager
        .configure_plugin("tax-report-fr", tax_config())
        .expect("configure failed");

    let result = manager
        .run_handler("tax-report-fr", "{}")
        .expect("process failed");

    assert!(
        result.contains("\"fiscal_year\":2024"),
        "should report for fiscal year 2024, got: {}",
        result
    );
    assert!(
        result.contains("\"net_taxable\":\"0.00\""),
        "empty ledger should show 0 net taxable, got: {}",
        result
    );
}

#[test]
fn test_tax_report_with_trades() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    populate_with_kraken_trades(&mut manager);
    manager
        .configure_plugin("tax-report-fr", tax_config())
        .expect("configure failed");

    let result = manager
        .run_handler("tax-report-fr", "{}")
        .expect("process failed");

    // Should have cessions
    assert!(
        result.contains("cessions"),
        "report should have cessions section, got: {}",
        result
    );
    assert!(
        result.contains("BTC"),
        "cessions should mention BTC, got: {}",
        result
    );
}

#[test]
fn test_tax_report_cession_details() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    populate_with_kraken_trades(&mut manager);
    manager
        .configure_plugin("tax-report-fr", tax_config())
        .expect("configure failed");

    let result = manager
        .run_handler("tax-report-fr", "{}")
        .expect("process failed");

    // The sell is 0.25 BTC @ 42000 = 10500 EUR + 16.80 fee = 10516.80 cession price
    assert!(
        result.contains("10516.80"),
        "cession price should be ~10516.80 EUR, got: {}",
        result
    );

    // Should include fraction and plus_value fields
    assert!(
        result.contains("fraction"),
        "cession should have fraction field, got: {}",
        result
    );
    assert!(
        result.contains("plus_value"),
        "cession should have plus_value field, got: {}",
        result
    );
}

#[test]
fn test_tax_report_exchange_accounts_3916bis() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    populate_with_kraken_trades(&mut manager);
    manager
        .configure_plugin("tax-report-fr", tax_config())
        .expect("configure failed");

    let result = manager
        .run_handler("tax-report-fr", "{}")
        .expect("process failed");

    // Should list exchange accounts for 3916-bis
    assert!(
        result.contains("exchange_accounts"),
        "should include exchange accounts for 3916-bis, got: {}",
        result
    );
    assert!(
        result.contains("Kraken"),
        "should list Kraken as exchange platform, got: {}",
        result
    );
}

#[test]
fn test_tax_report_csv_export() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    populate_with_kraken_trades(&mut manager);
    manager
        .configure_plugin("tax-report-fr", tax_config())
        .expect("configure failed");

    let csv_bytes = manager
        .generate_report("tax-report-fr", "csv", "{}")
        .expect("report generation failed");

    let csv = String::from_utf8(csv_bytes).expect("invalid UTF-8");

    assert!(
        csv.contains("Date,Asset,Quantity,Cession Price"),
        "CSV should have header row, got: {}",
        csv
    );
    assert!(
        csv.contains("Net Taxable"),
        "CSV should include net taxable summary, got: {}",
        csv
    );
}

#[test]
fn test_tax_report_json_export() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    populate_with_kraken_trades(&mut manager);
    manager
        .configure_plugin("tax-report-fr", tax_config())
        .expect("configure failed");

    let json_bytes = manager
        .generate_report("tax-report-fr", "json", "{}")
        .expect("report generation failed");

    let json = String::from_utf8(json_bytes).expect("invalid UTF-8");

    assert!(
        json.contains("fiscal_year"),
        "JSON export should include fiscal_year, got: {}",
        json
    );
}
