wit_bindgen::generate!({
    world: "source",
    path: "../../wit",
});

use dledger::plugin::http_client;
use dledger::plugin::ledger_write;
use dledger::plugin::logging;
use dledger::plugin::plugin_storage;
use dledger::plugin::types::*;

struct Etherscan;

// --- Config keys ---
const KEY_API_KEY: &str = "api_key";
const KEY_ADDRESS: &str = "address";
const KEY_BASE_CURRENCY: &str = "base_currency";
const KEY_MOCK_DATA: &str = "mock_data";
const KEY_API_URL: &str = "api_url";

const DEFAULT_API_URL: &str = "https://api.etherscan.io/v2/api";

impl exports::dledger::plugin::metadata::Guest for Etherscan {
    fn get_metadata() -> PluginMetadata {
        PluginMetadata {
            name: "Etherscan".to_string(),
            version: "0.1.0".to_string(),
            description: "Track ETH transactions via Etherscan API".to_string(),
            author: "dledger".to_string(),
        }
    }
}

impl exports::dledger::plugin::source_ops::Guest for Etherscan {
    fn config_schema() -> Vec<ConfigField> {
        vec![
            ConfigField {
                key: KEY_API_KEY.into(),
                label: "Etherscan API Key".into(),
                field_type: "password".into(),
                required: true,
                default_value: String::new(),
                description: "API key from etherscan.io".into(),
                options: String::new(),
            },
            ConfigField {
                key: KEY_ADDRESS.into(),
                label: "ETH Address".into(),
                field_type: "string".into(),
                required: true,
                default_value: String::new(),
                description: "Ethereum address to track (0x...)".into(),
                options: String::new(),
            },
            ConfigField {
                key: KEY_BASE_CURRENCY.into(),
                label: "Base Currency".into(),
                field_type: "select".into(),
                required: true,
                default_value: "EUR".into(),
                description: "Your base fiat currency for price tracking".into(),
                options: "EUR,USD,GBP".into(),
            },
            ConfigField {
                key: KEY_API_URL.into(),
                label: "API URL".into(),
                field_type: "string".into(),
                required: false,
                default_value: DEFAULT_API_URL.into(),
                description: "Etherscan API V2 base URL (override for testing)".into(),
                options: String::new(),
            },
            ConfigField {
                key: KEY_MOCK_DATA.into(),
                label: "Mock Data (testing)".into(),
                field_type: "string".into(),
                required: false,
                default_value: String::new(),
                description: "JSON mock response for testing (leave empty for real API)".into(),
                options: String::new(),
            },
        ]
    }

    fn configure(config: Vec<(String, String)>) -> Result<(), String> {
        let get = |key: &str| -> Option<String> {
            config.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
        };

        let mock_data = get(KEY_MOCK_DATA).unwrap_or_default();

        if mock_data.is_empty() {
            let api_key = get(KEY_API_KEY).unwrap_or_default();
            if api_key.is_empty() {
                return Err("api_key is required".into());
            }
        }

        let address = get(KEY_ADDRESS).unwrap_or_default();
        if address.is_empty() {
            return Err("address is required".into());
        }

        if !address.starts_with("0x") || address.len() != 42 {
            return Err("address must be a valid Ethereum address (0x + 40 hex chars)".into());
        }

        let base_currency = get(KEY_BASE_CURRENCY).unwrap_or_default();
        if base_currency.is_empty() {
            return Err("base_currency is required".into());
        }

        for (key, value) in &config {
            plugin_storage::set(key, value)
                .map_err(|e| format!("Failed to store config '{key}': {e:?}"))?;
        }

        logging::info("Etherscan plugin configured successfully");
        Ok(())
    }

    fn test_connection() -> Result<String, String> {
        let mock_data = plugin_storage::get(KEY_MOCK_DATA)
            .map_err(|e| format!("Storage error: {e:?}"))?
            .unwrap_or_default();

        if !mock_data.is_empty() {
            return Ok("Mock mode: connection test skipped".into());
        }

        let api_key = plugin_storage::get(KEY_API_KEY)
            .map_err(|e| format!("Storage error: {e:?}"))?
            .unwrap_or_default();

        let api_url = plugin_storage::get(KEY_API_URL)
            .map_err(|e| format!("Storage error: {e:?}"))?
            .unwrap_or_else(|| DEFAULT_API_URL.to_string());

        let resp = http_client::send(&HttpRequest {
            method: "GET".into(),
            url: format!(
                "{api_url}?chainid=1&module=proxy&action=eth_blockNumber&apikey={api_key}"
            ),
            headers: vec![],
            body: vec![],
        })
        .map_err(|e| format!("HTTP error: {e:?}"))?;

        if resp.status == 200 {
            Ok("Connected to Etherscan API successfully".into())
        } else {
            Err(format!("Etherscan API returned status {}", resp.status))
        }
    }

