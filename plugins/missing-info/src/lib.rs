wit_bindgen::generate!({
    world: "handler",
    path: "../../wit",
});

use dledger::plugin::ledger_read;
use dledger::plugin::logging;
use dledger::plugin::plugin_storage;
use dledger::plugin::types::*;

struct MissingInfo;

impl exports::dledger::plugin::metadata::Guest for MissingInfo {
    fn get_metadata() -> PluginMetadata {
        PluginMetadata {
            name: "Missing Info Detector".to_string(),
            version: "0.1.0".to_string(),
            description: "Scan ledger for transactions with missing or ambiguous data".to_string(),
            author: "dledger".to_string(),
        }
    }
}

impl exports::dledger::plugin::handler_ops::Guest for MissingInfo {
    fn config_schema() -> Vec<ConfigField> {
        vec![ConfigField {
            key: "base_currency".into(),
            label: "Base Currency".into(),
            field_type: "select".into(),
            required: true,
            default_value: "EUR".into(),
            description: "Fiat currency for value assessments".into(),
            options: "EUR,USD,GBP".into(),
        }]
    }

    fn configure(config: Vec<(String, String)>) -> Result<(), String> {
        for (key, value) in &config {
            plugin_storage::set(key, value)
                .map_err(|e| format!("Storage error: {e:?}"))?;
        }
        Ok(())
    }

    /// Scan for missing info. Returns JSON array of issues.
    fn process(params: String) -> Result<String, String> {
        logging::info("Scanning for missing information");

        let base_currency = plugin_storage::get("base_currency")
            .map_err(|e| format!("Storage error: {e:?}"))?
            .unwrap_or_else(|| "EUR".to_string());

        let (from_date, to_date) = parse_date_range(&params)?;

        let accounts = ledger_read::list_accounts()
            .map_err(|e| format!("Failed to list accounts: {e:?}"))?;

        let transactions = ledger_read::query_transactions(&QueryParams {
            limit: 10000,
            offset: 0,
            account_filter: String::new(),
            from_date: from_date.clone(),
            to_date: to_date.clone(),
        })
        .map_err(|e| format!("Failed to query transactions: {e:?}"))?;

        let mut issues: Vec<Issue> = Vec::new();

        // Check 1: Transactions with "External" or "Unknown" in account names
        for tx in &transactions {
            for posting in &tx.postings {
                let account_name = find_account_name(&accounts, &posting.account);
                if account_name.contains("External") || account_name.contains("Unknown") {
                    issues.push(Issue {
                        severity: "warning".into(),
                        category: "unclassified_counterparty".into(),
                        description: format!(
                            "Transaction '{}' on {} has posting to unclassified account '{}'",
                            tx.description, tx.date, account_name
                        ),
                        transaction_date: tx.date.clone(),
                        amount: posting_total_str(posting),
                        suggestion: "Classify this counterparty as income, expense, or self-transfer".into(),
                    });
                }
            }
        }

        // Check 2: Transactions missing exchange rates for crypto
        for tx in &transactions {
            let has_crypto = tx.postings.iter().any(|p| {
                p.amount.currency != base_currency
                    && !is_equity_account(&accounts, &p.account)
            });

            if has_crypto {
                let has_fiat = tx.postings.iter().any(|p| p.amount.currency == base_currency);
                if !has_fiat {
                    // Check if exchange rate exists
                    for posting in &tx.postings {
                        if posting.amount.currency != base_currency
                            && !is_equity_account(&accounts, &posting.account)
                        {
                            let rate = ledger_read::get_exchange_rate(
                                &posting.amount.currency,
                                &base_currency,
                                &tx.date,
                            );
                            if rate.ok().flatten().is_none() {
                                issues.push(Issue {
                                    severity: "error".into(),
                                    category: "missing_exchange_rate".into(),
                                    description: format!(
                                        "No {}/{} exchange rate for {} on {}",
                                        posting.amount.currency, base_currency,
                                        tx.description, tx.date
                                    ),
                                    transaction_date: tx.date.clone(),
                                    amount: posting_total_str(posting),
                                    suggestion: format!(
                                        "Add a {}/{} price for {}",
                                        posting.amount.currency, base_currency, tx.date
                                    ),
                                });
                                break; // One issue per transaction
                            }
                        }
                    }
                }
            }
        }

        // Check 3: Potential duplicates (same amount, same currency, close dates)
        let mut seen: Vec<(String, String, String)> = Vec::new(); // (date, amount, currency)
        for tx in &transactions {
            for posting in &tx.postings {
                let key = (tx.date.clone(), posting.amount.amount.clone(), posting.amount.currency.clone());
                if seen.iter().any(|s| {
                    s.1 == key.1
                        && s.2 == key.2
                        && dates_within_days(&s.0, &key.0, 1)
                        && s.0 != key.0 // different date (same-date same-amount is fine for balanced entries)
                }) {
                    issues.push(Issue {
                        severity: "info".into(),
                        category: "potential_duplicate".into(),
                        description: format!(
                            "Possible duplicate: {} {} {} on {} (similar to nearby transaction)",
                            posting.amount.amount, posting.amount.currency,
                            tx.description, tx.date
                        ),
                        transaction_date: tx.date.clone(),
                        amount: posting_total_str(posting),
                        suggestion: "Review if this is a duplicate from another source".into(),
                    });
                }
                seen.push(key);
            }
        }

        // Check 4: Transactions with empty descriptions
        for tx in &transactions {
            if tx.description.trim().is_empty() {
                issues.push(Issue {
                    severity: "warning".into(),
                    category: "missing_description".into(),
                    description: format!(
                        "Transaction on {} has no description",
                        tx.date
                    ),
                    transaction_date: tx.date.clone(),
                    amount: String::new(),
                    suggestion: "Add a description to identify this transaction".into(),
                });
            }
        }

        // Sort by severity (errors first, then warnings, then info)
        issues.sort_by(|a, b| {
            severity_rank(&a.severity).cmp(&severity_rank(&b.severity))
        });

        let total = issues.len();
        let errors = issues.iter().filter(|i| i.severity == "error").count();
        let warnings = issues.iter().filter(|i| i.severity == "warning").count();

        logging::info(&format!(
            "Found {} issues ({} errors, {} warnings)",
            total, errors, warnings
        ));

        Ok(issues_to_json(&issues))
    }

