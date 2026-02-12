wit_bindgen::generate!({
    world: "handler",
    path: "../../wit",
});

use dledger::plugin::ledger_read;
use dledger::plugin::logging;
use dledger::plugin::plugin_storage;
use dledger::plugin::types::*;

struct TaxReportFr;

const KEY_BASE_CURRENCY: &str = "base_currency";
const KEY_FISCAL_YEAR: &str = "fiscal_year";

impl exports::dledger::plugin::metadata::Guest for TaxReportFr {
    fn get_metadata() -> PluginMetadata {
        PluginMetadata {
            name: "French Tax Report".to_string(),
            version: "0.1.0".to_string(),
            description: "Generate Formulaire 2086 (crypto capital gains) and 3916-bis (foreign platform accounts) for French tax filing".to_string(),
            author: "dledger".to_string(),
        }
    }
}

impl exports::dledger::plugin::handler_ops::Guest for TaxReportFr {
    fn config_schema() -> Vec<ConfigField> {
        vec![
            ConfigField {
                key: KEY_BASE_CURRENCY.into(),
                label: "Base Currency".into(),
                field_type: "select".into(),
                required: true,
                default_value: "EUR".into(),
                description: "Must be EUR for French tax reporting".into(),
                options: "EUR".into(),
            },
            ConfigField {
                key: KEY_FISCAL_YEAR.into(),
                label: "Fiscal Year".into(),
                field_type: "string".into(),
                required: true,
                default_value: "2025".into(),
                description: "Tax year to generate report for (e.g. 2025)".into(),
                options: String::new(),
            },
        ]
    }

    fn configure(config: Vec<(String, String)>) -> Result<(), String> {
        let fiscal_year = config
            .iter()
            .find(|(k, _)| k == KEY_FISCAL_YEAR)
            .map(|(_, v)| v.clone())
            .unwrap_or_default();

        if fiscal_year.is_empty() || fiscal_year.parse::<u32>().is_err() {
            return Err("fiscal_year must be a valid year (e.g. 2025)".into());
        }

        for (key, value) in &config {
            plugin_storage::set(key, value)
                .map_err(|e| format!("Storage error: {e:?}"))?;
        }

        Ok(())
    }

