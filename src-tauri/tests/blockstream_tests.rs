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

const TEST_ADDRESS: &str = "bc1qtest123456789012345678901234567890";

/// Mock Blockstream response: 1 incoming + 1 outgoing transaction.
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
    },
    {
        "txid": "tx_outgoing_001",
        "status": { "confirmed": true, "block_time": 1704153600 },
        "fee": 2000,
        "vin": [
            { "prevout": { "scriptpubkey_address": "bc1qtest123456789012345678901234567890", "value": 150000000 } }
        ],
        "vout": [
            { "scriptpubkey_address": "bc1qrecipient222", "value": 50000000 },
            { "scriptpubkey_address": "bc1qtest123456789012345678901234567890", "value": 99998000 }
        ]
    }
]"#;

/// Mock with unconfirmed transaction (should be skipped).
const MOCK_WITH_UNCONFIRMED: &str = r#"[
    {
        "txid": "tx_confirmed",
        "status": { "confirmed": true, "block_time": 1704067200 },
        "fee": 1000,
        "vin": [
            { "prevout": { "scriptpubkey_address": "bc1qsender111", "value": 100000000 } }
        ],
        "vout": [
            { "scriptpubkey_address": "bc1qtest123456789012345678901234567890", "value": 99999000 }
        ]
    },
    {
        "txid": "tx_unconfirmed",
        "status": { "confirmed": false },
        "fee": 500,
        "vin": [
            { "prevout": { "scriptpubkey_address": "bc1qtest123456789012345678901234567890", "value": 50000000 } }
        ],
        "vout": [
            { "scriptpubkey_address": "bc1qrecipient333", "value": 49999500 }
        ]
    }
]"#;

/// Mock empty response.
const MOCK_EMPTY: &str = "[]";

fn blockstream_config(mock_data: &str) -> Vec<(String, String)> {
    vec![
        ("address".into(), TEST_ADDRESS.into()),
        ("base_currency".into(), "EUR".into()),
        ("mock_data".into(), mock_data.into()),
    ]
}

#[test]
fn test_blockstream_discovery() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    let plugins = manager.discover().expect("discovery failed");
    let bs = plugins.iter().find(|p| p.id == "blockstream");

    assert!(bs.is_some(), "should discover blockstream plugin");
    let b = bs.unwrap();
    assert_eq!(b.name, "Blockstream BTC");
    assert_eq!(b.kind, "source");
    assert!(b.capabilities.http);
}

#[test]
fn test_blockstream_missing_address_fails() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    manager.discover().expect("discovery failed");

    let config = vec![
        ("base_currency".into(), "EUR".into()),
        ("mock_data".into(), MOCK_BTC_TXS.into()),
    ];

    let result = manager.configure_plugin("blockstream", config);
    assert!(result.is_err(), "should fail without address");
    assert!(
        result.unwrap_err().contains("address"),
        "error should mention address"
    );
}

#[test]
fn test_blockstream_basic_sync() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine.clone(), &tmp);

    manager.discover().expect("discovery failed");
    manager
        .configure_plugin("blockstream", blockstream_config(MOCK_BTC_TXS))
        .expect("configure failed");

    let result = manager.sync_source("blockstream").expect("sync failed");

    assert!(
        result.summary.contains("2"),
        "should import 2 transactions, got: {}",
        result.summary
    );

    let filter = dledger_core::models::TransactionFilter {
        account_id: None,
        from_date: None,
        to_date: None,
        status: None,
        source: Some("plugin:Blockstream BTC".to_string()),
        limit: Some(100),
        offset: Some(0),
    };
    let entries = engine.query_journal_entries(&filter).expect("query failed");
    assert_eq!(entries.len(), 2, "should have 2 journal entries");
}

#[test]
fn test_blockstream_accounts_created() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine.clone(), &tmp);

    manager.discover().expect("discovery failed");
    manager
        .configure_plugin("blockstream", blockstream_config(MOCK_BTC_TXS))
        .expect("configure failed");

    manager.sync_source("blockstream").expect("sync failed");

    let accounts = engine.list_accounts().expect("list_accounts failed");
    let names: Vec<&str> = accounts.iter().map(|a| a.full_name.as_str()).collect();

    assert!(
        names.contains(&"Assets:Crypto:BTC"),
        "should create BTC account, got: {names:?}"
    );
    assert!(
        names.contains(&"Expenses:Fees:Bitcoin"),
        "should create fee account, got: {names:?}"
    );
    assert!(
        names.contains(&"Equity:External:BTC"),
        "should create external account, got: {names:?}"
    );
}

