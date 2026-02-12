wit_bindgen::generate!({
    world: "source",
    path: "../../wit",
});

use dledger::plugin::logging;
use dledger::plugin::ledger_write;
use dledger::plugin::plugin_storage;
use dledger::plugin::types::*;

struct CsvImport;

// --- Config keys ---
const KEY_ACCOUNT: &str = "account";
const KEY_CONTRA_ACCOUNT: &str = "contra_account";
const KEY_ACCOUNT_TYPE: &str = "account_type";
const KEY_CONTRA_ACCOUNT_TYPE: &str = "contra_account_type";
const KEY_CURRENCY: &str = "currency";
const KEY_DATE_COL: &str = "date_column";
const KEY_DESC_COL: &str = "description_column";
const KEY_AMOUNT_COL: &str = "amount_column";
const KEY_DATE_FORMAT: &str = "date_format";
const KEY_SKIP_HEADER: &str = "skip_header";
const KEY_CSV_DATA: &str = "csv_data";
const KEY_DELIMITER: &str = "delimiter";

impl exports::dledger::plugin::metadata::Guest for CsvImport {
    fn get_metadata() -> PluginMetadata {
        PluginMetadata {
            name: "CSV Import".to_string(),
            version: "0.1.0".to_string(),
            description: "Import transactions from CSV bank statements".to_string(),
            author: "dledger".to_string(),
        }
    }
}

impl exports::dledger::plugin::source_ops::Guest for CsvImport {
    fn config_schema() -> Vec<ConfigField> {
        vec![
            ConfigField {
                key: KEY_ACCOUNT.into(),
                label: "Bank Account".into(),
                field_type: "string".into(),
                required: true,
                default_value: "Assets:Bank:Checking".into(),
                description: "The account this CSV belongs to (e.g. Assets:Bank:Checking)".into(),
                options: String::new(),
            },
            ConfigField {
                key: KEY_CONTRA_ACCOUNT.into(),
                label: "Default Contra Account".into(),
                field_type: "string".into(),
                required: true,
                default_value: "Expenses:Uncategorized".into(),
                description: "Default counterparty account for all rows".into(),
                options: String::new(),
            },
            ConfigField {
                key: KEY_ACCOUNT_TYPE.into(),
                label: "Account Type".into(),
                field_type: "select".into(),
                required: true,
                default_value: "asset".into(),
                description: "Type of the bank account".into(),
                options: "asset,liability".into(),
            },
            ConfigField {
                key: KEY_CONTRA_ACCOUNT_TYPE.into(),
                label: "Contra Account Type".into(),
                field_type: "select".into(),
                required: true,
                default_value: "expense".into(),
                description: "Type of the contra account".into(),
                options: "asset,liability,equity,revenue,expense".into(),
            },
            ConfigField {
                key: KEY_CURRENCY.into(),
                label: "Currency".into(),
                field_type: "string".into(),
                required: true,
                default_value: "EUR".into(),
                description: "Currency code (e.g. EUR, USD, BTC)".into(),
                options: String::new(),
            },
            ConfigField {
                key: KEY_DATE_COL.into(),
                label: "Date Column".into(),
                field_type: "number".into(),
                required: true,
                default_value: "0".into(),
                description: "0-based column index for the date".into(),
                options: String::new(),
            },
            ConfigField {
                key: KEY_DESC_COL.into(),
                label: "Description Column".into(),
                field_type: "number".into(),
                required: true,
                default_value: "1".into(),
                description: "0-based column index for the description".into(),
                options: String::new(),
            },
            ConfigField {
                key: KEY_AMOUNT_COL.into(),
                label: "Amount Column".into(),
                field_type: "number".into(),
                required: true,
                default_value: "2".into(),
                description: "0-based column index for the amount".into(),
                options: String::new(),
            },
            ConfigField {
                key: KEY_DATE_FORMAT.into(),
                label: "Date Format".into(),
                field_type: "string".into(),
                required: false,
                default_value: "%Y-%m-%d".into(),
                description: "strftime date format (e.g. %Y-%m-%d, %d/%m/%Y)".into(),
                options: String::new(),
            },
            ConfigField {
                key: KEY_SKIP_HEADER.into(),
                label: "Skip Header Row".into(),
                field_type: "boolean".into(),
                required: false,
                default_value: "true".into(),
                description: "Skip the first row (header)".into(),
                options: String::new(),
            },
            ConfigField {
                key: KEY_DELIMITER.into(),
                label: "Delimiter".into(),
                field_type: "string".into(),
                required: false,
                default_value: ",".into(),
                description: "Field delimiter character (comma, semicolon, tab)".into(),
                options: String::new(),
            },
            ConfigField {
                key: KEY_CSV_DATA.into(),
                label: "CSV Data".into(),
                field_type: "string".into(),
                required: true,
                default_value: String::new(),
                description: "The raw CSV content to import".into(),
                options: String::new(),
            },
        ]
    }