    fn sync(state: SyncState) -> Result<SyncResult, String> {
        logging::info("Starting Etherscan ETH sync");

        let config = load_config()?;

        // Parse cursor: last synced block number
        let start_block: u64 = if state.cursor.is_empty() {
            0
        } else {
            state.cursor.parse().unwrap_or(0)
        };

        // Fetch transactions
        let txs = fetch_transactions(&config, start_block)?;

        if txs.is_empty() {
            logging::info("No new transactions to import");
            return Ok(SyncResult {
                transactions: vec![],
                prices: vec![],
                new_state: SyncState {
                    cursor: format!("{start_block}"),
                },
                summary: "No new transactions to import".into(),
            });
        }

        // Track the highest block number seen
        let mut max_block = start_block;
        for tx in &txs {
            if tx.block_number > max_block {
                max_block = tx.block_number;
            }
        }

        let address_lower = config.address.to_lowercase();

        // Ensure accounts
        let eth_account_name = "Assets:Crypto:ETH".to_string();
        let eth_account_id = ledger_write::ensure_account(&eth_account_name, "asset")
            .map_err(|e| format!("Failed to ensure ETH account: {e:?}"))?;

        let gas_account_name = "Expenses:Gas:Ethereum".to_string();
        let gas_account_id = ledger_write::ensure_account(&gas_account_name, "expense")
            .map_err(|e| format!("Failed to ensure gas account: {e:?}"))?;

        let external_account_name = "Equity:External:ETH".to_string();
        let external_account_id = ledger_write::ensure_account(&external_account_name, "equity")
            .map_err(|e| format!("Failed to ensure external account: {e:?}"))?;

        let mut transactions = Vec::new();

        for tx in &txs {
            let is_outgoing = tx.from.to_lowercase() == address_lower;
            let is_incoming = tx.to.to_lowercase() == address_lower;

            // Skip zero-value transactions with zero gas (contract interactions we don't track)
            if tx.value == "0" && !is_outgoing {
                continue;
            }

            let date = timestamp_to_date(tx.timestamp);
            let value_eth = wei_to_eth(&tx.value);
            let gas_eth = wei_to_eth(&tx.gas_cost);

            let mut postings = Vec::new();

            if is_outgoing && is_incoming {
                // Self-transfer - only gas cost matters
                if gas_eth != "0" {
                    postings.push(Posting {
                        account: gas_account_id.clone(),
                        amount: Money {
                            amount: gas_eth.clone(),
                            currency: "ETH".into(),
                        },
                    });
                    postings.push(Posting {
                        account: eth_account_id.clone(),
                        amount: Money {
                            amount: negate(&gas_eth),
                            currency: "ETH".into(),
                        },
                    });
                }
            } else if is_outgoing {
                // Outgoing: credit ETH account, debit external
                if value_eth != "0" {
                    postings.push(Posting {
                        account: eth_account_id.clone(),
                        amount: Money {
                            amount: negate(&value_eth),
                            currency: "ETH".into(),
                        },
                    });
                    postings.push(Posting {
                        account: external_account_id.clone(),
                        amount: Money {
                            amount: value_eth.clone(),
                            currency: "ETH".into(),
                        },
                    });
                }
                // Gas fee (only sender pays)
                if gas_eth != "0" {
                    postings.push(Posting {
                        account: gas_account_id.clone(),
                        amount: Money {
                            amount: gas_eth.clone(),
                            currency: "ETH".into(),
                        },
                    });
                    postings.push(Posting {
                        account: eth_account_id.clone(),
                        amount: Money {
                            amount: negate(&gas_eth),
                            currency: "ETH".into(),
                        },
                    });
                }
            } else if is_incoming {
                // Incoming: debit ETH account, credit external
                if value_eth != "0" {
                    postings.push(Posting {
                        account: eth_account_id.clone(),
                        amount: Money {
                            amount: value_eth.clone(),
                            currency: "ETH".into(),
                        },
                    });
                    postings.push(Posting {
                        account: external_account_id.clone(),
                        amount: Money {
                            amount: negate(&value_eth),
                            currency: "ETH".into(),
                        },
                    });
                }
                // Recipient doesn't pay gas
            }

            if postings.is_empty() {
                continue;
            }

            let direction = if is_outgoing { "Send" } else { "Receive" };
            let description = format!("{direction} {value_eth} ETH");

            transactions.push(Transaction {
                date,
                description,
                postings,
                metadata: vec![
                    ("eth_tx_hash".into(), tx.hash.clone()),
                    ("eth_block".into(), tx.block_number.to_string()),
                ],
            });
        }

        // Submit
        let submitted = if !transactions.is_empty() {
            ledger_write::submit_transactions(&transactions)
                .map_err(|e| format!("Failed to submit transactions: {e:?}"))?
        } else {
            0
        };

        // Next sync starts from block after the highest we've seen
        let new_cursor = max_block + 1;
        let summary = format!(
            "Imported {} ETH transactions (blocks {} to {})",
            submitted, start_block, max_block
        );
        logging::info(&summary);

        Ok(SyncResult {
            transactions,
            prices: vec![],
            new_state: SyncState {
                cursor: format!("{new_cursor}"),
            },
            summary,
        })
    }

