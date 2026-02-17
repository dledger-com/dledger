wit_bindgen::generate!({
    world: "source",
    path: "../../wit",
});

use dledger::plugin::http_client;
use dledger::plugin::ledger_write;
use dledger::plugin::logging;
use dledger::plugin::plugin_storage;
use dledger::plugin::types::*;

struct Mempool;

// --- Config keys ---
const KEY_ADDRESS: &str = "address";
const KEY_BASE_CURRENCY: &str = "base_currency";
const KEY_MOCK_DATA: &str = "mock_data";
const KEY_API_URL: &str = "api_url";

const DEFAULT_API_URL: &str = "https://mempool.space/api";

impl exports::dledger::plugin::metadata::Guest for Mempool {
    fn get_metadata() -> PluginMetadata {
        PluginMetadata {
            name: "mempool.space BTC".to_string(),
            version: "0.1.0".to_string(),
            description: "Track Bitcoin transactions via mempool.space API".to_string(),
            author: "dledger".to_string(),
        }
    }
}

impl exports::dledger::plugin::source_ops::Guest for Mempool {
    fn config_schema() -> Vec<ConfigField> {
        vec![
            ConfigField {
                key: KEY_ADDRESS.into(),
                label: "Bitcoin Address".into(),
                field_type: "string".into(),
                required: true,
                default_value: String::new(),
                description: "Bitcoin address to track (legacy, segwit, or bech32)".into(),
                options: String::new(),
            },
            ConfigField {
                key: KEY_BASE_CURRENCY.into(),
                label: "Base Currency".into(),
                field_type: "select".into(),
                required: true,
                default_value: "EUR".into(),
                description: "Your base fiat currency".into(),
                options: "EUR,USD,GBP".into(),
            },
            ConfigField {
                key: KEY_API_URL.into(),
                label: "API URL".into(),
                field_type: "string".into(),
                required: false,
                default_value: DEFAULT_API_URL.into(),
                description: "mempool.space API URL (override for testing or self-hosted)".into(),
                options: String::new(),
            },
            ConfigField {
                key: KEY_MOCK_DATA.into(),
                label: "Mock Data (testing)".into(),
                field_type: "string".into(),
                required: false,
                default_value: String::new(),
                description: "JSON mock response for testing".into(),
                options: String::new(),
            },
        ]
    }

    fn configure(config: Vec<(String, String)>) -> Result<(), String> {
        let get = |key: &str| -> Option<String> {
            config.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
        };

        let address = get(KEY_ADDRESS).unwrap_or_default();
        if address.is_empty() {
            return Err("address is required".into());
        }

        let base_currency = get(KEY_BASE_CURRENCY).unwrap_or_default();
        if base_currency.is_empty() {
            return Err("base_currency is required".into());
        }

        for (key, value) in &config {
            plugin_storage::set(key, value)
                .map_err(|e| format!("Failed to store config '{key}': {e:?}"))?;
        }

        logging::info("mempool.space BTC plugin configured successfully");
        Ok(())
    }

    fn test_connection() -> Result<String, String> {
        let mock_data = plugin_storage::get(KEY_MOCK_DATA)
            .map_err(|e| format!("Storage error: {e:?}"))?
            .unwrap_or_default();

        if !mock_data.is_empty() {
            return Ok("Mock mode: connection test skipped".into());
        }

        let api_url = plugin_storage::get(KEY_API_URL)
            .map_err(|e| format!("Storage error: {e:?}"))?
            .unwrap_or_else(|| DEFAULT_API_URL.to_string());

        let resp = http_client::send(&HttpRequest {
            method: "GET".into(),
            url: format!("{api_url}/blocks/tip/height"),
            headers: vec![],
            body: vec![],
        })
        .map_err(|e| format!("HTTP error: {e:?}"))?;

        if resp.status == 200 {
            let height = String::from_utf8(resp.body).unwrap_or_default();
            Ok(format!("Connected to mempool.space. Current block height: {height}"))
        } else {
            Err(format!("mempool.space API returned status {}", resp.status))
        }
    }