    fn configure(config: Vec<(String, String)>) -> Result<(), String> {
        // Validate required fields
        let get = |key: &str| -> Option<String> {
            config.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
        };

        let account = get(KEY_ACCOUNT).unwrap_or_default();
        if account.is_empty() {
            return Err("account is required".into());
        }

        let contra = get(KEY_CONTRA_ACCOUNT).unwrap_or_default();
        if contra.is_empty() {
            return Err("contra_account is required".into());
        }

        let currency = get(KEY_CURRENCY).unwrap_or_default();
        if currency.is_empty() {
            return Err("currency is required".into());
        }

        let csv_data = get(KEY_CSV_DATA).unwrap_or_default();
        if csv_data.is_empty() {
            return Err("csv_data is required".into());
        }

        // Validate column indices are numeric
        for key in [KEY_DATE_COL, KEY_DESC_COL, KEY_AMOUNT_COL] {
            if let Some(val) = get(key) {
                if val.parse::<usize>().is_err() {
                    return Err(format!("{key} must be a non-negative integer"));
                }
            }
        }

        // Store all config in plugin storage
        for (key, value) in &config {
            plugin_storage::set(key, value)
                .map_err(|e| format!("Failed to store config '{key}': {e:?}"))?;
        }

        logging::info("CSV Import configured successfully");
        Ok(())
    }

    fn test_connection() -> Result<String, String> {
        let csv_data = plugin_storage::get(KEY_CSV_DATA)
            .map_err(|e| format!("Storage error: {e:?}"))?;

        match csv_data {
            Some(data) => {
                let line_count = data.lines().count();
                Ok(format!("CSV loaded: {line_count} lines"))
            }
            None => Err("No CSV data configured. Run configure first.".into()),
        }
    }

    fn sync(state: SyncState) -> Result<SyncResult, String> {
        logging::info("Starting CSV import sync");

        // Load config from storage
        let config = load_config()?;

        // Parse cursor: number of rows already imported
        let imported_count: usize = if state.cursor.is_empty() {
            0
        } else {
            state.cursor.parse().unwrap_or(0)
        };

        // Parse CSV
        let rows = parse_csv(
            &config.csv_data,
            &config.delimiter,
            config.skip_header,
        );

        // Skip already-imported rows
        let new_rows: Vec<&CsvRow> = rows.iter().skip(imported_count).collect();

        if new_rows.is_empty() {
            logging::info("No new rows to import");
            return Ok(SyncResult {
                transactions: vec![],
                prices: vec![],
                new_state: SyncState {
                    cursor: format!("{}", rows.len()),
                },
                summary: "No new rows to import".into(),
            });
        }

        // Ensure accounts exist
        let account_id = ledger_write::ensure_account(&config.account, &config.account_type)
            .map_err(|e| format!("Failed to ensure account '{}': {e:?}", config.account))?;

        let contra_id = ledger_write::ensure_account(&config.contra_account, &config.contra_account_type)
            .map_err(|e| format!("Failed to ensure contra account '{}': {e:?}", config.contra_account))?;

        // Build transactions from CSV rows
        let mut transactions = Vec::new();
        let mut skipped = 0u32;

        for row in &new_rows {
            let date_str = row.get_field(config.date_col);
            let desc_str = row.get_field(config.desc_col);
            let amount_str = row.get_field(config.amount_col);

            // Parse and reformat the date to YYYY-MM-DD
            let date = match parse_date(date_str, &config.date_format) {
                Some(d) => d,
                None => {
                    logging::warn(&format!("Skipping row: invalid date '{date_str}'"));
                    skipped += 1;
                    continue;
                }
            };

            // Clean amount: remove spaces, replace comma decimal separator
            let clean_amount = clean_amount_str(amount_str);
            if clean_amount.is_empty() {
                logging::warn(&format!("Skipping row: invalid amount '{amount_str}'"));
                skipped += 1;
                continue;
            }

            // Negate for contra account
            let neg_amount = negate_amount(&clean_amount);

            let tx = Transaction {
                date,
                description: desc_str.to_string(),
                postings: vec![
                    Posting {
                        account: account_id.clone(),
                        amount: Money {
                            amount: clean_amount,
                            currency: config.currency.clone(),
                        },
                    },
                    Posting {
                        account: contra_id.clone(),
                        amount: Money {
                            amount: neg_amount,
                            currency: config.currency.clone(),
                        },
                    },
                ],
                metadata: vec![],
            };

            transactions.push(tx);
        }

        // Submit to ledger
        let submitted = if !transactions.is_empty() {
            ledger_write::submit_transactions(&transactions)
                .map_err(|e| format!("Failed to submit transactions: {e:?}"))?
        } else {
            0
        };

        let total_imported = imported_count + new_rows.len();
        let summary = format!(
            "Imported {} transactions ({} skipped) from {} CSV rows",
            submitted, skipped, new_rows.len()
        );
        logging::info(&summary);

        Ok(SyncResult {
            transactions,
            prices: vec![],
            new_state: SyncState {
                cursor: format!("{total_imported}"),
            },
            summary,
        })
    }

