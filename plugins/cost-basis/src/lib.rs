wit_bindgen::generate!({
    world: "handler",
    path: "../../wit",
});

use dledger::plugin::ledger_read;
use dledger::plugin::logging;
use dledger::plugin::plugin_storage;
use dledger::plugin::types::*;

struct CostBasis;

const KEY_BASE_CURRENCY: &str = "base_currency";

impl exports::dledger::plugin::metadata::Guest for CostBasis {
    fn get_metadata() -> PluginMetadata {
        PluginMetadata {
            name: "Cost Basis Calculator".to_string(),
            version: "0.1.0".to_string(),
            description: "Compute FIFO cost basis and realized gains/losses for crypto assets"
                .to_string(),
            author: "dledger".to_string(),
        }
    }
}

impl exports::dledger::plugin::handler_ops::Guest for CostBasis {
    fn config_schema() -> Vec<ConfigField> {
        vec![ConfigField {
            key: KEY_BASE_CURRENCY.into(),
            label: "Base Currency".into(),
            field_type: "select".into(),
            required: true,
            default_value: "EUR".into(),
            description: "Fiat currency used for cost basis calculation".into(),
            options: "EUR,USD,GBP".into(),
        }]
    }

    fn configure(config: Vec<(String, String)>) -> Result<(), String> {
        let base = config
            .iter()
            .find(|(k, _)| k == KEY_BASE_CURRENCY)
            .map(|(_, v)| v.clone())
            .unwrap_or_default();

        if base.is_empty() {
            return Err("base_currency is required".into());
        }

        for (key, value) in &config {
            plugin_storage::set(key, value)
                .map_err(|e| format!("Storage error: {e:?}"))?;
        }

        Ok(())
    }

    /// Process: compute cost basis from ledger data.
    /// Params JSON: { "from_date": "YYYY-MM-DD", "to_date": "YYYY-MM-DD" }
    /// Returns JSON: { "assets": [...], "total_gain_loss": "...", "total_cost_basis": "...", "total_proceeds": "..." }
    fn process(params: String) -> Result<String, String> {
        logging::info("Computing cost basis report");

        let base_currency = plugin_storage::get(KEY_BASE_CURRENCY)
            .map_err(|e| format!("Storage error: {e:?}"))?
            .unwrap_or_else(|| "EUR".to_string());

        let (from_date, to_date) = parse_date_range(&params)?;

        // Get all accounts
        let accounts = ledger_read::list_accounts()
            .map_err(|e| format!("Failed to list accounts: {e:?}"))?;

        // Find asset accounts that hold crypto (non-base-currency)
        let crypto_accounts: Vec<&AccountInfo> = accounts
            .iter()
            .filter(|a| {
                a.account_type == "asset"
                    && a.is_postable
                    && (a.full_name.contains("Crypto") || a.full_name.contains("Exchange"))
            })
            .collect();

        // Query all transactions in the period
        let mut transactions = ledger_read::query_transactions(&QueryParams {
            limit: 10000,
            offset: 0,
            account_filter: String::new(),
            from_date: from_date.clone(),
            to_date: to_date.clone(),
        })
        .map_err(|e| format!("Failed to query transactions: {e:?}"))?;

        // Sort by date to ensure FIFO lots are built in chronological order
        transactions.sort_by(|a, b| a.date.cmp(&b.date));

        // Build FIFO lots per (account, currency)
        let mut lot_tracker = LotTracker::new();

        for tx in &transactions {
            for posting in &tx.postings {
                // Only track crypto postings (non-base-currency) to asset accounts
                if posting.amount.currency == base_currency {
                    continue;
                }

                let is_crypto_account = crypto_accounts
                    .iter()
                    .any(|a| a.id == posting.account);

                if !is_crypto_account {
                    continue;
                }

                let amount = parse_decimal(&posting.amount.amount);
                if amount == 0.0 {
                    continue;
                }

                // Try to get exchange rate for cost basis
                let rate = get_rate_for_tx(
                    tx,
                    &posting.amount.currency,
                    &base_currency,
                    &tx.date,
                );

                if amount > 0.0 {
                    // Acquisition: add lot
                    lot_tracker.add_lot(
                        &posting.account,
                        &posting.amount.currency,
                        amount,
                        rate,
                        &tx.date,
                    );
                } else {
                    // Disposal: consume lots FIFO
                    lot_tracker.dispose(
                        &posting.account,
                        &posting.amount.currency,
                        -amount,
                        rate,
                        &tx.date,
                    );
                }
            }
        }

        // Build result
        let report = lot_tracker.build_report(&base_currency);
        logging::info(&format!(
            "Cost basis report: {} assets, total gain/loss: {}",
            report.assets.len(),
            format_decimal(report.total_gain_loss)
        ));

        Ok(report.to_json())
    }

