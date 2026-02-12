wit_bindgen::generate!({
    world: "source",
    path: "../../wit",
});

struct TestSource;

impl exports::dledger::plugin::metadata::Guest for TestSource {
    fn get_metadata() -> dledger::plugin::types::PluginMetadata {
        dledger::plugin::types::PluginMetadata {
            name: "Test Source".to_string(),
            version: "0.1.0".to_string(),
            description: "A test source plugin for E2E verification".to_string(),
            author: "dledger".to_string(),
        }
    }
}

impl exports::dledger::plugin::source_ops::Guest for TestSource {
    fn config_schema() -> Vec<dledger::plugin::types::ConfigField> {
        vec![dledger::plugin::types::ConfigField {
            key: "api_key".to_string(),
            label: "API Key".to_string(),
            field_type: "password".to_string(),
            required: true,
            default_value: String::new(),
            description: "Test API key".to_string(),
            options: String::new(),
        }]
    }

    fn configure(
        config: Vec<(String, String)>,
    ) -> Result<(), String> {
        // Validate that api_key is provided
        let has_key = config.iter().any(|(k, v)| k == "api_key" && !v.is_empty());
        if !has_key {
            return Err("api_key is required".to_string());
        }

        // Store config in plugin storage
        for (key, value) in &config {
            dledger::plugin::plugin_storage::set(key, value).ok();
        }

        Ok(())
    }

    fn test_connection() -> Result<String, String> {
        // Check if configured
        match dledger::plugin::plugin_storage::get("api_key") {
            Ok(Some(_)) => Ok("Connection OK".to_string()),
            _ => Err("Not configured".to_string()),
        }
    }

    fn sync(
        state: dledger::plugin::types::SyncState,
    ) -> Result<dledger::plugin::types::SyncResult, String> {
        dledger::plugin::logging::info("Starting sync");

        // Parse cursor to determine which page to sync
        let page: u32 = if state.cursor.is_empty() {
            0
        } else {
            state.cursor.parse().unwrap_or(0)
        };

        // Only produce transactions on the first sync (page 0)
        let transactions = if page == 0 {
            // Ensure accounts exist
            let checking_id = dledger::plugin::ledger_write::ensure_account(
                "Assets:Bank:Checking",
                "asset",
            )
            .map_err(|e| format!("Failed to ensure account: {:?}", e))?;

            let groceries_id = dledger::plugin::ledger_write::ensure_account(
                "Expenses:Groceries",
                "expense",
            )
            .map_err(|e| format!("Failed to ensure account: {:?}", e))?;

            let txs = vec![dledger::plugin::types::Transaction {
                date: "2025-01-15".to_string(),
                description: "Test grocery purchase".to_string(),
                postings: vec![
                    dledger::plugin::types::Posting {
                        account: checking_id.clone(),
                        amount: dledger::plugin::types::Money {
                            amount: "-50.00".to_string(),
                            currency: "EUR".to_string(),
                        },
                    },
                    dledger::plugin::types::Posting {
                        account: groceries_id.clone(),
                        amount: dledger::plugin::types::Money {
                            amount: "50.00".to_string(),
                            currency: "EUR".to_string(),
                        },
                    },
                ],
                metadata: vec![("source_ref".to_string(), "TEST-001".to_string())],
            }];

            // Submit transactions
            let count = dledger::plugin::ledger_write::submit_transactions(&txs)
                .map_err(|e| format!("Failed to submit transactions: {:?}", e))?;

            dledger::plugin::logging::info(&format!("Submitted {} transactions", count));

            txs
        } else {
            vec![]
        };

        Ok(dledger::plugin::types::SyncResult {
            transactions,
            prices: vec![],
            new_state: dledger::plugin::types::SyncState {
                cursor: format!("{}", page + 1),
            },
            summary: format!("Synced page {}", page),
        })
    }

    fn full_import(
        state: dledger::plugin::types::SyncState,
    ) -> Result<dledger::plugin::types::SyncResult, String> {
        // Delegate to sync for this test plugin
        Self::sync(state)
    }
}

export!(TestSource);