    /// Process: compute French tax data for the fiscal year.
    /// Uses the global portfolio fraction method (prix moyen pondéré d'acquisition global)
    /// as required by French tax law for crypto assets (Article 150 VH bis CGI).
    ///
    /// Formula per cession:
    ///   Plus-value = Prix de cession - (Prix total d'acquisition × Prix de cession / Valeur globale du portefeuille)
    fn process(params: String) -> Result<String, String> {
        logging::info("Generating French tax report (Formulaire 2086)");

        let base_currency = plugin_storage::get(KEY_BASE_CURRENCY)
            .map_err(|e| format!("Storage error: {e:?}"))?
            .unwrap_or_else(|| "EUR".to_string());

        if base_currency != "EUR" {
            return Err("French tax report requires EUR as base currency".into());
        }

        let fiscal_year = plugin_storage::get(KEY_FISCAL_YEAR)
            .map_err(|e| format!("Storage error: {e:?}"))?
            .unwrap_or_else(|| "2025".into());

        let year: u32 = fiscal_year.parse().map_err(|_| "Invalid fiscal year")?;
        let from_date = format!("{}-01-01", year);
        let to_date = format!("{}-12-31", year);

        // Override from params if provided
        let from = extract_json_string(&params, "from_date").unwrap_or(from_date);
        let to = extract_json_string(&params, "to_date").unwrap_or(to_date);

        let accounts = ledger_read::list_accounts()
            .map_err(|e| format!("Failed to list accounts: {e:?}"))?;

        // Get ALL transactions (not just fiscal year) to compute total acquisition cost
        let mut all_transactions = ledger_read::query_transactions(&QueryParams {
            limit: 10000,
            offset: 0,
            account_filter: String::new(),
            from_date: "2000-01-01".into(),
            to_date: to.clone(),
        })
        .map_err(|e| format!("Failed to query transactions: {e:?}"))?;

        // Sort by date to ensure acquisitions are processed before disposals
        all_transactions.sort_by(|a, b| a.date.cmp(&b.date));

        // Identify crypto asset accounts
        let crypto_accounts: Vec<&AccountInfo> = accounts
            .iter()
            .filter(|a| {
                a.account_type == "asset"
                    && a.is_postable
                    && (a.full_name.contains("Crypto") || a.full_name.contains("Exchange"))
            })
            .collect();

        // Track total acquisition cost and portfolio value
        let mut total_acquisition_cost = 0.0_f64; // Prix total d'acquisition
        let mut cessions: Vec<Cession> = Vec::new();

        // Track holdings: (currency, quantity, total_cost_in_eur)
        let mut holdings: Vec<(String, f64, f64)> = Vec::new();

        for tx in &all_transactions {
            for posting in &tx.postings {
                if posting.amount.currency == base_currency {
                    continue;
                }

                let is_crypto = crypto_accounts.iter().any(|a| a.id == posting.account);
                if !is_crypto {
                    continue;
                }

                let amount = parse_decimal(&posting.amount.amount);
                if amount == 0.0 {
                    continue;
                }

                let rate = get_rate_for_tx(tx, &posting.amount.currency, &base_currency);

                if amount > 0.0 {
                    // Acquisition
                    let cost_eur = amount * rate;
                    total_acquisition_cost += cost_eur;

                    // Update holdings
                    let idx = holdings.iter().position(|(c, _, _)| *c == posting.amount.currency);
                    match idx {
                        Some(i) => {
                            holdings[i].1 += amount;
                            holdings[i].2 += cost_eur;
                        }
                        None => {
                            holdings.push((posting.amount.currency.clone(), amount, cost_eur));
                        }
                    }
                } else {
                    // Disposal (cession)
                    let disposed_qty = -amount;
                    let cession_price_eur = disposed_qty * rate; // Prix de cession

                    // Compute portfolio value at time of cession
                    let portfolio_value = compute_portfolio_value(&holdings, &base_currency, &tx.date);

                    // French formula: fraction = cession_price / portfolio_value
                    // taxable = cession_price - (total_acquisition_cost * fraction)
                    let (plus_value, fraction) = if portfolio_value > 0.0 {
                        let frac = cession_price_eur / portfolio_value;
                        let pv = cession_price_eur - (total_acquisition_cost * frac);
                        (pv, frac)
                    } else {
                        (cession_price_eur, 1.0)
                    };

                    // Only record cessions in the fiscal year
                    if tx.date >= from && tx.date <= to {
                        cessions.push(Cession {
                            date: tx.date.clone(),
                            asset: posting.amount.currency.clone(),
                            quantity: disposed_qty,
                            cession_price: cession_price_eur,
                            portfolio_value,
                            total_acquisition_cost,
                            fraction,
                            plus_value,
                        });
                    }

                    // Update holdings
                    let idx = holdings.iter().position(|(c, _, _)| *c == posting.amount.currency);
                    if let Some(i) = idx {
                        holdings[i].1 -= disposed_qty;
                        // Reduce acquisition cost proportionally
                        total_acquisition_cost -= total_acquisition_cost * fraction;
                        holdings[i].2 -= holdings[i].2 * (disposed_qty / (holdings[i].1 + disposed_qty));
                    }
                }
            }
        }

        let total_plus_value: f64 = cessions.iter().map(|c| c.plus_value).sum();
        let total_cession_price: f64 = cessions.iter().map(|c| c.cession_price).sum();
        let total_minus_value: f64 = cessions
            .iter()
            .filter(|c| c.plus_value < 0.0)
            .map(|c| c.plus_value)
            .sum();
        let total_gains: f64 = cessions
            .iter()
            .filter(|c| c.plus_value > 0.0)
            .map(|c| c.plus_value)
            .sum();

        // Build 3916-bis data: exchange accounts used during fiscal year
        let exchange_accounts: Vec<&AccountInfo> = accounts
            .iter()
            .filter(|a| a.full_name.contains("Exchange") && a.account_type == "asset")
            .collect();

        let report = TaxReport2086 {
            fiscal_year: year,
            cessions,
            total_plus_value,
            total_cession_price,
            total_gains,
            total_losses: total_minus_value,
            net_taxable: if total_plus_value > 0.0 { total_plus_value } else { 0.0 },
            exchange_accounts: exchange_accounts
                .iter()
                .map(|a| ExchangeAccountInfo {
                    platform_name: extract_platform_from_account(&a.full_name),
                    account_identifier: a.full_name.clone(),
                })
                .collect(),
        };

        logging::info(&format!(
            "Tax report: {} cessions, net taxable: {:.2} EUR",
            report.cessions.len(),
            report.net_taxable
        ));

        Ok(report.to_json())
    }