    /// Generate CSV report.
    fn generate_report(format: String, params: String) -> Result<Vec<u8>, String> {
        let json_result = Self::process(params)?;
        let report = CostBasisReport::from_json(&json_result)?;

        match format.as_str() {
            "json" => Ok(json_result.into_bytes()),
            "csv" => {
                let mut csv = String::new();
                csv.push_str("Asset,Acquired Date,Disposed Date,Quantity,Cost Basis,Proceeds,Gain/Loss\n");
                for asset in &report.assets {
                    for disposal in &asset.disposals {
                        csv.push_str(&format!(
                            "{},{},{},{},{},{},{}\n",
                            asset.currency,
                            disposal.acquired_date,
                            disposal.disposed_date,
                            format_decimal(disposal.quantity),
                            format_decimal(disposal.cost_basis),
                            format_decimal(disposal.proceeds),
                            format_decimal(disposal.gain_loss),
                        ));
                    }
                }
                Ok(csv.into_bytes())
            }
            other => Err(format!("Unsupported format: {other}")),
        }
    }
}

export!(CostBasis);

// --- Internal types ---

struct LotTracker {
    /// (account_id, currency) -> Vec<Lot>
    lots: Vec<(String, String, Vec<FifoLot>)>,
    disposals: Vec<DisposalRecord>,
}

struct FifoLot {
    date: String,
    remaining: f64,
    cost_per_unit: f64, // in base currency
}

struct DisposalRecord {
    currency: String,
    acquired_date: String,
    disposed_date: String,
    quantity: f64,
    cost_basis: f64,
    proceeds: f64,
    gain_loss: f64,
}

impl LotTracker {
    fn new() -> Self {
        Self {
            lots: Vec::new(),
            disposals: Vec::new(),
        }
    }

    fn get_lots(&mut self, account: &str, currency: &str) -> &mut Vec<FifoLot> {
        let idx = self.lots.iter().position(|(a, c, _)| a == account && c == currency);
        match idx {
            Some(i) => &mut self.lots[i].2,
            None => {
                self.lots.push((account.to_string(), currency.to_string(), Vec::new()));
                let len = self.lots.len();
                &mut self.lots[len - 1].2
            }
        }
    }

    fn add_lot(&mut self, account: &str, currency: &str, quantity: f64, cost_per_unit: f64, date: &str) {
        let lots = self.get_lots(account, currency);
        lots.push(FifoLot {
            date: date.to_string(),
            remaining: quantity,
            cost_per_unit,
        });
    }

    fn dispose(&mut self, account: &str, currency: &str, quantity: f64, proceeds_per_unit: f64, date: &str) {
        let lots = self.get_lots(account, currency);
        let mut remaining = quantity;

        // Collect disposal records from lot consumption first
        let mut new_disposals = Vec::new();

        for lot in lots.iter_mut() {
            if remaining <= 0.0 {
                break;
            }
            if lot.remaining <= 0.0 {
                continue;
            }

            let consumed = if lot.remaining >= remaining {
                remaining
            } else {
                lot.remaining
            };

            lot.remaining -= consumed;
            remaining -= consumed;

            let cost_basis = consumed * lot.cost_per_unit;
            let proceeds = consumed * proceeds_per_unit;

            new_disposals.push(DisposalRecord {
                currency: currency.to_string(),
                acquired_date: lot.date.clone(),
                disposed_date: date.to_string(),
                quantity: consumed,
                cost_basis,
                proceeds,
                gain_loss: proceeds - cost_basis,
            });
        }

        self.disposals.extend(new_disposals);

        // If remaining > 0, we disposed more than we have lots for
        // (e.g., pre-existing holdings before tracking started)
        if remaining > 0.0 {
            let proceeds = remaining * proceeds_per_unit;
            self.disposals.push(DisposalRecord {
                currency: currency.to_string(),
                acquired_date: "unknown".to_string(),
                disposed_date: date.to_string(),
                quantity: remaining,
                cost_basis: 0.0,
                proceeds,
                gain_loss: proceeds,
            });
        }
    }