    fn generate_report(format: String, params: String) -> Result<Vec<u8>, String> {
        let json_result = Self::process(params)?;

        match format.as_str() {
            "json" => Ok(json_result.into_bytes()),
            "csv" => {
                let issues = parse_issues_json(&json_result);
                let mut csv = String::new();
                csv.push_str("Severity,Category,Date,Amount,Description,Suggestion\n");
                for issue in &issues {
                    csv.push_str(&format!(
                        "{},{},{},{},\"{}\",\"{}\"\n",
                        issue.severity, issue.category, issue.transaction_date,
                        issue.amount,
                        issue.description.replace('"', "\"\""),
                        issue.suggestion.replace('"', "\"\""),
                    ));
                }
                Ok(csv.into_bytes())
            }
            other => Err(format!("Unsupported format: {other}")),
        }
    }
}

export!(MissingInfo);

// --- Internal types ---

struct Issue {
    severity: String,    // "error", "warning", "info"
    category: String,    // "unclassified_counterparty", "missing_exchange_rate", etc.
    description: String,
    transaction_date: String,
    amount: String,
    suggestion: String,
}

// --- Helpers ---

fn parse_date_range(params: &str) -> Result<(String, String), String> {
    let from = extract_json_string(params, "from_date").unwrap_or_else(|| "2000-01-01".into());
    let to = extract_json_string(params, "to_date").unwrap_or_else(|| "2099-12-31".into());
    Ok((from, to))
}

fn find_account_name(accounts: &[AccountInfo], id: &str) -> String {
    accounts
        .iter()
        .find(|a| a.id == id)
        .map(|a| a.full_name.clone())
        .unwrap_or_else(|| id.to_string())
}

fn is_equity_account(accounts: &[AccountInfo], id: &str) -> bool {
    accounts
        .iter()
        .find(|a| a.id == id)
        .map(|a| a.account_type == "equity")
        .unwrap_or(false)
}

fn posting_total_str(posting: &Posting) -> String {
    format!("{} {}", posting.amount.amount, posting.amount.currency)
}

fn severity_rank(severity: &str) -> u8 {
    match severity {
        "error" => 0,
        "warning" => 1,
        "info" => 2,
        _ => 3,
    }
}

