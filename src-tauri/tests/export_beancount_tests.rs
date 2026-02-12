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

/// Mock Kraken trades for test data
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
fn test_beancount_discovery() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    let plugins = manager.discover().expect("discovery failed");
    let bc = plugins.iter().find(|p| p.id == "export-beancount");

    assert!(bc.is_some(), "should discover export-beancount plugin");
    let b = bc.unwrap();
    assert_eq!(b.name, "Beancount Export");
    assert_eq!(b.kind, "handler");
}

#[test]
fn test_beancount_process_summary() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    populate_with_kraken_trades(&mut manager);
    manager
        .configure_plugin("export-beancount", handler_config())
        .expect("configure failed");

    let result = manager
        .run_handler("export-beancount", "{}")
        .expect("process failed");

    assert!(
        result.contains("\"format\":\"beancount\""),
        "should report beancount format, got: {}",
        result
    );
    assert!(
        result.contains("\"transactions\":2"),
        "should report 2 transactions, got: {}",
        result
    );
}

#[test]
fn test_beancount_export_has_header() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    populate_with_kraken_trades(&mut manager);
    manager
        .configure_plugin("export-beancount", handler_config())
        .expect("configure failed");

    let bytes = manager
        .generate_report("export-beancount", "beancount", "{}")
        .expect("report generation failed");

    let output = String::from_utf8(bytes).expect("invalid UTF-8");

    assert!(
        output.contains("option \"operating_currency\" \"EUR\""),
        "should have operating_currency option, got:\n{}",
        &output[..output.len().min(500)]
    );
}

#[test]
fn test_beancount_export_has_account_open_directives() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    populate_with_kraken_trades(&mut manager);
    manager
        .configure_plugin("export-beancount", handler_config())
        .expect("configure failed");

    let bytes = manager
        .generate_report("export-beancount", "beancount", "{}")
        .expect("report generation failed");

    let output = String::from_utf8(bytes).expect("invalid UTF-8");

    // Should have "open" directives for accounts
    assert!(
        output.contains(" open Assets:"),
        "should have Assets open directive, got:\n{}",
        &output[..output.len().min(1000)]
    );
    assert!(
        output.contains(" open Equity:"),
        "should have Equity open directive, got:\n{}",
        &output[..output.len().min(1000)]
    );
    assert!(
        output.contains(" open Expenses:"),
        "should have Expenses open directive, got:\n{}",
        &output[..output.len().min(1000)]
    );
}

#[test]
fn test_beancount_export_has_transactions() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    populate_with_kraken_trades(&mut manager);
    manager
        .configure_plugin("export-beancount", handler_config())
        .expect("configure failed");

    let bytes = manager
        .generate_report("export-beancount", "beancount", "{}")
        .expect("report generation failed");

    let output = String::from_utf8(bytes).expect("invalid UTF-8");

    // Should have transaction directives with * flag
    assert!(
        output.contains("2024-01-01 * \""),
        "should have dated transaction directive, got:\n{}",
        &output[..output.len().min(2000)]
    );

    // Should have BTC postings
    assert!(
        output.contains("BTC"),
        "should contain BTC in postings"
    );
    assert!(
        output.contains("EUR"),
        "should contain EUR in postings"
    );
}

#[test]
fn test_beancount_export_account_type_mapping() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    populate_with_kraken_trades(&mut manager);
    manager
        .configure_plugin("export-beancount", handler_config())
        .expect("configure failed");

    let bytes = manager
        .generate_report("export-beancount", "beancount", "{}")
        .expect("report generation failed");

    let output = String::from_utf8(bytes).expect("invalid UTF-8");

    // Revenue accounts should be mapped to Income in beancount
    // Equity accounts should remain Equity
    // Asset accounts should be Assets
    assert!(
        output.contains("Assets:Exchange:Kraken:BTC"),
        "asset accounts should use Assets: root, got:\n{}",
        &output[..output.len().min(2000)]
    );
}

#[test]
fn test_beancount_empty_ledger() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    manager.discover().expect("discovery failed");
    manager
        .configure_plugin("export-beancount", handler_config())
        .expect("configure failed");

    let bytes = manager
        .generate_report("export-beancount", "beancount", "{}")
        .expect("report generation failed");

    let output = String::from_utf8(bytes).expect("invalid UTF-8");

    assert!(
        output.contains("option \"operating_currency\""),
        "empty export should still have header"
    );
    // No transactions, so no transaction directives
    assert!(
        !output.contains(" * \""),
        "empty export should have no transactions"
    );
}

#[test]
fn test_beancount_unsupported_format() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    manager.discover().expect("discovery failed");
    manager
        .configure_plugin("export-beancount", handler_config())
        .expect("configure failed");

    let result = manager.generate_report("export-beancount", "csv", "{}");
    assert!(
        result.is_err(),
        "CSV format should not be supported for beancount export"
    );
}