    fn build_report(&self, base_currency: &str) -> CostBasisReport {
        // Group disposals by currency
        let mut asset_map: Vec<(String, Vec<&DisposalRecord>)> = Vec::new();

        for d in &self.disposals {
            let idx = asset_map.iter().position(|(c, _)| *c == d.currency);
            match idx {
                Some(i) => asset_map[i].1.push(d),
                None => asset_map.push((d.currency.clone(), vec![d])),
            }
        }

        let mut total_gain_loss = 0.0;
        let mut total_cost_basis = 0.0;
        let mut total_proceeds = 0.0;

        let assets: Vec<AssetReport> = asset_map
            .iter()
            .map(|(currency, disposals)| {
                let asset_disposals: Vec<DisposalEntry> = disposals
                    .iter()
                    .map(|d| {
                        total_gain_loss += d.gain_loss;
                        total_cost_basis += d.cost_basis;
                        total_proceeds += d.proceeds;
                        DisposalEntry {
                            acquired_date: d.acquired_date.clone(),
                            disposed_date: d.disposed_date.clone(),
                            quantity: d.quantity,
                            cost_basis: d.cost_basis,
                            proceeds: d.proceeds,
                            gain_loss: d.gain_loss,
                        }
                    })
                    .collect();

                let asset_gain: f64 = asset_disposals.iter().map(|d| d.gain_loss).sum();

                AssetReport {
                    currency: currency.clone(),
                    disposals: asset_disposals,
                    total_gain_loss: asset_gain,
                }
            })
            .collect();

        // Remaining holdings (open lots)
        let mut holdings = Vec::new();
        for (_, currency, lots) in &self.lots {
            let remaining: f64 = lots.iter().map(|l| l.remaining).sum();
            if remaining > 0.001 {
                let cost: f64 = lots
                    .iter()
                    .filter(|l| l.remaining > 0.0)
                    .map(|l| l.remaining * l.cost_per_unit)
                    .sum();
                holdings.push(HoldingEntry {
                    currency: currency.clone(),
                    quantity: remaining,
                    total_cost_basis: cost,
                });
            }
        }

        CostBasisReport {
            base_currency: base_currency.to_string(),
            assets,
            holdings,
            total_gain_loss,
            total_cost_basis,
            total_proceeds,
        }
    }
}

// --- Report types ---

struct CostBasisReport {
    base_currency: String,
    assets: Vec<AssetReport>,
    holdings: Vec<HoldingEntry>,
    total_gain_loss: f64,
    total_cost_basis: f64,
    total_proceeds: f64,
}

struct AssetReport {
    currency: String,
    disposals: Vec<DisposalEntry>,
    total_gain_loss: f64,
}

struct DisposalEntry {
    acquired_date: String,
    disposed_date: String,
    quantity: f64,
    cost_basis: f64,
    proceeds: f64,
    gain_loss: f64,
}

struct HoldingEntry {
    currency: String,
    quantity: f64,
    total_cost_basis: f64,
}

