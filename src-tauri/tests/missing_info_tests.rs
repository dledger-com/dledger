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

/// Mock Blockstream response with an incoming BTC tx.
/// This will create accounts with "External" in the name (Equity:External:BTC).
const MOCK_BTC_TXS: &str = r#"[
    {
        "txid": "tx_incoming_001",
        "status": { "confirmed": true, "block_time": 1704067200 },
        "fee": 1500,
        "vin": [
            { "prevout": { "scriptpubkey_address": "bc1qsender111", "value": 200000000 } }
        ],
        "vout": [
            { "scriptpubkey_address": "bc1qtest123456789012345678901234567890", "value": 150000000 },
            { "scriptpubkey_address": "bc1qchange111", "value": 49998500 }
        ]
    }
]"#;

const TEST_ADDRESS: &str = "bc1qtest123456789012345678901234567890";

fn populate_with_blockstream(manager: &mut PluginManager) {
    manager.discover().expect("discovery failed");

    let config = vec![
        ("address".into(), TEST_ADDRESS.into()),
        ("base_currency".into(), "EUR".into()),
        ("mock_data".into(), MOCK_BTC_TXS.into()),
    ];
    manager
        .configure_plugin("blockstream", config)
        .expect("configure failed");

    manager.sync_source("blockstream").expect("sync failed");
}

fn handler_config() -> Vec<(String, String)> {
    vec![("base_currency".into(), "EUR".into())]
}

#[test]
fn test_missing_info_discovery() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    let plugins = manager.discover().expect("discovery failed");
    let mi = plugins.iter().find(|p| p.id == "missing-info");

    assert!(mi.is_some(), "should discover missing-info plugin");
    let m = mi.unwrap();
    assert_eq!(m.name, "Missing Info Detector");
    assert_eq!(m.kind, "handler");
}

#[test]
fn test_missing_info_empty_ledger() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    manager.discover().expect("discovery failed");
    manager
        .configure_plugin("missing-info", handler_config())
        .expect("configure failed");

    let result = manager
        .run_handler("missing-info", "{}")
        .expect("process failed");

    assert!(
        result.contains("\"total\":0"),
        "empty ledger should have 0 issues, got: {}",
        result
    );
}

#[test]
fn test_missing_info_detects_external_accounts() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine.clone(), &tmp);

    // Blockstream creates "Equity:External:BTC" accounts
    populate_with_blockstream(&mut manager);

    manager
        .configure_plugin("missing-info", handler_config())
        .expect("configure failed");

    let result = manager
        .run_handler("missing-info", "{}")
        .expect("process failed");

    assert!(
        result.contains("unclassified_counterparty"),
        "should detect External account postings, got: {}",
        result
    );
}

#[test]
fn test_missing_info_detects_missing_exchange_rate() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine.clone(), &tmp);

    // Blockstream transactions have no exchange rate info (pure BTC on-chain)
    populate_with_blockstream(&mut manager);

    manager
        .configure_plugin("missing-info", handler_config())
        .expect("configure failed");

    let result = manager
        .run_handler("missing-info", "{}")
        .expect("process failed");

    assert!(
        result.contains("missing_exchange_rate"),
        "should detect missing BTC/EUR rate, got: {}",
        result
    );
}

#[test]
fn test_missing_info_severity_ordering() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine.clone(), &tmp);

    populate_with_blockstream(&mut manager);

    manager
        .configure_plugin("missing-info", handler_config())
        .expect("configure failed");

    let result = manager
        .run_handler("missing-info", "{}")
        .expect("process failed");

    // Errors should come before warnings
    if let (Some(err_pos), Some(warn_pos)) = (
        result.find("\"error\""),
        result.find("\"warning\""),
    ) {
        assert!(
            err_pos < warn_pos,
            "errors should appear before warnings in the output"
        );
    }
}

#[test]
fn test_missing_info_csv_report() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine.clone(), &tmp);

    populate_with_blockstream(&mut manager);

    manager
        .configure_plugin("missing-info", handler_config())
        .expect("configure failed");

    let csv_bytes = manager
        .generate_report("missing-info", "csv", "{}")
        .expect("report generation failed");

    let csv = String::from_utf8(csv_bytes).expect("invalid UTF-8");

    assert!(
        csv.contains("Severity,Category,Date"),
        "CSV should have header row, got: {}",
        csv
    );
}

#[test]
fn test_missing_info_with_exchange_trades() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    // Kraken trades have proper exchange rates built in (fiat + crypto in same tx)
    // So should NOT produce missing_exchange_rate issues
    let mock_kraken = r#"{
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
                }
            },
            "count": 1
        }
    }"#;

    manager.discover().expect("discovery failed");
    manager
        .configure_plugin(
            "kraken",
            vec![
                ("api_key".into(), "test-key".into()),
                ("api_secret".into(), "dGVzdC1zZWNyZXQ=".into()),
                ("base_currency".into(), "EUR".into()),
                ("mock_data".into(), mock_kraken.into()),
            ],
        )
        .expect("configure failed");
    manager.sync_source("kraken").expect("sync failed");

    manager
        .configure_plugin("missing-info", handler_config())
        .expect("configure failed");

    let result = manager
        .run_handler("missing-info", "{}")
        .expect("process failed");

    // Exchange trades include EUR amounts, so no missing rate issue
    assert!(
        !result.contains("missing_exchange_rate"),
        "exchange trades should not trigger missing rate, got: {}",
        result
    );
}