#[test]
fn test_blockstream_incoming_tx() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine.clone(), &tmp);

    manager.discover().expect("discovery failed");
    manager
        .configure_plugin("blockstream", blockstream_config(MOCK_BTC_TXS))
        .expect("configure failed");

    manager.sync_source("blockstream").expect("sync failed");

    let filter = dledger_core::models::TransactionFilter {
        account_id: None,
        from_date: None,
        to_date: None,
        status: None,
        source: Some("plugin:Blockstream BTC".to_string()),
        limit: Some(100),
        offset: Some(0),
    };
    let entries = engine.query_journal_entries(&filter).expect("query failed");

    let receive = entries
        .iter()
        .find(|e| e.0.description.contains("Receive"))
        .expect("should have a Receive transaction");

    // Incoming: 1.5 BTC received (no fee for receiver)
    assert!(
        receive.0.description.contains("1.5"),
        "should receive 1.5 BTC, got: {}",
        receive.0.description
    );
    assert_eq!(
        receive.1.len(),
        2,
        "incoming should have 2 line items (no fee), got {}",
        receive.1.len()
    );
}

#[test]
fn test_blockstream_outgoing_tx_with_fee() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine.clone(), &tmp);

    manager.discover().expect("discovery failed");
    manager
        .configure_plugin("blockstream", blockstream_config(MOCK_BTC_TXS))
        .expect("configure failed");

    manager.sync_source("blockstream").expect("sync failed");

    let filter = dledger_core::models::TransactionFilter {
        account_id: None,
        from_date: None,
        to_date: None,
        status: None,
        source: Some("plugin:Blockstream BTC".to_string()),
        limit: Some(100),
        offset: Some(0),
    };
    let entries = engine.query_journal_entries(&filter).expect("query failed");

    let send = entries
        .iter()
        .find(|e| e.0.description.contains("Send"))
        .expect("should have a Send transaction");

    // Outgoing: spent 1.5 BTC, got back 0.99998 BTC change = net send 0.50002 BTC
    assert!(send.0.description.contains("BTC"));

    // Outgoing: 4 line items (send + external, fee + btc_account)
    assert_eq!(
        send.1.len(),
        4,
        "outgoing should have 4 line items (send + fee), got {}",
        send.1.len()
    );
}

#[test]
fn test_blockstream_balances() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine.clone(), &tmp);

    manager.discover().expect("discovery failed");
    manager
        .configure_plugin("blockstream", blockstream_config(MOCK_BTC_TXS))
        .expect("configure failed");

    manager.sync_source("blockstream").expect("sync failed");

    let accounts = engine.list_accounts().expect("list_accounts failed");

    let btc_account = accounts
        .iter()
        .find(|a| a.full_name == "Assets:Crypto:BTC")
        .expect("BTC account not found");

    let balance = engine
        .get_account_balance(&btc_account.id, None)
        .expect("balance query failed");

    assert_eq!(balance.len(), 1);
    assert_eq!(balance[0].currency, "BTC");

    // Received 1.5 BTC, then sent net ~0.50002 BTC, fee 0.00002 BTC
    // Input to tx2: 1.5 BTC, output to us: 0.99998 BTC, output to recipient: 0.5 BTC
    // Net sent = 1.5 - 0.99998 = 0.50002 BTC, fee = 0.00002 BTC
    // Balance = 1.5 - 0.50002 - 0.00002 = 0.99996 BTC
    let balance_str = balance[0].amount.to_string();
    assert!(
        balance_str.starts_with("0.99996"),
        "BTC balance should be ~0.99996, got {}",
        balance_str
    );
}

#[test]
fn test_blockstream_skips_unconfirmed() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine.clone(), &tmp);

    manager.discover().expect("discovery failed");
    manager
        .configure_plugin("blockstream", blockstream_config(MOCK_WITH_UNCONFIRMED))
        .expect("configure failed");

    let _result = manager.sync_source("blockstream").expect("sync failed");

    let filter = dledger_core::models::TransactionFilter {
        account_id: None,
        from_date: None,
        to_date: None,
        status: None,
        source: Some("plugin:Blockstream BTC".to_string()),
        limit: Some(100),
        offset: Some(0),
    };
    let entries = engine.query_journal_entries(&filter).expect("query failed");
    assert_eq!(
        entries.len(),
        1,
        "should have 1 entry (unconfirmed tx skipped), got {}",
        entries.len()
    );
}

#[test]
fn test_blockstream_empty_response() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    manager.discover().expect("discovery failed");
    manager
        .configure_plugin("blockstream", blockstream_config(MOCK_EMPTY))
        .expect("configure failed");

    let result = manager.sync_source("blockstream").expect("sync failed");

    assert!(
        result.summary.contains("No new transactions"),
        "should report no transactions, got: {}",
        result.summary
    );
    assert!(result.transactions.is_empty());
}
