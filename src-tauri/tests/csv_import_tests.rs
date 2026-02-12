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

const SAMPLE_CSV: &str = "\
Date,Description,Amount
2025-01-15,Grocery Store,-50.00
2025-01-16,Coffee Shop,-4.50
2025-01-20,Salary,3000.00
2025-01-25,Electric Bill,-120.00
";

fn csv_config(csv_data: &str) -> Vec<(String, String)> {
    vec![
        ("account".into(), "Assets:Bank:Checking".into()),
        ("contra_account".into(), "Expenses:Uncategorized".into()),
        ("account_type".into(), "asset".into()),
        ("contra_account_type".into(), "expense".into()),
        ("currency".into(), "EUR".into()),
        ("date_column".into(), "0".into()),
        ("description_column".into(), "1".into()),
        ("amount_column".into(), "2".into()),
        ("date_format".into(), "%Y-%m-%d".into()),
        ("skip_header".into(), "true".into()),
        ("delimiter".into(), ",".into()),
        ("csv_data".into(), csv_data.into()),
    ]
}

#[test]
fn test_csv_import_basic() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine.clone(), &tmp);

    manager.discover().expect("discovery failed");

    // Configure with CSV data
    manager
        .configure_plugin("csv-import", csv_config(SAMPLE_CSV))
        .expect("configure failed");

    // Run sync
    let result = manager.sync_source("csv-import").expect("sync failed");

    assert!(
        result.summary.contains("4"),
        "should import 4 transactions, got: {}",
        result.summary
    );

    // Verify transactions in ledger
    let filter = dledger_core::models::TransactionFilter {
        account_id: None,
        from_date: None,
        to_date: None,
        status: None,
        source: Some("plugin:CSV Import".to_string()),
        limit: Some(100),
        offset: Some(0),
    };
    let entries = engine.query_journal_entries(&filter).expect("query failed");
    assert_eq!(entries.len(), 4, "should have 4 journal entries");

    // Check that descriptions match CSV rows
    let descriptions: Vec<&str> = entries.iter().map(|e| e.0.description.as_str()).collect();
    assert!(descriptions.contains(&"Grocery Store"));
    assert!(descriptions.contains(&"Coffee Shop"));
    assert!(descriptions.contains(&"Salary"));
    assert!(descriptions.contains(&"Electric Bill"));

    // Each entry should have exactly 2 line items (debit + credit)
    for (_, items) in &entries {
        assert_eq!(items.len(), 2, "each entry should have 2 line items");
    }
}

#[test]
fn test_csv_import_accounts_created() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine.clone(), &tmp);

    manager.discover().expect("discovery failed");
    manager
        .configure_plugin("csv-import", csv_config(SAMPLE_CSV))
        .expect("configure failed");
    manager.sync_source("csv-import").expect("sync failed");

    let accounts = engine.list_accounts().expect("list_accounts failed");
    let names: Vec<&str> = accounts.iter().map(|a| a.full_name.as_str()).collect();

    assert!(
        names.contains(&"Assets:Bank:Checking"),
        "should create bank account, got: {names:?}"
    );
    assert!(
        names.contains(&"Expenses:Uncategorized"),
        "should create contra account, got: {names:?}"
    );
}

#[test]
fn test_csv_import_amounts_correct() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine.clone(), &tmp);

    manager.discover().expect("discovery failed");
    manager
        .configure_plugin("csv-import", csv_config(SAMPLE_CSV))
        .expect("configure failed");
    manager.sync_source("csv-import").expect("sync failed");

    // Get the checking account balance
    // Amounts: -50 + -4.50 + 3000 + -120 = 2825.50
    let accounts = engine.list_accounts().expect("list_accounts failed");
    let checking = accounts
        .iter()
        .find(|a| a.full_name == "Assets:Bank:Checking")
        .expect("checking account not found");

    let balance = engine
        .get_account_balance(&checking.id, None)
        .expect("balance query failed");

    assert_eq!(balance.len(), 1, "should have exactly one currency balance");
    assert_eq!(balance[0].currency, "EUR");

    let expected = rust_decimal_macros::dec!(2825.50);
    assert_eq!(
        balance[0].amount, expected,
        "checking balance should be 2825.50, got {}",
        balance[0].amount
    );
}

#[test]
fn test_csv_import_incremental() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine.clone(), &tmp);

    manager.discover().expect("discovery failed");
    manager
        .configure_plugin("csv-import", csv_config(SAMPLE_CSV))
        .expect("configure failed");

    // First sync: imports all 4 rows
    let result1 = manager.sync_source("csv-import").expect("sync 1 failed");
    assert!(result1.summary.contains("4"));

    // Second sync: no new rows
    let result2 = manager.sync_source("csv-import").expect("sync 2 failed");
    assert!(
        result2.summary.contains("No new rows"),
        "second sync should find no new rows, got: {}",
        result2.summary
    );

    // Verify no duplicate entries
    let filter = dledger_core::models::TransactionFilter {
        account_id: None,
        from_date: None,
        to_date: None,
        status: None,
        source: Some("plugin:CSV Import".to_string()),
        limit: Some(100),
        offset: Some(0),
    };
    let entries = engine.query_journal_entries(&filter).expect("query failed");
    assert_eq!(entries.len(), 4, "should still have only 4 entries after second sync");
}