    fn full_import(state: SyncState) -> Result<SyncResult, String> {
        let _ = state;
        Self::sync(SyncState {
            cursor: String::new(),
        })
    }
}

export!(Etherscan);

// --- Internal types ---

struct EtherscanConfig {
    api_key: String,
    address: String,
    #[allow(dead_code)]
    base_currency: String,
    api_url: String,
    mock_data: String,
}

fn load_config() -> Result<EtherscanConfig, String> {
    let get = |key: &str| -> Result<String, String> {
        plugin_storage::get(key)
            .map_err(|e| format!("Storage error for '{key}': {e:?}"))?
            .ok_or_else(|| format!("Missing config key: {key}"))
    };

    let get_or = |key: &str, default: &str| -> String {
        plugin_storage::get(key)
            .ok()
            .flatten()
            .unwrap_or_else(|| default.to_string())
    };

    // Migrate old V1 URLs to V2
    let mut api_url = get_or(KEY_API_URL, DEFAULT_API_URL);
    if api_url == "https://api.etherscan.io"
        || api_url == "https://api.etherscan.io/api"
        || api_url == "https://api.etherscan.io/v2"
    {
        api_url = DEFAULT_API_URL.to_string();
    }

    Ok(EtherscanConfig {
        api_key: get_or(KEY_API_KEY, ""),
        address: get(KEY_ADDRESS)?,
        base_currency: get(KEY_BASE_CURRENCY)?,
        api_url,
        mock_data: get_or(KEY_MOCK_DATA, ""),
    })
}

struct EthTransaction {
    hash: String,
    block_number: u64,
    timestamp: f64,
    from: String,
    to: String,
    value: String,      // in wei
    gas_cost: String,    // gasUsed * gasPrice in wei
}

fn fetch_transactions(
    config: &EtherscanConfig,
    start_block: u64,
) -> Result<Vec<EthTransaction>, String> {
    if !config.mock_data.is_empty() {
        return parse_etherscan_response(&config.mock_data);
    }

    let url = format!(
        "{}?chainid=1&module=account&action=txlist&address={}&startblock={}&endblock=99999999&sort=asc&apikey={}",
        config.api_url, config.address, start_block, config.api_key
    );

    let resp = http_client::send(&HttpRequest {
        method: "GET".into(),
        url,
        headers: vec![],
        body: vec![],
    })
    .map_err(|e| format!("HTTP error: {e:?}"))?;

    if resp.status != 200 {
        return Err(format!("Etherscan API returned status {}", resp.status));
    }

    let body = String::from_utf8(resp.body).map_err(|_| "Invalid UTF-8 in response")?;
    parse_etherscan_response(&body)
}

/// Parse Etherscan API txlist response.
/// Format:
/// {
///   "status": "1",
///   "message": "OK",
///   "result": [
///     {
///       "hash": "0x...",
///       "blockNumber": "12345",
///       "timeStamp": "1704067200",
///       "from": "0x...",
///       "to": "0x...",
///       "value": "1000000000000000000",
///       "gasUsed": "21000",
///       "gasPrice": "20000000000",
///       "isError": "0"
///     },
///     ...
///   ]
/// }
fn parse_etherscan_response(json: &str) -> Result<Vec<EthTransaction>, String> {
    // Check status
    let status = extract_json_string(json, "status").unwrap_or_default();
    if status != "1" {
        let msg = extract_json_string(json, "message").unwrap_or_default();
        // "No transactions found" is not an error
        if msg.contains("No transactions found") {
            return Ok(vec![]);
        }
        if !status.is_empty() && status != "1" {
            return Err(format!("Etherscan API error: {msg}"));
        }
    }

    // Extract the result array
    let result_array = extract_json_array_objects(json, "result");

    let mut txs = Vec::new();
    for tx_json in &result_array {
        // Skip failed transactions
        let is_error = extract_json_string(tx_json, "isError").unwrap_or_default();
        if is_error == "1" {
            continue;
        }

        let gas_used = extract_json_string(tx_json, "gasUsed").unwrap_or_default();
        let gas_price = extract_json_string(tx_json, "gasPrice").unwrap_or_default();
        let gas_cost = multiply_wei(&gas_used, &gas_price);

        txs.push(EthTransaction {
            hash: extract_json_string(tx_json, "hash").unwrap_or_default(),
            block_number: extract_json_string(tx_json, "blockNumber")
                .and_then(|s| s.parse().ok())
                .unwrap_or(0),
            timestamp: extract_json_string(tx_json, "timeStamp")
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0),
            from: extract_json_string(tx_json, "from").unwrap_or_default(),
            to: extract_json_string(tx_json, "to").unwrap_or_default(),
            value: extract_json_string(tx_json, "value").unwrap_or_default(),
            gas_cost,
        });
    }

    Ok(txs)
}

