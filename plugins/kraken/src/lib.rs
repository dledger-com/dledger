wit_bindgen::generate!({
    world: "source",
    path: "../../wit",
});

use dledger::plugin::http_client;
use dledger::plugin::ledger_write;
use dledger::plugin::logging;
use dledger::plugin::plugin_storage;
use dledger::plugin::types::*;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256, Sha512};

struct Kraken;

// --- Config keys ---
const KEY_API_KEY: &str = "api_key";
const KEY_API_SECRET: &str = "api_secret";
const KEY_BASE_CURRENCY: &str = "base_currency";
const KEY_MOCK_DATA: &str = "mock_data";
const KEY_API_URL: &str = "api_url";

const DEFAULT_API_URL: &str = "https://api.kraken.com";

impl exports::dledger::plugin::metadata::Guest for Kraken {
    fn get_metadata() -> PluginMetadata {
        PluginMetadata {
            name: "Kraken Exchange".to_string(),
            version: "0.1.0".to_string(),
            description: "Import trades from Kraken exchange via API".to_string(),
            author: "dledger".to_string(),
        }
    }
}

impl exports::dledger::plugin::source_ops::Guest for Kraken {
    fn config_schema() -> Vec<ConfigField> {
        vec![
            ConfigField {
                key: KEY_API_KEY.into(),
                label: "API Key".into(),
                field_type: "password".into(),
                required: true,
                default_value: String::new(),
                description: "Kraken API key (generate at kraken.com/u/security/api)".into(),
                options: String::new(),
            },
            ConfigField {
                key: KEY_API_SECRET.into(),
                label: "API Secret".into(),
                field_type: "password".into(),
                required: true,
                default_value: String::new(),
                description: "Kraken API secret (base64-encoded)".into(),
                options: String::new(),
            },
            ConfigField {
                key: KEY_BASE_CURRENCY.into(),
                label: "Base Currency".into(),
                field_type: "select".into(),
                required: true,
                default_value: "EUR".into(),
                description: "Your base fiat currency on Kraken".into(),
                options: "EUR,USD,GBP,CAD,JPY,CHF,AUD".into(),
            },
            ConfigField {
                key: KEY_API_URL.into(),
                label: "API URL".into(),
                field_type: "string".into(),
                required: false,
                default_value: DEFAULT_API_URL.into(),
                description: "Kraken API base URL (override for testing)".into(),
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

        // In mock mode, API credentials are optional
        if mock_data.is_empty() {
            let api_key = get(KEY_API_KEY).unwrap_or_default();
            if api_key.is_empty() {
                return Err("api_key is required".into());
            }

            let api_secret = get(KEY_API_SECRET).unwrap_or_default();
            if api_secret.is_empty() {
                return Err("api_secret is required".into());
            }

            // Validate that secret is valid base64
            if B64.decode(api_secret.as_bytes()).is_err() {
                return Err("api_secret must be valid base64".into());
            }
        }

        let base_currency = get(KEY_BASE_CURRENCY).unwrap_or_default();
        if base_currency.is_empty() {
            return Err("base_currency is required".into());
        }

        // Store config
        for (key, value) in &config {
            plugin_storage::set(key, value)
                .map_err(|e| format!("Failed to store config '{key}': {e:?}"))?;
        }

        logging::info("Kraken plugin configured successfully");
        Ok(())
    }

    fn test_connection() -> Result<String, String> {
        let mock_data = plugin_storage::get(KEY_MOCK_DATA)
            .map_err(|e| format!("Storage error: {e:?}"))?
            .unwrap_or_default();

        if !mock_data.is_empty() {
            return Ok("Mock mode: connection test skipped".into());
        }

        // In real mode, call Kraken's public time endpoint
        let api_url = plugin_storage::get(KEY_API_URL)
            .map_err(|e| format!("Storage error: {e:?}"))?
            .unwrap_or_else(|| DEFAULT_API_URL.to_string());

        let resp = http_client::send(&HttpRequest {
            method: "GET".into(),
            url: format!("{api_url}/0/public/Time"),
            headers: vec![],
            body: vec![],
        })
        .map_err(|e| format!("HTTP error: {e:?}"))?;

        if resp.status == 200 {
            Ok("Connected to Kraken API successfully".into())
        } else {
            Err(format!("Kraken API returned status {}", resp.status))
        }
    }

    fn sync(state: SyncState) -> Result<SyncResult, String> {
        logging::info("Starting Kraken trade sync");

        let config = load_config()?;

        // Parse cursor: offset into Kraken's TradesHistory pagination
        let offset: u64 = if state.cursor.is_empty() {
            0
        } else {
            state.cursor.parse().unwrap_or(0)
        };

        // Fetch trades
        let (trades, new_offset) = fetch_trades(&config, offset)?;

        if trades.is_empty() {
            logging::info("No new trades to import");
            return Ok(SyncResult {
                transactions: vec![],
                prices: vec![],
                new_state: SyncState {
                    cursor: format!("{new_offset}"),
                },
                summary: "No new trades to import".into(),
            });
        }

        // Ensure required accounts exist
        let base = &config.base_currency;
        let fiat_account = format!("Assets:Exchange:Kraken:{base}");
        let fiat_id = ledger_write::ensure_account(&fiat_account, "asset")
            .map_err(|e| format!("Failed to ensure fiat account: {e:?}"))?;

        let fee_account = "Expenses:Fees:Exchange:Kraken".to_string();
        let fee_id = ledger_write::ensure_account(&fee_account, "expense")
            .map_err(|e| format!("Failed to ensure fee account: {e:?}"))?;

        // Build transactions and prices from trades
        let mut transactions = Vec::new();
        let mut prices = Vec::new();

        for trade in &trades {
            let (tx, price) = trade_to_transaction(
                trade,
                &config.base_currency,
                &fiat_id,
                &fee_id,
            )?;
            transactions.push(tx);
            if let Some(p) = price {
                prices.push(p);
            }
        }

        // Submit transactions to ledger
        let submitted = if !transactions.is_empty() {
            ledger_write::submit_transactions(&transactions)
                .map_err(|e| format!("Failed to submit transactions: {e:?}"))?
        } else {
            0
        };

        // Submit prices
        if !prices.is_empty() {
            ledger_write::submit_prices(&prices)
                .map_err(|e| format!("Failed to submit prices: {e:?}"))?;
        }

        let summary = format!(
            "Imported {} trades from Kraken (offset {} -> {})",
            submitted, offset, new_offset
        );
        logging::info(&summary);

        Ok(SyncResult {
            transactions,
            prices,
            new_state: SyncState {
                cursor: format!("{new_offset}"),
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

export!(Kraken);

// --- Internal types and helpers ---

struct KrakenConfig {
    api_key: String,
    api_secret: String,
    base_currency: String,
    api_url: String,
    mock_data: String,
}

fn load_config() -> Result<KrakenConfig, String> {
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

    Ok(KrakenConfig {
        api_key: get_or(KEY_API_KEY, ""),
        api_secret: get_or(KEY_API_SECRET, ""),
        base_currency: get(KEY_BASE_CURRENCY)?,
        api_url: get_or(KEY_API_URL, DEFAULT_API_URL),
        mock_data: get_or(KEY_MOCK_DATA, ""),
    })
}

/// A parsed Kraken trade.
struct KrakenTrade {
    /// Trade ID from Kraken (e.g. "TXID123")
    id: String,
    /// Trading pair (e.g. "XXBTZEUR")
    pair: String,
    /// Unix timestamp
    time: f64,
    /// "buy" or "sell"
    direction: String,
    /// Volume of the base asset (e.g. BTC amount)
    volume: String,
    /// Price per unit in quote currency
    price: String,
    /// Total cost in quote currency
    cost: String,
    /// Fee in quote currency
    fee: String,
}

/// Fetch trades from Kraken (or mock data).
fn fetch_trades(config: &KrakenConfig, offset: u64) -> Result<(Vec<KrakenTrade>, u64), String> {
    if !config.mock_data.is_empty() {
        return parse_trades_response(&config.mock_data, offset);
    }

    let path = "/0/private/TradesHistory";
    let nonce = get_nonce();
    let post_data = format!("nonce={nonce}&ofs={offset}");

    let signature = sign_request(path, &nonce, &post_data, &config.api_secret)?;

    let resp = http_client::send(&HttpRequest {
        method: "POST".into(),
        url: format!("{}{path}", config.api_url),
        headers: vec![
            ("API-Key".into(), config.api_key.clone()),
            ("API-Sign".into(), signature),
            (
                "Content-Type".into(),
                "application/x-www-form-urlencoded".into(),
            ),
        ],
        body: post_data.into_bytes(),
    })
    .map_err(|e| format!("HTTP error: {e:?}"))?;

    if resp.status != 200 {
        return Err(format!("Kraken API returned status {}", resp.status));
    }

    let body = String::from_utf8(resp.body).map_err(|_| "Invalid UTF-8 in response")?;
    parse_trades_response(&body, offset)
}

/// Parse the Kraken TradesHistory JSON response.
/// Expected format:
/// {
///   "error": [],
///   "result": {
///     "trades": {
///       "TRADE-ID-1": { "pair": "XXBTZEUR", "time": 1700000000.0, "type": "buy",
///                        "vol": "0.5", "price": "30000.0", "cost": "15000.0", "fee": "24.0" },
///       ...
///     },
///     "count": 42
///   }
/// }
fn parse_trades_response(json: &str, offset: u64) -> Result<(Vec<KrakenTrade>, u64), String> {
    // Minimal JSON parser for Kraken's response format.
    // We avoid pulling in serde_json in the WASM plugin to keep binary small.

    // Check for errors first
    let errors = extract_json_array(json, "error");
    if !errors.is_empty() {
        let err_str = errors.join(", ");
        if !err_str.is_empty() && err_str != "[]" && err_str != "" {
            // Check if any actual error strings exist (not just empty array)
            let has_real_errors = errors.iter().any(|e| !e.is_empty());
            if has_real_errors {
                return Err(format!("Kraken API errors: {err_str}"));
            }
        }
    }

    // Extract trades object
    let trades_section = extract_json_object(json, "trades")
        .ok_or("No 'trades' in response")?;

    let trade_ids = extract_object_keys(&trades_section);
    let mut trades = Vec::new();

    for id in &trade_ids {
        let trade_json = extract_json_object(&trades_section, id);
        if let Some(tj) = trade_json {
            let trade = KrakenTrade {
                id: id.clone(),
                pair: extract_json_string(&tj, "pair").unwrap_or_default(),
                time: extract_json_number(&tj, "time").unwrap_or(0.0),
                direction: extract_json_string(&tj, "type").unwrap_or_default(),
                volume: extract_json_string(&tj, "vol").unwrap_or_default(),
                price: extract_json_string(&tj, "price").unwrap_or_default(),
                cost: extract_json_string(&tj, "cost").unwrap_or_default(),
                fee: extract_json_string(&tj, "fee").unwrap_or_default(),
            };
            trades.push(trade);
        }
    }

    // Sort by time ascending
    trades.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));

    let new_offset = offset + trades.len() as u64;

    Ok((trades, new_offset))
}

/// Convert a Kraken trade to a balanced double-entry transaction.
///
/// Uses Equity:Trading accounts so each currency balances to zero.
///
/// Buy 0.5 BTC for 20000 EUR (fee=32):
///   debit  Assets:Exchange:Kraken:BTC    +0.5 BTC
///   credit Equity:Trading:BTC            -0.5 BTC
///   debit  Equity:Trading:EUR            +20000 EUR
///   credit Assets:Exchange:Kraken:EUR    -20000 EUR
///   debit  Expenses:Fees:Exchange:Kraken +32 EUR
///   credit Assets:Exchange:Kraken:EUR    -32 EUR
///
/// Sell 0.25 BTC for 10500 EUR (fee=16.80):
///   credit Assets:Exchange:Kraken:BTC    -0.25 BTC
///   debit  Equity:Trading:BTC            +0.25 BTC
///   credit Equity:Trading:EUR            -10500 EUR
///   debit  Assets:Exchange:Kraken:EUR    +10500 EUR
///   debit  Expenses:Fees:Exchange:Kraken +16.80 EUR
///   credit Assets:Exchange:Kraken:EUR    -16.80 EUR
fn trade_to_transaction(
    trade: &KrakenTrade,
    base_currency: &str,
    fiat_account_id: &str,
    fee_account_id: &str,
) -> Result<(Transaction, Option<PricePoint>), String> {
    let (base_asset, quote_asset) = parse_pair(&trade.pair, base_currency);

    // Ensure crypto asset account exists
    let crypto_account_name = format!("Assets:Exchange:Kraken:{base_asset}");
    let crypto_account_id = ledger_write::ensure_account(&crypto_account_name, "asset")
        .map_err(|e| format!("Failed to ensure crypto account: {e:?}"))?;

    // Ensure trading equity accounts exist (one per currency for balanced entries)
    let trading_base_name = format!("Equity:Trading:{base_asset}");
    let trading_base_id = ledger_write::ensure_account(&trading_base_name, "equity")
        .map_err(|e| format!("Failed to ensure trading account: {e:?}"))?;

    let trading_quote_name = format!("Equity:Trading:{quote_asset}");
    let trading_quote_id = ledger_write::ensure_account(&trading_quote_name, "equity")
        .map_err(|e| format!("Failed to ensure trading account: {e:?}"))?;

    let date = timestamp_to_date(trade.time);
    let description = format!(
        "Kraken {} {} {} @ {} {}/{}",
        trade.direction, trade.volume, base_asset, trade.price, quote_asset, base_asset
    );

    let mut postings = Vec::new();

    match trade.direction.as_str() {
        "buy" => {
            // Base asset: debit exchange account, credit trading account
            postings.push(Posting {
                account: crypto_account_id.clone(),
                amount: Money {
                    amount: trade.volume.clone(),
                    currency: base_asset.clone(),
                },
            });
            postings.push(Posting {
                account: trading_base_id.clone(),
                amount: Money {
                    amount: negate(&trade.volume),
                    currency: base_asset.clone(),
                },
            });
            // Quote asset: debit trading account, credit exchange account
            postings.push(Posting {
                account: trading_quote_id.clone(),
                amount: Money {
                    amount: trade.cost.clone(),
                    currency: quote_asset.clone(),
                },
            });
            postings.push(Posting {
                account: fiat_account_id.to_string(),
                amount: Money {
                    amount: negate(&trade.cost),
                    currency: quote_asset.clone(),
                },
            });
        }
        "sell" => {
            // Base asset: credit exchange account, debit trading account
            postings.push(Posting {
                account: crypto_account_id.clone(),
                amount: Money {
                    amount: negate(&trade.volume),
                    currency: base_asset.clone(),
                },
            });
            postings.push(Posting {
                account: trading_base_id.clone(),
                amount: Money {
                    amount: trade.volume.clone(),
                    currency: base_asset.clone(),
                },
            });
            // Quote asset: credit trading account, debit exchange account
            postings.push(Posting {
                account: trading_quote_id.clone(),
                amount: Money {
                    amount: negate(&trade.cost),
                    currency: quote_asset.clone(),
                },
            });
            postings.push(Posting {
                account: fiat_account_id.to_string(),
                amount: Money {
                    amount: trade.cost.clone(),
                    currency: quote_asset.clone(),
                },
            });
        }
        other => {
            return Err(format!("Unknown trade direction: {other}"));
        }
    }

    // Fee posting (always in quote currency)
    let fee_val = trade.fee.trim();
    if !fee_val.is_empty() && fee_val != "0" && fee_val != "0.0" && fee_val != "0.00" {
        // Debit fee expense
        postings.push(Posting {
            account: fee_account_id.to_string(),
            amount: Money {
                amount: fee_val.to_string(),
                currency: quote_asset.clone(),
            },
        });
        // Credit fiat account for fee
        postings.push(Posting {
            account: fiat_account_id.to_string(),
            amount: Money {
                amount: negate(fee_val),
                currency: quote_asset.clone(),
            },
        });
    }

    let tx = Transaction {
        date: date.clone(),
        description,
        postings,
        metadata: vec![
            ("kraken_trade_id".into(), trade.id.clone()),
            ("kraken_pair".into(), trade.pair.clone()),
        ],
    };

    // Also emit a price point
    let price = if !trade.price.is_empty() {
        Some(PricePoint {
            date,
            from_currency: base_asset,
            to_currency: quote_asset,
            rate: trade.price.clone(),
            source: "kraken".into(),
        })
    } else {
        None
    };

    Ok((tx, price))
}

/// Parse a Kraken trading pair into (base_asset, quote_asset).
/// Kraken uses prefixed names like XXBTZEUR, XETHZEUR, ADAEUR, SOLEUR, etc.
fn parse_pair(pair: &str, base_currency: &str) -> (String, String) {
    // Known Kraken prefixed pairs
    let known_bases = [
        ("XXBT", "BTC"),
        ("XETH", "ETH"),
        ("XXRP", "XRP"),
        ("XLTC", "LTC"),
        ("XXLM", "XLM"),
        ("XXDG", "DOGE"),
        ("XZEC", "ZEC"),
        ("XREP", "REP"),
        ("XETC", "ETC"),
        ("XMLN", "MLN"),
    ];

    let known_quotes = [
        ("ZEUR", "EUR"),
        ("ZUSD", "USD"),
        ("ZGBP", "GBP"),
        ("ZCAD", "CAD"),
        ("ZJPY", "JPY"),
        ("ZCHF", "CHF"),
        ("ZAUD", "AUD"),
    ];

    // Try prefixed format first (e.g. XXBTZEUR)
    for (prefix, asset) in &known_bases {
        if pair.starts_with(prefix) {
            let remainder = &pair[prefix.len()..];
            for (qprefix, qasset) in &known_quotes {
                if remainder == *qprefix {
                    return (asset.to_string(), qasset.to_string());
                }
            }
            // Quote without prefix (e.g. XXBTEUR - unlikely but handle it)
            return (asset.to_string(), remainder.to_string());
        }
    }

    // Try unprefixed format (e.g. ADAEUR, SOLEUR)
    // Attempt to find the quote currency suffix
    let quote_suffixes = ["EUR", "USD", "GBP", "CAD", "JPY", "CHF", "AUD"];
    for suffix in &quote_suffixes {
        if pair.ends_with(suffix) && pair.len() > suffix.len() {
            let base = &pair[..pair.len() - suffix.len()];
            return (base.to_string(), suffix.to_string());
        }
    }

    // Fallback: try to split at base_currency position
    if pair.contains(base_currency) {
        let idx = pair.find(base_currency).unwrap();
        if idx > 0 {
            return (pair[..idx].to_string(), base_currency.to_string());
        }
    }

    // Ultimate fallback
    logging::warn(&format!("Could not parse pair: {pair}"));
    (pair.to_string(), base_currency.to_string())
}

/// Convert Unix timestamp to YYYY-MM-DD.
fn timestamp_to_date(ts: f64) -> String {
    let total_secs = ts as i64;
    let days_since_epoch = total_secs / 86400;

    // Convert days since 1970-01-01 to year-month-day
    // Using a simple calendar algorithm
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

/// Generate a nonce (milliseconds since epoch approximation).
/// In WASM we don't have access to system time, so we use plugin storage
/// to maintain a monotonically increasing counter.
fn get_nonce() -> String {
    let current = plugin_storage::get("__nonce__")
        .ok()
        .flatten()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(1_000_000_000_000);

    let next = current + 1;
    let _ = plugin_storage::set("__nonce__", &next.to_string());
    next.to_string()
}

/// Sign a Kraken API request.
/// Signature = HMAC-SHA512(path + SHA256(nonce + postdata), base64_decode(secret))
fn sign_request(path: &str, nonce: &str, post_data: &str, secret_b64: &str) -> Result<String, String> {
    let secret = B64.decode(secret_b64.as_bytes())
        .map_err(|_| "Invalid base64 in API secret")?;

    // SHA256(nonce + postdata)
    let mut sha256 = Sha256::new();
    sha256.update(nonce.as_bytes());
    sha256.update(post_data.as_bytes());
    let sha256_hash = sha256.finalize();

    // path_bytes + sha256_hash
    let mut message = Vec::new();
    message.extend_from_slice(path.as_bytes());
    message.extend_from_slice(&sha256_hash);

    // HMAC-SHA512
    let mut mac = Hmac::<Sha512>::new_from_slice(&secret)
        .map_err(|_| "Invalid HMAC key")?;
    mac.update(&message);
    let result = mac.finalize();

    Ok(B64.encode(result.into_bytes()))
}

/// Negate a decimal string.
fn negate(s: &str) -> String {
    let s = s.trim();
    if s.starts_with('-') {
        s[1..].to_string()
    } else if s.starts_with('+') {
        format!("-{}", &s[1..])
    } else {
        format!("-{s}")
    }
}

// --- Minimal JSON parsing helpers ---
// We implement basic JSON extraction to avoid pulling serde_json into the WASM binary.

/// Extract a string value for a given key from a JSON object.
fn extract_json_string(json: &str, key: &str) -> Option<String> {
    let pattern = format!("\"{}\"", key);
    let idx = json.find(&pattern)?;
    let after_key = &json[idx + pattern.len()..];

    // Skip whitespace and colon
    let after_colon = after_key.trim_start();
    let after_colon = after_colon.strip_prefix(':')?;
    let after_colon = after_colon.trim_start();

    if after_colon.starts_with('"') {
        // String value
        let content = &after_colon[1..];
        let end = find_unescaped_quote(content)?;
        Some(content[..end].to_string())
    } else {
        None
    }
}

/// Extract a numeric value for a given key from a JSON object.
fn extract_json_number(json: &str, key: &str) -> Option<f64> {
    let pattern = format!("\"{}\"", key);
    let idx = json.find(&pattern)?;
    let after_key = &json[idx + pattern.len()..];

    let after_colon = after_key.trim_start();
    let after_colon = after_colon.strip_prefix(':')?;
    let after_colon = after_colon.trim_start();

    // Could be quoted string or bare number
    if after_colon.starts_with('"') {
        let content = &after_colon[1..];
        let end = find_unescaped_quote(content)?;
        content[..end].parse().ok()
    } else {
        // Bare number - read until non-numeric
        let end = after_colon
            .find(|c: char| !c.is_ascii_digit() && c != '.' && c != '-' && c != '+' && c != 'e' && c != 'E')
            .unwrap_or(after_colon.len());
        after_colon[..end].parse().ok()
    }
}

/// Extract a JSON object value for a given key.
fn extract_json_object(json: &str, key: &str) -> Option<String> {
    let pattern = format!("\"{}\"", key);
    let idx = json.find(&pattern)?;
    let after_key = &json[idx + pattern.len()..];

    let after_colon = after_key.trim_start();
    let after_colon = after_colon.strip_prefix(':')?;
    let after_colon = after_colon.trim_start();

    if after_colon.starts_with('{') {
        // Find matching closing brace
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

/// Extract top-level keys from a JSON object.
fn extract_object_keys(json: &str) -> Vec<String> {
    let mut keys = Vec::new();
    let trimmed = json.trim();

    if !trimmed.starts_with('{') || !trimmed.ends_with('}') {
        return keys;
    }

    let inner = &trimmed[1..trimmed.len() - 1];
    let mut depth = 0i32;
    let mut in_string = false;
    let mut key_start = None;
    let mut prev_char = '\0';

    for (i, c) in inner.char_indices() {
        if in_string {
            if c == '"' && prev_char != '\\' {
                in_string = false;
                if depth == 0 {
                    if let Some(start) = key_start.take() {
                        // Check if next non-whitespace is ':'
                        let rest = inner[i + 1..].trim_start();
                        if rest.starts_with(':') {
                            keys.push(inner[start..i].to_string());
                        }
                    }
                }
            }
        } else {
            match c {
                '"' => {
                    in_string = true;
                    if depth == 0 {
                        key_start = Some(i + 1);
                    }
                }
                '{' | '[' => depth += 1,
                '}' | ']' => depth -= 1,
                _ => {}
            }
        }
        prev_char = c;
    }

    keys
}

/// Extract elements from a JSON array for the given key.
fn extract_json_array(json: &str, key: &str) -> Vec<String> {
    let pattern = format!("\"{}\"", key);
    let Some(idx) = json.find(&pattern) else {
        return vec![];
    };
    let after_key = &json[idx + pattern.len()..];
    let after_colon = after_key.trim_start();
    let Some(after_colon) = after_colon.strip_prefix(':') else {
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
                        end_idx = i;
                        break;
                    }
                }
                _ => {}
            }
        }
        prev_char = c;
    }

    let array_content = &after_colon[1..end_idx];
    let trimmed = array_content.trim();

    if trimmed.is_empty() {
        return vec![];
    }

    // Split by comma at depth 0
    let mut elements = Vec::new();
    let mut current = String::new();
    depth = 0;
    in_string = false;
    prev_char = '\0';

    for c in trimmed.chars() {
        if in_string {
            if c == '"' && prev_char != '\\' {
                in_string = false;
            }
            current.push(c);
        } else {
            match c {
                '"' => {
                    in_string = true;
                    current.push(c);
                }
                '{' | '[' => {
                    depth += 1;
                    current.push(c);
                }
                '}' | ']' => {
                    depth -= 1;
                    current.push(c);
                }
                ',' if depth == 0 => {
                    let el = current.trim().to_string();
                    if !el.is_empty() {
                        // Unquote string elements
                        if el.starts_with('"') && el.ends_with('"') {
                            elements.push(el[1..el.len() - 1].to_string());
                        } else {
                            elements.push(el);
                        }
                    }
                    current = String::new();
                }
                _ => current.push(c),
            }
        }
        prev_char = c;
    }

    let last = current.trim().to_string();
    if !last.is_empty() {
        if last.starts_with('"') && last.ends_with('"') {
            elements.push(last[1..last.len() - 1].to_string());
        } else {
            elements.push(last);
        }
    }

    elements
}

/// Find the position of the next unescaped double quote.
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
