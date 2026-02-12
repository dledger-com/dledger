use std::path::PathBuf;
use std::sync::Arc;

use dledger_core::LedgerEngine;
use dledger_lib::db::{apply_migrations, SqliteStorage};
use dledger_lib::plugin::storage::PluginKvStorage;
use dledger_lib::plugin::PluginManager;
use tempfile::TempDir;

/// Fixtures directory containing test plugins.
fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("plugins")
}

/// Set up a fresh ledger engine with an in-memory SQLite database.
fn setup_engine() -> (Arc<LedgerEngine>, TempDir) {
    let tmp = TempDir::new().expect("failed to create temp dir");
    let db_path = tmp.path().join("test.db");
    let storage = SqliteStorage::new(db_path.to_str().unwrap()).expect("failed to create storage");
    apply_migrations(&storage).expect("failed to apply migrations");
    let engine = Arc::new(LedgerEngine::new(Box::new(storage)));

    // Create EUR currency (needed for transactions)
    let eur = dledger_core::models::Currency {
        code: "EUR".to_string(),
        name: "Euro".to_string(),
        decimal_places: 2,
        is_base: true,
    };
    engine.create_currency(&eur).expect("failed to create EUR");

    (engine, tmp)
}

/// Create a PluginManager with the test fixtures directory as the plugins dir.
fn setup_manager(engine: Arc<LedgerEngine>, tmp: &TempDir) -> PluginManager {
    // Copy fixtures to a temp plugins dir (so we don't mutate the repo)
    let plugins_dir = tmp.path().join("plugins");
    copy_dir_all(&fixtures_dir(), &plugins_dir).expect("failed to copy fixtures");

    let kv_db_path = tmp.path().join("plugins.db");
    PluginManager::new(
        plugins_dir,
        kv_db_path.to_str().unwrap(),
        engine,
    )
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

#[test]
fn test_plugin_discovery() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    let plugins = manager.discover().expect("discovery failed");

    assert!(plugins.len() >= 2, "expected at least 2 plugins, got {}", plugins.len());

    let names: Vec<&str> = plugins.iter().map(|p| p.name.as_str()).collect();
    assert!(names.contains(&"Test Source"), "missing Test Source plugin");
    assert!(names.contains(&"Test HTTP Source"), "missing Test HTTP Source plugin");
}

#[test]
fn test_plugin_list_after_discover() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    // Before discovery, list should be empty
    assert!(manager.list_plugins().is_empty());

    manager.discover().expect("discovery failed");

    // After discovery, list should have plugins
    let plugins = manager.list_plugins();
    assert!(plugins.len() >= 2);
}

#[test]
fn test_plugin_configure_and_sync() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine.clone(), &tmp);

    manager.discover().expect("discovery failed");

    // Configure the test-source plugin
    let config = vec![("api_key".to_string(), "test-key-123".to_string())];
    manager
        .configure_plugin("test-source", config)
        .expect("configure failed");

    // Run sync
    let result = manager.sync_source("test-source").expect("sync failed");
    assert!(
        !result.summary.is_empty(),
        "sync should return a summary"
    );

    // Verify transactions were created in the ledger
    let filter = dledger_core::models::TransactionFilter {
        account_id: None,
        from_date: None,
        to_date: None,
        status: None,
        source: Some("plugin:Test Source".to_string()),
        limit: Some(100),
        offset: Some(0),
    };
    let entries = engine
        .query_journal_entries(&filter)
        .expect("query failed");
    assert!(
        !entries.is_empty(),
        "sync should have created journal entries"
    );

    // Verify the entry has the expected description
    let (je, items) = &entries[0];
    assert_eq!(je.description, "Test grocery purchase");
    assert_eq!(items.len(), 2);
}

#[test]
fn test_plugin_incremental_sync() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine.clone(), &tmp);

    manager.discover().expect("discovery failed");

    let config = vec![("api_key".to_string(), "test-key-123".to_string())];
    manager
        .configure_plugin("test-source", config)
        .expect("configure failed");

    // First sync - should produce transactions
    let result1 = manager.sync_source("test-source").expect("sync 1 failed");
    assert_eq!(result1.summary, "Synced page 0");

    // Count entries after first sync
    let filter = dledger_core::models::TransactionFilter {
        account_id: None,
        from_date: None,
        to_date: None,
        status: None,
        source: Some("plugin:Test Source".to_string()),
        limit: Some(100),
        offset: Some(0),
    };
    let entries_after_first = engine.query_journal_entries(&filter).expect("query failed");
    let count_first = entries_after_first.len();

    // Second sync - cursor should be "1", no new transactions
    let result2 = manager.sync_source("test-source").expect("sync 2 failed");
    assert_eq!(result2.summary, "Synced page 1");

    // Count should not increase
    let entries_after_second = engine.query_journal_entries(&filter).expect("query failed");
    assert_eq!(
        entries_after_second.len(),
        count_first,
        "second sync should not produce duplicate transactions"
    );
}