#[test]
fn test_csv_import_european_date_format() {
    let csv = "\
Date;Description;Amount
15/01/2025;Boulangerie;-3,50
20/01/2025;Salaire;2500,00
";

    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine.clone(), &tmp);

    manager.discover().expect("discovery failed");

    let config = vec![
        ("account".into(), "Assets:Bank:BNP".into()),
        ("contra_account".into(), "Expenses:General".into()),
        ("account_type".into(), "asset".into()),
        ("contra_account_type".into(), "expense".into()),
        ("currency".into(), "EUR".into()),
        ("date_column".into(), "0".into()),
        ("description_column".into(), "1".into()),
        ("amount_column".into(), "2".into()),
        ("date_format".into(), "%d/%m/%Y".into()),
        ("skip_header".into(), "true".into()),
        ("delimiter".into(), ";".into()),
        ("csv_data".into(), csv.into()),
    ];

    manager
        .configure_plugin("csv-import", config)
        .expect("configure failed");

    let result = manager.sync_source("csv-import").expect("sync failed");
    assert!(
        result.summary.contains("2"),
        "should import 2 transactions, got: {}",
        result.summary
    );

    // Verify correct date parsing
    let filter = dledger_core::models::TransactionFilter {
        account_id: None,
        from_date: None,
        to_date: None,
        status: None,
        source: Some("plugin:CSV Import".to_string()),
        limit: Some(100),
        offset: Some(0),
    };
    let entries = engine.query_journal_entries(&filter).expect("query failed");
    assert_eq!(entries.len(), 2);

    // Check amounts (European comma decimal: -3,50 and 2500,00)
    let accounts = engine.list_accounts().expect("list_accounts failed");
    let bnp = accounts
        .iter()
        .find(|a| a.full_name == "Assets:Bank:BNP")
        .expect("BNP account not found");

    let balance = engine
        .get_account_balance(&bnp.id, None)
        .expect("balance query failed");

    // -3.50 + 2500.00 = 2496.50
    let expected = rust_decimal_macros::dec!(2496.50);
    assert_eq!(
        balance[0].amount, expected,
        "BNP balance should be 2496.50, got {}",
        balance[0].amount
    );
}

#[test]
fn test_csv_import_quoted_fields() {
    let csv = "\
Date,Description,Amount
2025-01-15,\"Smith, John - Payment\",-100.00
2025-01-16,\"Bill \"\"Premium\"\" Service\",-50.00
";

    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine.clone(), &tmp);

    manager.discover().expect("discovery failed");
    manager
        .configure_plugin("csv-import", csv_config(csv))
        .expect("configure failed");

    let result = manager.sync_source("csv-import").expect("sync failed");
    assert!(result.summary.contains("2"));

    let filter = dledger_core::models::TransactionFilter {
        account_id: None,
        from_date: None,
        to_date: None,
        status: None,
        source: Some("plugin:CSV Import".to_string()),
        limit: Some(100),
        offset: Some(0),
    };
    let entries = engine.query_journal_entries(&filter).expect("query failed");
    let descriptions: Vec<&str> = entries.iter().map(|e| e.0.description.as_str()).collect();

    assert!(
        descriptions.contains(&"Smith, John - Payment"),
        "should handle comma in quoted field, got: {descriptions:?}"
    );
    assert!(
        descriptions.contains(&"Bill \"Premium\" Service"),
        "should handle escaped quotes, got: {descriptions:?}"
    );
}

#[test]
fn test_csv_import_skips_invalid_rows() {
    let csv = "\
Date,Description,Amount
2025-01-15,Valid Entry,-50.00
not-a-date,Bad Date,100.00
2025-01-20,Another Valid,-30.00
2025-01-25,Empty Amount,
";

    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine.clone(), &tmp);

    manager.discover().expect("discovery failed");
    manager
        .configure_plugin("csv-import", csv_config(csv))
        .expect("configure failed");

    let result = manager.sync_source("csv-import").expect("sync failed");

    // Should import 2 valid + skip 2 invalid
    let filter = dledger_core::models::TransactionFilter {
        account_id: None,
        from_date: None,
        to_date: None,
        status: None,
        source: Some("plugin:CSV Import".to_string()),
        limit: Some(100),
        offset: Some(0),
    };
    let entries = engine.query_journal_entries(&filter).expect("query failed");
    assert_eq!(
        entries.len(),
        2,
        "should have 2 valid entries (skipped invalid), got {}",
        entries.len()
    );

    assert!(
        result.summary.contains("skipped"),
        "summary should mention skipped rows: {}",
        result.summary
    );
}

#[test]
fn test_csv_import_missing_config_fails() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    manager.discover().expect("discovery failed");

    // Missing csv_data
    let config = vec![
        ("account".into(), "Assets:Bank:Checking".into()),
        ("contra_account".into(), "Expenses:General".into()),
        ("currency".into(), "EUR".into()),
    ];

    let result = manager.configure_plugin("csv-import", config);
    assert!(
        result.is_err(),
        "should fail without csv_data"
    );
    assert!(
        result.unwrap_err().contains("csv_data"),
        "error should mention csv_data"
    );
}

#[test]
fn test_csv_import_no_header() {
    let csv = "\
2025-01-15,Direct Entry One,-25.00
2025-01-16,Direct Entry Two,-75.00
";

    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine.clone(), &tmp);

    manager.discover().expect("discovery failed");

    let mut config = csv_config(csv);
    // Override skip_header to false
    for (k, v) in config.iter_mut() {
        if k == "skip_header" {
            *v = "false".into();
        }
    }

    manager
        .configure_plugin("csv-import", config)
        .expect("configure failed");

    let result = manager.sync_source("csv-import").expect("sync failed");
    assert!(result.summary.contains("2"));

    let filter = dledger_core::models::TransactionFilter {
        account_id: None,
        from_date: None,
        to_date: None,
        status: None,
        source: Some("plugin:CSV Import".to_string()),
        limit: Some(100),
        offset: Some(0),
    };
    let entries = engine.query_journal_entries(&filter).expect("query failed");
    assert_eq!(entries.len(), 2);
}