    fn generate_report(format: String, params: String) -> Result<Vec<u8>, String> {
        let json_result = Self::process(params)?;
        let report = TaxReport2086::from_json(&json_result)?;

        match format.as_str() {
            "json" => Ok(json_result.into_bytes()),
            "csv" => {
                let mut csv = String::new();
                csv.push_str("Date,Asset,Quantity,Cession Price (EUR),Portfolio Value (EUR),Acquisition Cost (EUR),Fraction,Plus/Minus Value (EUR)\n");
                for c in &report.cessions {
                    csv.push_str(&format!(
                        "{},{},{},{:.2},{:.2},{:.2},{:.6},{:.2}\n",
                        c.date, c.asset, format_decimal(c.quantity),
                        c.cession_price, c.portfolio_value,
                        c.total_acquisition_cost, c.fraction, c.plus_value,
                    ));
                }
                csv.push_str(&format!(
                    "\nTotal Cession Price,{:.2}\nTotal Plus-Values,{:.2}\nTotal Minus-Values,{:.2}\nNet Taxable,{:.2}\n",
                    report.total_cession_price, report.total_gains, report.total_losses, report.net_taxable,
                ));
                Ok(csv.into_bytes())
            }
            other => Err(format!("Unsupported format: {other}")),
        }
    }
}

export!(TaxReportFr);

// --- Internal types ---

struct Cession {
    date: String,
    asset: String,
    quantity: f64,
    cession_price: f64,        // Prix de cession (EUR)
    portfolio_value: f64,       // Valeur globale du portefeuille (EUR)
    total_acquisition_cost: f64, // Prix total d'acquisition at time of cession (EUR)
    fraction: f64,              // Prix de cession / Valeur globale
    plus_value: f64,            // Plus or minus value (EUR)
}

struct ExchangeAccountInfo {
    platform_name: String,
    account_identifier: String,
}

struct TaxReport2086 {
    fiscal_year: u32,
    cessions: Vec<Cession>,
    total_plus_value: f64,
    total_cession_price: f64,
    total_gains: f64,
    total_losses: f64,
    net_taxable: f64,
    exchange_accounts: Vec<ExchangeAccountInfo>,
}

impl TaxReport2086 {
    fn to_json(&self) -> String {
        let mut json = String::from("{");
        json.push_str(&format!("\"fiscal_year\":{},", self.fiscal_year));
        json.push_str(&format!("\"total_plus_value\":\"{:.2}\",", self.total_plus_value));
        json.push_str(&format!("\"total_cession_price\":\"{:.2}\",", self.total_cession_price));
        json.push_str(&format!("\"total_gains\":\"{:.2}\",", self.total_gains));
        json.push_str(&format!("\"total_losses\":\"{:.2}\",", self.total_losses));
        json.push_str(&format!("\"net_taxable\":\"{:.2}\",", self.net_taxable));

        json.push_str("\"cessions\":[");
        for (i, c) in self.cessions.iter().enumerate() {
            if i > 0 { json.push(','); }
            json.push_str(&format!(
                "{{\"date\":\"{}\",\"asset\":\"{}\",\"quantity\":\"{}\",\"cession_price\":\"{:.2}\",\"portfolio_value\":\"{:.2}\",\"total_acquisition_cost\":\"{:.2}\",\"fraction\":\"{:.6}\",\"plus_value\":\"{:.2}\"}}",
                c.date, c.asset, format_decimal(c.quantity),
                c.cession_price, c.portfolio_value,
                c.total_acquisition_cost, c.fraction, c.plus_value,
            ));
        }
        json.push_str("],");

        json.push_str("\"exchange_accounts\":[");
        for (i, ea) in self.exchange_accounts.iter().enumerate() {
            if i > 0 { json.push(','); }
            json.push_str(&format!(
                "{{\"platform_name\":\"{}\",\"account_identifier\":\"{}\"}}",
                escape_json(&ea.platform_name),
                escape_json(&ea.account_identifier),
            ));
        }
        json.push_str("]");

        json.push('}');
        json
    }