    fn full_import(state: SyncState) -> Result<SyncResult, String> {
        // Reset cursor and reimport everything
        let fresh_state = SyncState {
            cursor: String::new(),
        };
        let _ = state; // ignore provided state
        Self::sync(fresh_state)
    }
}

export!(CsvImport);

// --- Internal helpers ---

struct ImportConfig {
    account: String,
    contra_account: String,
    account_type: String,
    contra_account_type: String,
    currency: String,
    date_col: usize,
    desc_col: usize,
    amount_col: usize,
    date_format: String,
    skip_header: bool,
    delimiter: String,
    csv_data: String,
}

fn load_config() -> Result<ImportConfig, String> {
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

    Ok(ImportConfig {
        account: get(KEY_ACCOUNT)?,
        contra_account: get(KEY_CONTRA_ACCOUNT)?,
        account_type: get_or(KEY_ACCOUNT_TYPE, "asset"),
        contra_account_type: get_or(KEY_CONTRA_ACCOUNT_TYPE, "expense"),
        currency: get(KEY_CURRENCY)?,
        date_col: get_or(KEY_DATE_COL, "0").parse().unwrap_or(0),
        desc_col: get_or(KEY_DESC_COL, "1").parse().unwrap_or(1),
        amount_col: get_or(KEY_AMOUNT_COL, "2").parse().unwrap_or(2),
        date_format: get_or(KEY_DATE_FORMAT, "%Y-%m-%d"),
        skip_header: get_or(KEY_SKIP_HEADER, "true") == "true",
        delimiter: get_or(KEY_DELIMITER, ","),
        csv_data: get(KEY_CSV_DATA)?,
    })
}

struct CsvRow {
    fields: Vec<String>,
}

impl CsvRow {
    fn get_field(&self, idx: usize) -> &str {
        self.fields.get(idx).map(|s| s.as_str()).unwrap_or("")
    }
}

fn parse_csv(data: &str, delimiter: &str, skip_header: bool) -> Vec<CsvRow> {
    let delim = delimiter.chars().next().unwrap_or(',');
    let mut rows = Vec::new();

    for (i, line) in data.lines().enumerate() {
        if skip_header && i == 0 {
            continue;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let fields = parse_csv_line(trimmed, delim);
        rows.push(CsvRow { fields });
    }

    rows
}

/// Parse a single CSV line, handling quoted fields.
fn parse_csv_line(line: &str, delim: char) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();

    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                // Check for escaped quote ("")
                if chars.peek() == Some(&'"') {
                    current.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                current.push(c);
            }
        } else if c == '"' {
            in_quotes = true;
        } else if c == delim {
            fields.push(current.trim().to_string());
            current = String::new();
        } else {
            current.push(c);
        }
    }

    fields.push(current.trim().to_string());
    fields
}