    fn sync(state: SyncState) -> Result<SyncResult, String> {
        logging::info("Starting mempool.space BTC sync");

        let config = load_config()?;

        // Cursor: last seen txid (for pagination) or empty for first sync
        let last_seen_txid = if state.cursor.is_empty() {
            None
        } else {
            Some(state.cursor.clone())
        };

        let btc_txs = fetch_transactions(&config, last_seen_txid.as_deref())?;

        if btc_txs.is_empty() {
            logging::info("No new transactions to import");
            return Ok(SyncResult {
                transactions: vec![],
                prices: vec![],
                new_state: SyncState {
                    cursor: state.cursor,
                },
                summary: "No new transactions to import".into(),
            });
        }

        let address = &config.address;

        // Ensure accounts
        let btc_account_name = "Assets:Crypto:BTC".to_string();
        let btc_account_id = ledger_write::ensure_account(&btc_account_name, "asset")
            .map_err(|e| format!("Failed to ensure BTC account: {e:?}"))?;

        let fee_account_name = "Expenses:Fees:Bitcoin".to_string();
        let fee_account_id = ledger_write::ensure_account(&fee_account_name, "expense")
            .map_err(|e| format!("Failed to ensure fee account: {e:?}"))?;

        let external_account_name = "Equity:External:BTC".to_string();
        let external_account_id = ledger_write::ensure_account(&external_account_name, "equity")
            .map_err(|e| format!("Failed to ensure external account: {e:?}"))?;

        let mut transactions = Vec::new();

        for tx in &btc_txs {
            // Calculate net effect on our address
            let received = tx.outputs_to_address(address);
            let spent = tx.inputs_from_address(address);

            let net_sats = received as i64 - spent as i64;
            if net_sats == 0 {
                continue; // Self-spend that returned exact change
            }

            let date = timestamp_to_date(tx.timestamp);
            let net_btc = sats_to_btc(net_sats.unsigned_abs());

            let mut postings = Vec::new();

            if net_sats > 0 {
                // Net incoming
                postings.push(Posting {
                    account: btc_account_id.clone(),
                    amount: Money {
                        amount: net_btc.clone(),
                        currency: "BTC".into(),
                    },
                });
                postings.push(Posting {
                    account: external_account_id.clone(),
                    amount: Money {
                        amount: negate(&net_btc),
                        currency: "BTC".into(),
                    },
                });
            } else {
                // Net outgoing
                let abs_btc = net_btc.clone();
                postings.push(Posting {
                    account: btc_account_id.clone(),
                    amount: Money {
                        amount: negate(&abs_btc),
                        currency: "BTC".into(),
                    },
                });
                postings.push(Posting {
                    account: external_account_id.clone(),
                    amount: Money {
                        amount: abs_btc,
                        currency: "BTC".into(),
                    },
                });

                // Record fee (only sender pays)
                if tx.fee > 0 {
                    let fee_btc = sats_to_btc(tx.fee);
                    postings.push(Posting {
                        account: fee_account_id.clone(),
                        amount: Money {
                            amount: fee_btc.clone(),
                            currency: "BTC".into(),
                        },
                    });
                    postings.push(Posting {
                        account: btc_account_id.clone(),
                        amount: Money {
                            amount: negate(&fee_btc),
                            currency: "BTC".into(),
                        },
                    });
                }
            }

            let direction = if net_sats > 0 { "Receive" } else { "Send" };
            let description = format!("{direction} {} BTC", sats_to_btc(net_sats.unsigned_abs()));

            transactions.push(Transaction {
                date,
                description,
                postings,
                metadata: vec![
                    ("btc_txid".into(), tx.txid.clone()),
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

        // New cursor: the last txid we processed
        let new_cursor = btc_txs.last().map(|t| t.txid.clone()).unwrap_or(state.cursor);

        let summary = format!("Imported {} BTC transactions", submitted);
        logging::info(&summary);

        Ok(SyncResult {
            transactions,
            prices: vec![],
            new_state: SyncState {
                cursor: new_cursor,
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

export!(Mempool);

// --- Internal types ---

struct MempoolConfig {
    address: String,
    #[allow(dead_code)]
    base_currency: String,
    api_url: String,
    mock_data: String,
}

fn load_config() -> Result<MempoolConfig, String> {
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

    Ok(MempoolConfig {
        address: get(KEY_ADDRESS)?,
        base_currency: get(KEY_BASE_CURRENCY)?,
        api_url: get_or(KEY_API_URL, DEFAULT_API_URL),
        mock_data: get_or(KEY_MOCK_DATA, ""),
    })
}

struct BtcTransaction {
    txid: String,
    timestamp: f64,
    fee: u64,
    inputs: Vec<TxInOut>,
    outputs: Vec<TxInOut>,
}

struct TxInOut {
    address: String,
    value: u64, // satoshis
}

impl BtcTransaction {
    fn outputs_to_address(&self, addr: &str) -> u64 {
        self.outputs
            .iter()
            .filter(|o| o.address == addr)
            .map(|o| o.value)
            .sum()
    }

    fn inputs_from_address(&self, addr: &str) -> u64 {
        self.inputs
            .iter()
            .filter(|i| i.address == addr)
            .map(|i| i.value)
            .sum()
    }
}

fn fetch_transactions(
    config: &MempoolConfig,
    _last_txid: Option<&str>,
) -> Result<Vec<BtcTransaction>, String> {
    if !config.mock_data.is_empty() {
        return parse_mempool_response(&config.mock_data);
    }

    // Esplora API: GET /address/:address/txs
    let url = format!("{}/address/{}/txs", config.api_url, config.address);

    let resp = http_client::send(&HttpRequest {
        method: "GET".into(),
        url,
        headers: vec![],
        body: vec![],
    })
    .map_err(|e| format!("HTTP error: {e:?}"))?;

    if resp.status != 200 {
        return Err(format!("mempool.space API returned status {}", resp.status));
    }

    let body = String::from_utf8(resp.body).map_err(|_| "Invalid UTF-8 in response")?;
    parse_mempool_response(&body)
}

/// Parse Esplora API response (used by mempool.space).
/// Format: JSON array of transaction objects:
/// [
///   {
///     "txid": "abc123...",
///     "status": { "confirmed": true, "block_time": 1704067200 },
///     "fee": 1234,
///     "vin": [ { "prevout": { "scriptpubkey_address": "bc1...", "value": 50000 } } ],
///     "vout": [ { "scriptpubkey_address": "bc1...", "value": 40000 } ]
///   }
/// ]
fn parse_mempool_response(json: &str) -> Result<Vec<BtcTransaction>, String> {
    let trimmed = json.trim();

    // Handle empty array
    if trimmed == "[]" {
        return Ok(vec![]);
    }

    if !trimmed.starts_with('[') {
        return Err("Expected JSON array".into());
    }

    // Extract top-level objects from the array
    let tx_objects = extract_array_objects(trimmed);
    let mut transactions = Vec::new();

    for tx_json in &tx_objects {
        let txid = extract_json_string(tx_json, "txid").unwrap_or_default();

        // Get block_time from status object
        let status = extract_json_object(tx_json, "status").unwrap_or_default();
        let confirmed = extract_json_string(&status, "confirmed").unwrap_or_default();
        if confirmed != "true" {
            continue; // Skip unconfirmed
        }
        let block_time: f64 = extract_json_number(&status, "block_time").unwrap_or(0.0);

        let fee: u64 = extract_json_number(tx_json, "fee")
            .map(|f| f as u64)
            .unwrap_or(0);

        // Parse inputs (vin array)
        let vin_objects = extract_json_array_objects(tx_json, "vin");
        let mut inputs = Vec::new();
        for vin in &vin_objects {
            if let Some(prevout) = extract_json_object(vin, "prevout") {
                let address = extract_json_string(&prevout, "scriptpubkey_address")
                    .unwrap_or_default();
                let value: u64 = extract_json_number(&prevout, "value")
                    .map(|f| f as u64)
                    .unwrap_or(0);
                if !address.is_empty() {
                    inputs.push(TxInOut { address, value });
                }
            }
        }

        // Parse outputs (vout array)
        let vout_objects = extract_json_array_objects(tx_json, "vout");
        let mut outputs = Vec::new();
        for vout in &vout_objects {
            let address = extract_json_string(vout, "scriptpubkey_address")
                .unwrap_or_default();
            let value: u64 = extract_json_number(vout, "value")
                .map(|f| f as u64)
                .unwrap_or(0);
            if !address.is_empty() {
                outputs.push(TxInOut { address, value });
            }
        }

        transactions.push(BtcTransaction {
            txid,
            timestamp: block_time,
            fee,
            inputs,
            outputs,
        });
    }

    // Sort by timestamp ascending
    transactions.sort_by(|a, b| {
        a.timestamp
            .partial_cmp(&b.timestamp)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(transactions)
}

/// Convert satoshis to BTC string (8 decimal places).
fn sats_to_btc(sats: u64) -> String {
    if sats == 0 {
        return "0".to_string();
    }

    let whole = sats / 100_000_000;
    let frac = sats % 100_000_000;

    if frac == 0 {
        return whole.to_string();
    }

    let frac_str = format!("{:08}", frac);
    let trimmed = frac_str.trim_end_matches('0');
    format!("{whole}.{trimmed}")
}

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
    } else if after_colon.starts_with("true") {
        Some("true".to_string())
    } else if after_colon.starts_with("false") {
        Some("false".to_string())
    } else {
        None
    }
}

fn extract_json_number(json: &str, key: &str) -> Option<f64> {
    let pattern = format!("\"{}\"", key);
    let idx = json.find(&pattern)?;
    let after_key = &json[idx + pattern.len()..];
    let after_colon = after_key.trim_start().strip_prefix(':')?.trim_start();

    if after_colon.starts_with('"') {
        let content = &after_colon[1..];
        let end = find_unescaped_quote(content)?;
        content[..end].parse().ok()
    } else {
        let end = after_colon
            .find(|c: char| !c.is_ascii_digit() && c != '.' && c != '-' && c != '+' && c != 'e' && c != 'E')
            .unwrap_or(after_colon.len());
        after_colon[..end].parse().ok()
    }
}

fn extract_json_object(json: &str, key: &str) -> Option<String> {
    let pattern = format!("\"{}\"", key);
    let idx = json.find(&pattern)?;
    let after_key = &json[idx + pattern.len()..];
    let after_colon = after_key.trim_start().strip_prefix(':')?.trim_start();

    if after_colon.starts_with('{') {
        let mut depth = 0i32;
        let mut in_string = false;
        let mut prev_char = '\0';

        for (i, c) in after_colon.char_indices() {
            if in_string {
                if c == '"' && prev_char != '\\' {
                    in_string = false;
                }
            } else {
                match c {
                    '"' => in_string = true,
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(after_colon[..i + 1].to_string());
                        }
                    }
                    _ => {}
                }
            }
            prev_char = c;
        }
    }

    None
}

/// Extract top-level objects from a JSON array string.
fn extract_array_objects(json: &str) -> Vec<String> {
    let trimmed = json.trim();
    if !trimmed.starts_with('[') || !trimmed.ends_with(']') {
        return vec![];
    }

    let inner = &trimmed[1..trimmed.len() - 1];
    let mut objects = Vec::new();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut prev_char = '\0';
    let mut obj_start = None;

    for (i, c) in inner.char_indices() {
        if in_string {
            if c == '"' && prev_char != '\\' {
                in_string = false;
            }
        } else {
            match c {
                '"' => in_string = true,
                '{' => {
                    if depth == 0 {
                        obj_start = Some(i);
                    }
                    depth += 1;
                }
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        if let Some(start) = obj_start.take() {
                            objects.push(inner[start..i + 1].to_string());
                        }
                    }
                }
                _ => {}
            }
        }
        prev_char = c;
    }

    objects
}

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

    // Find matching ]
    let mut depth = 0i32;
    let mut in_string = false;
    let mut prev_char = '\0';
    let mut end_idx = 0;

    for (i, c) in after_colon.char_indices() {
        if in_string {
            if c == '"' && prev_char != '\\' {
                in_string = false;
            }
        } else {
            match c {
                '"' => in_string = true,
                '[' => depth += 1,
                ']' => {
                    depth -= 1;
                    if depth == 0 {
                        end_idx = i + 1;
                        break;
                    }
                }
                _ => {}
            }
        }
        prev_char = c;
    }

    let array_str = &after_colon[..end_idx];
    extract_array_objects(array_str)
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