impl CostBasisReport {
    fn to_json(&self) -> String {
        let mut json = String::from("{");
        json.push_str(&format!("\"base_currency\":\"{}\",", self.base_currency));
        json.push_str(&format!("\"total_gain_loss\":\"{}\",", format_decimal(self.total_gain_loss)));
        json.push_str(&format!("\"total_cost_basis\":\"{}\",", format_decimal(self.total_cost_basis)));
        json.push_str(&format!("\"total_proceeds\":\"{}\",", format_decimal(self.total_proceeds)));

        // Assets
        json.push_str("\"assets\":[");
        for (i, asset) in self.assets.iter().enumerate() {
            if i > 0 { json.push(','); }
            json.push_str(&format!("{{\"currency\":\"{}\",\"total_gain_loss\":\"{}\",\"disposals\":[",
                asset.currency, format_decimal(asset.total_gain_loss)));
            for (j, d) in asset.disposals.iter().enumerate() {
                if j > 0 { json.push(','); }
                json.push_str(&format!(
                    "{{\"acquired_date\":\"{}\",\"disposed_date\":\"{}\",\"quantity\":\"{}\",\"cost_basis\":\"{}\",\"proceeds\":\"{}\",\"gain_loss\":\"{}\"}}",
                    d.acquired_date, d.disposed_date,
                    format_decimal(d.quantity), format_decimal(d.cost_basis),
                    format_decimal(d.proceeds), format_decimal(d.gain_loss)
                ));
            }
            json.push_str("]}");
        }
        json.push_str("],");

        // Holdings
        json.push_str("\"holdings\":[");
        for (i, h) in self.holdings.iter().enumerate() {
            if i > 0 { json.push(','); }
            json.push_str(&format!(
                "{{\"currency\":\"{}\",\"quantity\":\"{}\",\"total_cost_basis\":\"{}\"}}",
                h.currency, format_decimal(h.quantity), format_decimal(h.total_cost_basis)
            ));
        }
        json.push_str("]");

        json.push('}');
        json
    }

    fn from_json(json: &str) -> Result<Self, String> {
        // Minimal parse for report generation
        let total_gl = extract_json_string(json, "total_gain_loss")
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0);
        let total_cb = extract_json_string(json, "total_cost_basis")
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0);
        let total_pr = extract_json_string(json, "total_proceeds")
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0);
        let base = extract_json_string(json, "base_currency").unwrap_or_else(|| "EUR".into());

        // Parse assets array for CSV generation
        let assets_json = extract_json_array_objects(json, "assets");
        let mut assets = Vec::new();
        for asset_json in &assets_json {
            let currency = extract_json_string(asset_json, "currency").unwrap_or_default();
            let agl = extract_json_string(asset_json, "total_gain_loss")
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.0);

            let disposal_jsons = extract_json_array_objects(asset_json, "disposals");
            let mut disposals = Vec::new();
            for dj in &disposal_jsons {
                disposals.push(DisposalEntry {
                    acquired_date: extract_json_string(dj, "acquired_date").unwrap_or_default(),
                    disposed_date: extract_json_string(dj, "disposed_date").unwrap_or_default(),
                    quantity: extract_json_string(dj, "quantity").and_then(|s| s.parse().ok()).unwrap_or(0.0),
                    cost_basis: extract_json_string(dj, "cost_basis").and_then(|s| s.parse().ok()).unwrap_or(0.0),
                    proceeds: extract_json_string(dj, "proceeds").and_then(|s| s.parse().ok()).unwrap_or(0.0),
                    gain_loss: extract_json_string(dj, "gain_loss").and_then(|s| s.parse().ok()).unwrap_or(0.0),
                });
            }

            assets.push(AssetReport { currency, disposals, total_gain_loss: agl });
        }

        Ok(CostBasisReport {
            base_currency: base,
            assets,
            holdings: vec![],
            total_gain_loss: total_gl,
            total_cost_basis: total_cb,
            total_proceeds: total_pr,
        })
    }
}

// --- Helpers ---

fn parse_date_range(params: &str) -> Result<(String, String), String> {
    let from = extract_json_string(params, "from_date").unwrap_or_else(|| "2000-01-01".into());
    let to = extract_json_string(params, "to_date").unwrap_or_else(|| "2099-12-31".into());
    Ok((from, to))
}

fn parse_decimal(s: &str) -> f64 {
    s.trim().parse::<f64>().unwrap_or(0.0)
}

fn format_decimal(v: f64) -> String {
    if v == 0.0 {
        "0.00".to_string()
    } else {
        format!("{:.2}", v)
    }
}

/// Try to derive an exchange rate from the transaction's postings.
/// If a transaction has both a crypto posting and a fiat posting, we can compute the rate.
fn get_rate_for_tx(
    tx: &Transaction,
    crypto_currency: &str,
    base_currency: &str,
    date: &str,
) -> f64 {
    // Look for a fiat amount in the same transaction
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

    // Try the host's exchange rate
    if let Ok(Some(rate_str)) = ledger_read::get_exchange_rate(crypto_currency, base_currency, date) {
        if let Ok(rate) = rate_str.parse::<f64>() {
            return rate;
        }
    }

    0.0
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