/// Parse a date string using the given format and return YYYY-MM-DD.
/// Supports common formats without a full strftime implementation.
fn parse_date(date_str: &str, format: &str) -> Option<String> {
    let date_str = date_str.trim();

    match format {
        "%Y-%m-%d" => {
            // Already in the right format, just validate
            let parts: Vec<&str> = date_str.split('-').collect();
            if parts.len() == 3
                && parts[0].len() == 4
                && parts[1].len() <= 2
                && parts[2].len() <= 2
            {
                let y: u32 = parts[0].parse().ok()?;
                let m: u32 = parts[1].parse().ok()?;
                let d: u32 = parts[2].parse().ok()?;
                if m >= 1 && m <= 12 && d >= 1 && d <= 31 {
                    return Some(format!("{y:04}-{m:02}-{d:02}"));
                }
            }
            None
        }
        "%d/%m/%Y" => {
            let parts: Vec<&str> = date_str.split('/').collect();
            if parts.len() == 3 {
                let d: u32 = parts[0].parse().ok()?;
                let m: u32 = parts[1].parse().ok()?;
                let y: u32 = parts[2].parse().ok()?;
                if m >= 1 && m <= 12 && d >= 1 && d <= 31 {
                    return Some(format!("{y:04}-{m:02}-{d:02}"));
                }
            }
            None
        }
        "%m/%d/%Y" => {
            let parts: Vec<&str> = date_str.split('/').collect();
            if parts.len() == 3 {
                let m: u32 = parts[0].parse().ok()?;
                let d: u32 = parts[1].parse().ok()?;
                let y: u32 = parts[2].parse().ok()?;
                if m >= 1 && m <= 12 && d >= 1 && d <= 31 {
                    return Some(format!("{y:04}-{m:02}-{d:02}"));
                }
            }
            None
        }
        "%d.%m.%Y" => {
            let parts: Vec<&str> = date_str.split('.').collect();
            if parts.len() == 3 {
                let d: u32 = parts[0].parse().ok()?;
                let m: u32 = parts[1].parse().ok()?;
                let y: u32 = parts[2].parse().ok()?;
                if m >= 1 && m <= 12 && d >= 1 && d <= 31 {
                    return Some(format!("{y:04}-{m:02}-{d:02}"));
                }
            }
            None
        }
        _ => {
            // Fallback: try YYYY-MM-DD directly
            parse_date(date_str, "%Y-%m-%d")
        }
    }
}

/// Clean an amount string: remove thousands separators, normalize decimal.
fn clean_amount_str(s: &str) -> String {
    let s = s.trim();

    // Handle European format: 1.234,56 -> 1234.56
    // If there's both dots and commas, the last one is the decimal separator
    let has_comma = s.contains(',');
    let has_dot = s.contains('.');

    if has_comma && has_dot {
        // Determine which is the decimal separator (the last one)
        let last_comma = s.rfind(',').unwrap();
        let last_dot = s.rfind('.').unwrap();

        if last_comma > last_dot {
            // European: 1.234,56 -> remove dots, replace comma with dot
            s.replace('.', "").replace(',', ".")
        } else {
            // US: 1,234.56 -> just remove commas
            s.replace(',', "")
        }
    } else if has_comma && !has_dot {
        // Could be European decimal or thousands separator
        // If there's exactly one comma and digits after it <= 2, treat as decimal
        let parts: Vec<&str> = s.split(',').collect();
        if parts.len() == 2 && parts[1].trim_start_matches('-').len() <= 3 {
            s.replace(',', ".")
        } else {
            // Multiple commas = thousands separators with no decimals
            s.replace(',', "")
        }
    } else {
        // No comma, or already has dot only
        s.to_string()
    }
}

/// Negate a decimal string amount.
fn negate_amount(amount: &str) -> String {
    if amount.starts_with('-') {
        amount[1..].to_string()
    } else if amount.starts_with('+') {
        format!("-{}", &amount[1..])
    } else {
        format!("-{amount}")
    }
}