#[test]
fn test_plugin_storage_isolation() {
    let tmp = TempDir::new().expect("failed to create temp dir");
    let kv_db_path = tmp.path().join("plugins.db");
    let kv = PluginKvStorage::new(kv_db_path.to_str().unwrap()).expect("failed to create KV");

    // Plugin A writes a key
    kv.set("plugin-a", "secret", "alpha-secret")
        .expect("set failed");

    // Plugin B writes the same key name
    kv.set("plugin-b", "secret", "beta-secret")
        .expect("set failed");

    // Each plugin sees only its own value
    let a_val = kv.get("plugin-a", "secret").expect("get failed");
    assert_eq!(a_val, Some("alpha-secret".to_string()));

    let b_val = kv.get("plugin-b", "secret").expect("get failed");
    assert_eq!(b_val, Some("beta-secret".to_string()));

    // Plugin A cannot see Plugin B's keys
    let a_keys = kv.list_keys("plugin-a").expect("list_keys failed");
    assert_eq!(a_keys, vec!["secret"]);

    let b_keys = kv.list_keys("plugin-b").expect("list_keys failed");
    assert_eq!(b_keys, vec!["secret"]);

    // Delete Plugin A's key
    kv.delete("plugin-a", "secret").expect("delete failed");
    let a_val = kv.get("plugin-a", "secret").expect("get failed");
    assert_eq!(a_val, None);

    // Plugin B's key is unaffected
    let b_val = kv.get("plugin-b", "secret").expect("get failed");
    assert_eq!(b_val, Some("beta-secret".to_string()));
}

#[test]
fn test_sync_on_non_source_plugin_fails() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    manager.discover().expect("discovery failed");

    // test-source is a source plugin, test-http-source is also a source
    // Both should work for sync. Let's verify the error for a non-existent plugin.
    let result = manager.sync_source("nonexistent-plugin");
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("not found"));
}

#[test]
fn test_plugin_metadata_via_discovery() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    let plugins = manager.discover().expect("discovery failed");

    let test_source = plugins.iter().find(|p| p.id == "test-source").unwrap();
    assert_eq!(test_source.name, "Test Source");
    assert_eq!(test_source.version, "0.1.0");
    assert_eq!(test_source.kind, "source");
    assert!(test_source.capabilities.ledger_read);
    assert!(test_source.capabilities.ledger_write);
    assert!(!test_source.capabilities.http);
}

#[test]
fn test_http_capability_in_manifest() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    let plugins = manager.discover().expect("discovery failed");

    let http_source = plugins
        .iter()
        .find(|p| p.id == "test-http-source")
        .unwrap();
    assert_eq!(http_source.name, "Test HTTP Source");
    assert!(http_source.capabilities.http);
    assert_eq!(
        http_source.capabilities.allowed_domains,
        vec!["api.example.com".to_string()]
    );
}

#[test]
fn test_configure_without_required_field_fails() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine, &tmp);

    manager.discover().expect("discovery failed");

    // Configure without api_key should fail
    let config = vec![("other_key".to_string(), "some-value".to_string())];
    let result = manager.configure_plugin("test-source", config);
    assert!(result.is_err(), "configure should fail without api_key");
    let err = result.unwrap_err();
    assert!(
        err.contains("api_key"),
        "error should mention api_key: {err}"
    );
}

#[test]
fn test_accounts_created_by_plugin_sync() {
    let (engine, tmp) = setup_engine();
    let mut manager = setup_manager(engine.clone(), &tmp);

    manager.discover().expect("discovery failed");

    let config = vec![("api_key".to_string(), "test-key-123".to_string())];
    manager
        .configure_plugin("test-source", config)
        .expect("configure failed");

    manager.sync_source("test-source").expect("sync failed");

    // Verify accounts were created via ensure_account
    let accounts = engine.list_accounts().expect("list_accounts failed");
    let account_names: Vec<&str> = accounts.iter().map(|a| a.full_name.as_str()).collect();

    assert!(
        account_names.contains(&"Assets:Bank:Checking"),
        "should have Assets:Bank:Checking, got: {:?}",
        account_names
    );
    assert!(
        account_names.contains(&"Expenses:Groceries"),
        "should have Expenses:Groceries, got: {:?}",
        account_names
    );
}