    fn from_json(json: &str) -> Result<Self, String> {
        let fiscal_year = extract_json_number(json, "fiscal_year").unwrap_or(2025.0) as u32;
        let total_pv = extract_json_string(json, "total_plus_value")
            .and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
        let total_cp = extract_json_string(json, "total_cession_price")
            .and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
        let total_g = extract_json_string(json, "total_gains")
            .and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
        let total_l = extract_json_string(json, "total_losses")
            .and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
        let net_t = extract_json_string(json, "net_taxable")
            .and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);

        let cession_jsons = extract_json_array_objects(json, "cessions");
        let cessions = cession_jsons.iter().map(|cj| {
            Cession {
                date: extract_json_string(cj, "date").unwrap_or_default(),
                asset: extract_json_string(cj, "asset").unwrap_or_default(),
                quantity: extract_json_string(cj, "quantity").and_then(|s| s.parse().ok()).unwrap_or(0.0),
                cession_price: extract_json_string(cj, "cession_price").and_then(|s| s.parse().ok()).unwrap_or(0.0),
                portfolio_value: extract_json_string(cj, "portfolio_value").and_then(|s| s.parse().ok()).unwrap_or(0.0),
                total_acquisition_cost: extract_json_string(cj, "total_acquisition_cost").and_then(|s| s.parse().ok()).unwrap_or(0.0),
                fraction: extract_json_string(cj, "fraction").and_then(|s| s.parse().ok()).unwrap_or(0.0),
                plus_value: extract_json_string(cj, "plus_value").and_then(|s| s.parse().ok()).unwrap_or(0.0),
            }
        }).collect();

        Ok(TaxReport2086 {
            fiscal_year,
            cessions,
            total_plus_value: total_pv,
            total_cession_price: total_cp,
            total_gains: total_g,
            total_losses: total_l,
            net_taxable: net_t,
            exchange_accounts: vec![],
        })
    }
}

// --- Helpers ---

fn parse_decimal(s: &str) -> f64 {
    s.trim().parse::<f64>().unwrap_or(0.0)
}

fn format_decimal(v: f64) -> String {
    if v == 0.0 {
        "0.00".to_string()
    } else if v.abs() < 0.01 {
        format!("{:.8}", v)
    } else {
        format!("{:.2}", v)
    }
}

fn get_rate_for_tx(tx: &Transaction, crypto_currency: &str, base_currency: &str) -> f64 {
    let crypto_total: f64 = tx
        .postings
        .iter()
        .filter(|p| p.amount.currency == crypto_currency)
        .map(|p| parse_decimal(&p.amount.amount).abs())
        .sum();

    let fiat_total: f64 = tx
        .postings
        .iter()
        .filter(|p| p.amount.currency == base_currency)
        .map(|p| parse_decimal(&p.amount.amount).abs())
        .sum();

    if crypto_total > 0.0 && fiat_total > 0.0 {
        return fiat_total / crypto_total;
    }

    if let Ok(Some(rate_str)) = ledger_read::get_exchange_rate(crypto_currency, base_currency, &tx.date) {
        if let Ok(rate) = rate_str.parse::<f64>() {
            return rate;
        }
    }

    0.0
}

fn compute_portfolio_value(holdings: &[(String, f64, f64)], base_currency: &str, date: &str) -> f64 {
    let mut total = 0.0;
    for (currency, qty, _cost) in holdings {
        if *qty <= 0.0 { continue; }
        // Try to get current market rate
        if let Ok(Some(rate_str)) = ledger_read::get_exchange_rate(currency, base_currency, date) {
            if let Ok(rate) = rate_str.parse::<f64>() {
                total += qty * rate;
                continue;
            }
        }
        // Fallback: use cost basis as approximation
        total += _cost;
    }
    total
}

fn extract_platform_from_account(full_name: &str) -> String {
    // "Assets:Exchange:Kraken:BTC" -> "Kraken"
    let parts: Vec<&str> = full_name.split(':').collect();
    if parts.len() >= 3 && parts[1] == "Exchange" {
        parts[2].to_string()
    } else {
        full_name.to_string()
    }
}

fn escape_json(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
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

fn extract_json_number(json: &str, key: &str) -> Option<f64> {
    let pattern = format!("\"{}\"", key);
    let idx = json.find(&pattern)?;
    let after_key = &json[idx + pattern.len()..];
    let after_colon = after_key.trim_start().strip_prefix(':')?.trim_start();
    // Parse number until non-digit
    let end = after_colon
        .find(|c: char| !c.is_ascii_digit() && c != '.' && c != '-')
        .unwrap_or(after_colon.len());
    after_colon[..end].parse().ok()
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