/// Convert wei (integer string) to ETH (decimal string with 18 decimals).
fn wei_to_eth(wei: &str) -> String {
    let wei = wei.trim();
    if wei.is_empty() || wei == "0" {
        return "0".to_string();
    }

    // Pad to at least 19 chars (18 decimals + at least 1 whole digit)
    let padded = if wei.len() <= 18 {
        let zeros = "0".repeat(19 - wei.len());
        format!("{zeros}{wei}")
    } else {
        wei.to_string()
    };

    let split_point = padded.len() - 18;
    let whole = &padded[..split_point];
    let frac = padded[split_point..].trim_end_matches('0');

    if frac.is_empty() {
        whole.to_string()
    } else {
        format!("{whole}.{frac}")
    }
}

/// Multiply two integer strings (gasUsed * gasPrice) to get gas cost in wei.
fn multiply_wei(a: &str, b: &str) -> String {
    let a: u128 = a.trim().parse().unwrap_or(0);
    let b: u128 = b.trim().parse().unwrap_or(0);
    (a * b).to_string()
}

/// Convert Unix timestamp to YYYY-MM-DD.
fn timestamp_to_date(ts: f64) -> String {
    let total_secs = ts as i64;
    let days_since_epoch = total_secs / 86400;

    let mut days = days_since_epoch;
    let mut year = 1970i32;

    loop {
        let days_in_year = if is_leap(year) { 366 } else { 365 };
        if days < days_in_year {
            break;
        }
        days -= days_in_year;
        year += 1;
    }

    let leap = is_leap(year);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];

    let mut month = 0usize;
    for (i, &md) in month_days.iter().enumerate() {
        if days < md {
            month = i;
            break;
        }
        days -= md;
    }

    format!("{:04}-{:02}-{:02}", year, month + 1, days + 1)
}

fn is_leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

fn negate(s: &str) -> String {
    let s = s.trim();
    if s.starts_with('-') {
        s[1..].to_string()
    } else {
        format!("-{s}")
    }
}

// --- Minimal JSON parsing helpers ---

fn extract_json_string(json: &str, key: &str) -> Option<String> {
    let pattern = format!("\"{}\"", key);
    let idx = json.find(&pattern)?;
    let after_key = &json[idx + pattern.len()..];
    let after_colon = after_key.trim_start().strip_prefix(':')?.trim_start();

    if after_colon.starts_with('"') {
        let content = &after_colon[1..];
        let end = find_unescaped_quote(content)?;
        Some(content[..end].to_string())
    } else {
        None
    }
}

/// Extract array of JSON objects from a "key": [...] field.
fn extract_json_array_objects(json: &str, key: &str) -> Vec<String> {
    let pattern = format!("\"{}\"", key);
    let Some(idx) = json.find(&pattern) else {
        return vec![];
    };
    let after_key = &json[idx + pattern.len()..];
    let Some(after_colon) = after_key.trim_start().strip_prefix(':') else {
        return vec![];
    };
    let after_colon = after_colon.trim_start();

    if !after_colon.starts_with('[') {
        return vec![];
    }

    // Find all top-level objects inside the array
    let mut objects = Vec::new();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut prev_char = '\0';
    let mut obj_start = None;

    for (i, c) in after_colon.char_indices() {
        if in_string {
            if c == '"' && prev_char != '\\' {
                in_string = false;
            }
        } else {
            match c {
                '"' => in_string = true,
                '[' if depth == 0 => depth = 1,
                '{' => {
                    if depth == 1 && obj_start.is_none() {
                        obj_start = Some(i);
                    }
                    depth += 1;
                }
                '}' => {
                    depth -= 1;
                    if depth == 1 {
                        if let Some(start) = obj_start.take() {
                            objects.push(after_colon[start..i + 1].to_string());
                        }
                    }
                }
                ']' if depth == 1 => break,
                _ => {}
            }
        }
        prev_char = c;
    }

    objects
}

fn find_unescaped_quote(s: &str) -> Option<usize> {
    let mut prev = '\0';
    for (i, c) in s.char_indices() {
        if c == '"' && prev != '\\' {
            return Some(i);
        }
        prev = c;
    }
    None
}