fn dates_within_days(d1: &str, d2: &str, max_days: i32) -> bool {
    // Simple date proximity check: compare YYYY-MM-DD strings
    // Parse as (year, month, day) and compute approximate difference
    let parse = |d: &str| -> Option<(i32, i32, i32)> {
        let parts: Vec<&str> = d.split('-').collect();
        if parts.len() != 3 { return None; }
        let y = parts[0].parse::<i32>().ok()?;
        let m = parts[1].parse::<i32>().ok()?;
        let d = parts[2].parse::<i32>().ok()?;
        Some((y, m, d))
    };

    let Some((y1, m1, day1)) = parse(d1) else { return false };
    let Some((y2, m2, day2)) = parse(d2) else { return false };

    // Approximate day difference (good enough for duplicate detection)
    let days1 = y1 * 365 + m1 * 30 + day1;
    let days2 = y2 * 365 + m2 * 30 + day2;
    (days1 - days2).abs() <= max_days
}

fn issues_to_json(issues: &[Issue]) -> String {
    let mut json = String::from("{\"issues\":[");
    for (i, issue) in issues.iter().enumerate() {
        if i > 0 { json.push(','); }
        json.push_str(&format!(
            "{{\"severity\":\"{}\",\"category\":\"{}\",\"description\":\"{}\",\"transaction_date\":\"{}\",\"amount\":\"{}\",\"suggestion\":\"{}\"}}",
            escape_json(&issue.severity),
            escape_json(&issue.category),
            escape_json(&issue.description),
            escape_json(&issue.transaction_date),
            escape_json(&issue.amount),
            escape_json(&issue.suggestion),
        ));
    }
    json.push_str("],");
    json.push_str(&format!(
        "\"total\":{},\"errors\":{},\"warnings\":{},\"info\":{}",
        issues.len(),
        issues.iter().filter(|i| i.severity == "error").count(),
        issues.iter().filter(|i| i.severity == "warning").count(),
        issues.iter().filter(|i| i.severity == "info").count(),
    ));
    json.push('}');
    json
}

fn parse_issues_json(json: &str) -> Vec<Issue> {
    let objects = extract_json_array_objects(json, "issues");
    objects
        .iter()
        .map(|obj| Issue {
            severity: extract_json_string(obj, "severity").unwrap_or_default(),
            category: extract_json_string(obj, "category").unwrap_or_default(),
            description: extract_json_string(obj, "description").unwrap_or_default(),
            transaction_date: extract_json_string(obj, "transaction_date").unwrap_or_default(),
            amount: extract_json_string(obj, "amount").unwrap_or_default(),
            suggestion: extract_json_string(obj, "suggestion").unwrap_or_default(),
        })
        .collect()
}

fn escape_json(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}

// --- JSON helpers ---

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

fn extract_json_array_objects(json: &str, key: &str) -> Vec<String> {
    let pattern = format!("\"{}\"", key);
    let Some(idx) = json.find(&pattern) else { return vec![]; };
    let after_key = &json[idx + pattern.len()..];
    let Some(after_colon) = after_key.trim_start().strip_prefix(':') else { return vec![]; };
    let after_colon = after_colon.trim_start();
    if !after_colon.starts_with('[') { return vec![]; }

    let mut depth = 0i32;
    let mut in_string = false;
    let mut prev = '\0';
    let mut end = 0;
    for (i, c) in after_colon.char_indices() {
        if in_string { if c == '"' && prev != '\\' { in_string = false; } }
        else {
            match c {
                '"' => in_string = true,
                '[' => depth += 1,
                ']' => { depth -= 1; if depth == 0 { end = i + 1; break; } }
                _ => {}
            }
        }
        prev = c;
    }

    extract_array_objects(&after_colon[..end])
}

fn extract_array_objects(json: &str) -> Vec<String> {
    let trimmed = json.trim();
    if !trimmed.starts_with('[') || !trimmed.ends_with(']') { return vec![]; }
    let inner = &trimmed[1..trimmed.len() - 1];
    let mut objects = Vec::new();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut prev = '\0';
    let mut start = None;
    for (i, c) in inner.char_indices() {
        if in_string { if c == '"' && prev != '\\' { in_string = false; } }
        else {
            match c {
                '"' => in_string = true,
                '{' => { if depth == 0 { start = Some(i); } depth += 1; }
                '}' => { depth -= 1; if depth == 0 { if let Some(s) = start.take() { objects.push(inner[s..i+1].to_string()); } } }
                _ => {}
            }
        }
        prev = c;
    }
    objects
}

fn find_unescaped_quote(s: &str) -> Option<usize> {
    let mut prev = '\0';
    for (i, c) in s.char_indices() {
        if c == '"' && prev != '\\' { return Some(i); }
        prev = c;
    }
    None
}
