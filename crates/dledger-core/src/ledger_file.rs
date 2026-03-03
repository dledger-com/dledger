use std::collections::HashMap;
use std::str::FromStr;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ledger::LedgerEngine;
use crate::models::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LedgerFormat {
    Ledger,
    Beancount,
    Hledger,
}

impl LedgerFormat {
    pub fn from_str_opt(s: &str) -> Option<Self> {
        match s {
            "ledger" => Some(Self::Ledger),
            "beancount" => Some(Self::Beancount),
            "hledger" => Some(Self::Hledger),
            _ => None,
        }
    }
}

/// Auto-detect the format of a ledger file by scoring the first ~50 non-empty, non-comment lines.
pub fn detect_format(content: &str) -> LedgerFormat {
    let mut bc: i32 = 0;
    let mut hl: i32 = 0;
    let mut scanned = 0;

    for raw_line in content.lines() {
        if scanned >= 50 {
            break;
        }
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        scanned += 1;

        // Beancount signals
        if is_date_then_word(line, "txn") {
            bc += 5;
        }
        if line.starts_with("option \"") || line.starts_with("plugin \"") {
            bc += 5;
        }
        if is_date_then_quoted(line) {
            bc += 3;
        }
        if is_date_then_directive(line) {
            bc += 2;
        }

        // hledger signals
        if is_slash_date(line) {
            hl += 3;
        }
        if line.starts_with("account ") {
            hl += 5;
        }
        if line.starts_with("commodity ") {
            hl += 3;
        }
        // Inline balance assertion in posting
        if raw_line.starts_with(' ') || raw_line.starts_with('\t') {
            if line.contains(" = ") || line.contains(" == ") {
                hl += 5;
            }
        }
    }

    if bc > hl && bc >= 3 {
        LedgerFormat::Beancount
    } else if hl > bc && hl >= 3 {
        LedgerFormat::Hledger
    } else {
        LedgerFormat::Ledger
    }
}

fn is_date_then_word(line: &str, word: &str) -> bool {
    if line.len() < 12 {
        return false;
    }
    let after = &line[10..].trim_start();
    after.starts_with(word) && after[word.len()..].starts_with(|c: char| c.is_whitespace() || c == '"')
}

fn is_date_then_quoted(line: &str) -> bool {
    if line.len() < 14 {
        return false;
    }
    let after = line[10..].trim_start();
    // After date + optional status marker
    let rest = if after.starts_with("* ") || after.starts_with("! ") {
        after[2..].trim_start()
    } else {
        after
    };
    rest.starts_with('"')
}

fn is_date_then_directive(line: &str) -> bool {
    if line.len() < 14 {
        return false;
    }
    let after = line[10..].trim_start();
    after.starts_with("open ") || after.starts_with("close ") || after.starts_with("balance ")
}

fn is_slash_date(line: &str) -> bool {
    line.len() >= 10 && line.as_bytes()[4] == b'/' && line.as_bytes()[7] == b'/'
        && line[..4].chars().all(|c| c.is_ascii_digit())
        && line[5..7].chars().all(|c| c.is_ascii_digit())
        && line[8..10].chars().all(|c| c.is_ascii_digit())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LedgerImportResult {
    pub accounts_created: usize,
    pub currencies_created: usize,
    pub transactions_imported: usize,
    pub prices_imported: usize,
    pub warnings: Vec<String>,
    #[serde(default)]
    pub duplicates_skipped: usize,
    /// Unique (currency, date) pairs from imported transactions for historical rate backfill.
    #[serde(default)]
    pub transaction_currency_dates: Vec<(String, String)>,
}

/// Import a ledger file into the engine, auto-detecting format if not specified.
pub fn import_ledger(engine: &LedgerEngine, content: &str) -> Result<LedgerImportResult, String> {
    import_ledger_with_format(engine, content, None)
}

/// Import a ledger file with explicit format.
pub fn import_ledger_with_format(
    engine: &LedgerEngine,
    content: &str,
    format: Option<LedgerFormat>,
) -> Result<LedgerImportResult, String> {
    let fmt = format.unwrap_or_else(|| detect_format(content));
    import_ledger_internal(engine, content, fmt)
}

fn import_ledger_internal(
    engine: &LedgerEngine,
    content: &str,
    fmt: LedgerFormat,
) -> Result<LedgerImportResult, String> {
    let mut result = LedgerImportResult {
        accounts_created: 0,
        currencies_created: 0,
        transactions_imported: 0,
        prices_imported: 0,
        warnings: Vec::new(),
        duplicates_skipped: 0,
        transaction_currency_dates: Vec::new(),
    };


    let lines: Vec<&str> = content.lines().collect();
    let mut i = 0;
    let mut in_block_comment = false;
    let mut default_commodity: Option<String> = None;

    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();

        // hledger: block comments
        if fmt == LedgerFormat::Hledger {
            if in_block_comment {
                if trimmed == "end comment" {
                    in_block_comment = false;
                }
                i += 1;
                continue;
            }
            if trimmed == "comment" {
                in_block_comment = true;
                i += 1;
                continue;
            }
        }

        // Skip empty lines and comments
        if trimmed.is_empty() || trimmed.starts_with(';') || trimmed.starts_with('#') {
            i += 1;
            continue;
        }

        // pushtag / poptag — skip silently
        if trimmed.starts_with("pushtag") || trimmed.starts_with("poptag") {
            i += 1;
            continue;
        }

        // Beancount: skip option, plugin, note, document, event, custom, include directives
        if fmt == LedgerFormat::Beancount {
            if trimmed.starts_with("option ") || trimmed.starts_with("plugin ")
                || trimmed.starts_with("note ") || trimmed.starts_with("document ")
                || trimmed.starts_with("event ") || trimmed.starts_with("custom ")
                || trimmed.starts_with("include ")
            {
                i += 1;
                continue;
            }
        }

        // ledger: `commodity` directive sets default commodity
        if fmt == LedgerFormat::Ledger && trimmed.starts_with("commodity ") {
            let code = trimmed[10..].trim().split_whitespace().next().unwrap_or("");
            if !code.is_empty() && default_commodity.is_none() {
                default_commodity = Some(code.to_string());
            }
            i += 1;
            continue;
        }

        // hledger: skip include, commodity directives
        if fmt == LedgerFormat::Hledger {
            if trimmed.starts_with("include ") || trimmed.starts_with("commodity ") {
                i += 1;
                continue;
            }
        }

        // hledger: `account` directive (no date prefix)
        if fmt == LedgerFormat::Hledger && trimmed.starts_with("account ") {
            let account_name = trimmed[8..].trim().split_whitespace().next().unwrap_or("");
            if !account_name.is_empty() {
                let fallback_date = NaiveDate::from_ymd_opt(1970, 1, 1).unwrap();
                ensure_account(engine, account_name, vec![], fallback_date, &mut result)?;
            }
            i += 1;
            continue;
        }

        // Price directive: P YYYY-MM-DD COMMODITY AMOUNT COMMODITY
        if trimmed.starts_with("P ") {
            parse_price_directive(engine, trimmed, &mut result, i + 1, fmt)?;
            i += 1;
            continue;
        }

        // Lines starting with a date
        if let Some(date) = try_parse_date_prefix(trimmed) {
            let rest = trimmed[10..].trim();

            if let Some(stripped) = rest.strip_prefix("open ") {
                parse_open_directive(engine, date, stripped.trim(), &mut result, i + 1)?;
                i += 1;
                continue;
            }

            if let Some(stripped) = rest.strip_prefix("close ") {
                parse_close_directive(engine, stripped.trim(), &mut result, i + 1)?;
                i += 1;
                continue;
            }

            if let Some(stripped) = rest.strip_prefix("balance") {
                let bal_rest = stripped.trim();
                parse_balance_directive(engine, date, bal_rest, &mut result, i + 1)?;
                i += 1;
                continue;
            }

            if rest.starts_with("pad ") {
                result.warnings.push(format!("line {}: pad directive skipped", i + 1));
                i += 1;
                continue;
            }

            // Beancount: skip date-prefixed note, document, event, custom directives
            if fmt == LedgerFormat::Beancount {
                if rest.starts_with("note ") || rest.starts_with("document ")
                    || rest.starts_with("event ") || rest.starts_with("custom ")
                {
                    i += 1;
                    continue;
                }
            }

            // Transaction block
            let (consumed, _) =
                parse_transaction(engine, date, rest, &lines, i, &mut result, fmt, &mut default_commodity)?;
            i += consumed;
            continue;
        }

        // Unknown line — skip
        i += 1;
    }

    Ok(result)
}

/// Export all ledger data as a beancount-like text file (dledger format).
pub fn export_ledger(engine: &LedgerEngine) -> Result<String, String> {
    export_ledger_with_format(engine, LedgerFormat::Ledger)
}

/// Export all ledger data in the specified format.
pub fn export_ledger_with_format(engine: &LedgerEngine, format: LedgerFormat) -> Result<String, String> {
    let mut out = String::new();
    out.push_str("; Generated by dLedger\n\n");

    let accounts = engine.list_accounts().map_err(|e| e.to_string())?;
    let mut sorted_accounts = accounts.clone();
    sorted_accounts.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.full_name.cmp(&b.full_name)));

    // Account declarations
    for acc in &sorted_accounts {
        if format == LedgerFormat::Hledger {
            out.push_str(&format!("account {}\n", acc.full_name));
        } else {
            let commodities = if acc.allowed_currencies.is_empty() {
                String::new()
            } else {
                format!("  {}", acc.allowed_currencies.join(","))
            };
            out.push_str(&format!(
                "{} open {}{}\n",
                acc.created_at.format("%Y-%m-%d"),
                acc.full_name,
                commodities,
            ));
        }
    }
    out.push('\n');

    // Transactions sorted by date
    let entries = engine
        .query_journal_entries(&TransactionFilter::default())
        .map_err(|e| e.to_string())?;

    let mut sorted_entries = entries;
    sorted_entries.sort_by(|a, b| a.0.date.cmp(&b.0.date));

    for (entry, items) in &sorted_entries {
        if entry.status == JournalEntryStatus::Voided {
            continue;
        }
        let status_marker = match entry.status {
            JournalEntryStatus::Confirmed => " *",
            JournalEntryStatus::Pending => " !",
            JournalEntryStatus::Voided => unreachable!(),
        };
        if format == LedgerFormat::Beancount {
            out.push_str(&format!(
                "{}{} \"{}\"\n",
                entry.date.format("%Y-%m-%d"),
                status_marker,
                entry.description,
            ));
        } else {
            out.push_str(&format!(
                "{}{} {}\n",
                entry.date.format("%Y-%m-%d"),
                status_marker,
                entry.description,
            ));
        }
        for item in items {
            let acc_name = accounts
                .iter()
                .find(|a| a.id == item.account_id)
                .map(|a| a.full_name.as_str())
                .unwrap_or("Unknown");
            out.push_str(&format!(
                "  {}  {} {}\n",
                acc_name, item.amount, item.currency,
            ));
        }
        out.push('\n');
    }

    // Exchange rates
    let rates = engine.list_exchange_rates(None, None).map_err(|e| e.to_string())?;
    let mut sorted_rates = rates;
    sorted_rates.sort_by(|a, b| a.date.cmp(&b.date));
    for rate in &sorted_rates {
        out.push_str(&format!(
            "P {} {} {} {}\n",
            rate.date.format("%Y-%m-%d"),
            rate.from_currency,
            rate.rate,
            rate.to_currency,
        ));
    }

    Ok(out)
}

// ---------------------------------------------------------------------------
// Internal parsing helpers
// ---------------------------------------------------------------------------

fn try_parse_date_prefix(s: &str) -> Option<NaiveDate> {
    if s.len() < 10 {
        return None;
    }
    // Try YYYY-MM-DD first, then YYYY/MM/DD
    NaiveDate::parse_from_str(&s[..10], "%Y-%m-%d")
        .or_else(|_| NaiveDate::parse_from_str(&s[..10], "%Y/%m/%d"))
        .ok()
}

fn infer_account_type(full_name: &str) -> Result<AccountType, String> {
    let first = full_name.split(':').next().unwrap_or("");
    match first {
        "Assets" => Ok(AccountType::Asset),
        "Liabilities" => Ok(AccountType::Liability),
        "Equity" => Ok(AccountType::Equity),
        "Income" => Ok(AccountType::Revenue),
        "Expenses" => Ok(AccountType::Expense),
        // Also accept singular forms
        "Asset" => Ok(AccountType::Asset),
        "Liability" => Ok(AccountType::Liability),
        "Revenue" => Ok(AccountType::Revenue),
        "Expense" => Ok(AccountType::Expense),
        // Exchange accounts (used for multi-currency)
        "Exchange" => Ok(AccountType::Equity),
        _ => Err(format!("cannot infer account type from '{full_name}'")),
    }
}

fn ensure_currency(
    engine: &LedgerEngine,
    code: &str,
    result: &mut LedgerImportResult,
) -> Result<(), String> {
    let existing = engine.get_currency(code).map_err(|e| e.to_string())?;
    if existing.is_none() {
        let currency = Currency {
            code: code.to_string(),
            asset_type: String::new(),
            param: String::new(),
            name: code.to_string(),
            decimal_places: if code.len() <= 3 { 2 } else { 8 },
            is_base: false,
        };
        engine.create_currency(&currency).map_err(|e| e.to_string())?;
        result.currencies_created += 1;
    }
    Ok(())
}

fn ensure_account(
    engine: &LedgerEngine,
    full_name: &str,
    allowed_currencies: Vec<String>,
    date: NaiveDate,
    result: &mut LedgerImportResult,
) -> Result<Uuid, String> {
    // Check if account already exists
    if let Some(acc) = engine
        .storage()
        .get_account_by_full_name(full_name)
        .map_err(|e| e.to_string())?
    {
        return Ok(acc.id);
    }

    let account_type = infer_account_type(full_name)?;

    // Ensure parent accounts exist by walking up the path
    let parts: Vec<&str> = full_name.split(':').collect();
    let mut parent_id: Option<Uuid> = None;

    for depth in 1..parts.len() {
        let ancestor_name = parts[..depth].join(":");
        if let Some(acc) = engine
            .storage()
            .get_account_by_full_name(&ancestor_name)
            .map_err(|e| e.to_string())?
        {
            parent_id = Some(acc.id);
        } else {
            let id = Uuid::now_v7();
            let name = parts[depth - 1].to_string();
            let acc = Account {
                id,
                parent_id,
                account_type,
                name,
                full_name: ancestor_name,
                allowed_currencies: vec![],
                is_postable: true,
                is_archived: false,
                created_at: date,
                opened_at: None,
            };
            engine.create_account(&acc).map_err(|e| e.to_string())?;
            result.accounts_created += 1;
            parent_id = Some(id);
        }
    }

    // Create the leaf account
    let id = Uuid::now_v7();
    let name = parts.last().unwrap().to_string();
    let acc = Account {
        id,
        parent_id,
        account_type,
        name,
        full_name: full_name.to_string(),
        allowed_currencies,
        is_postable: true,
        is_archived: false,
        created_at: date,
        opened_at: None,
    };
    engine.create_account(&acc).map_err(|e| e.to_string())?;
    result.accounts_created += 1;
    Ok(id)
}

fn parse_open_directive(
    engine: &LedgerEngine,
    date: NaiveDate,
    rest: &str,
    result: &mut LedgerImportResult,
    _line_num: usize,
) -> Result<(), String> {
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    if tokens.is_empty() {
        return Err(format!("line {}: open directive missing account name", _line_num));
    }
    let account_name = tokens[0];
    let allowed: Vec<String> = tokens[1..]
        .iter()
        .map(|s| s.trim_end_matches(',').to_string())
        .collect();

    // Auto-create currencies mentioned in allowed list
    for code in &allowed {
        ensure_currency(engine, code, result)?;
    }

    ensure_account(engine, account_name, allowed, date, result)?;
    Ok(())
}

fn parse_close_directive(
    engine: &LedgerEngine,
    rest: &str,
    result: &mut LedgerImportResult,
    _line_num: usize,
) -> Result<(), String> {
    let account_name = rest.split_whitespace().next()
        .ok_or_else(|| format!("line {}: close directive missing account name", _line_num))?;

    if let Some(acc) = engine
        .storage()
        .get_account_by_full_name(account_name)
        .map_err(|e| e.to_string())?
    {
        engine.archive_account(&acc.id).map_err(|e| e.to_string())?;
    } else {
        result.warnings.push(format!(
            "line {}: close directive for unknown account '{}'",
            _line_num, account_name
        ));
    }
    Ok(())
}

fn parse_balance_directive(
    engine: &LedgerEngine,
    date: NaiveDate,
    rest: &str,
    result: &mut LedgerImportResult,
    line_num: usize,
) -> Result<(), String> {
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    if tokens.len() < 3 {
        return Err(format!(
            "line {}: balance directive needs ACCOUNT AMOUNT COMMODITY",
            line_num
        ));
    }
    let account_name = tokens[0];
    let amount = Decimal::from_str(tokens[1])
        .map_err(|e| format!("line {}: bad amount '{}': {}", line_num, tokens[1], e))?;
    let commodity = tokens[2];

    ensure_currency(engine, commodity, result)?;
    let account_id = ensure_account(engine, account_name, vec![], date, result)?;

    let assertion = BalanceAssertion {
        id: Uuid::now_v7(),
        account_id,
        date,
        currency: commodity.to_string(),
        currency_asset_type: String::new(),
        currency_param: String::new(),
        expected_balance: amount,
        is_passing: false,
        actual_balance: None,
        is_strict: false,
        include_subaccounts: false,
    };
    let passing = engine
        .check_balance_assertion(&assertion)
        .map_err(|e| e.to_string())?;
    if !passing {
        result.warnings.push(format!(
            "line {}: balance assertion failed for {} {} {} (expected {})",
            line_num, account_name, commodity, date, amount
        ));
    }
    Ok(())
}

fn parse_price_directive(
    engine: &LedgerEngine,
    line: &str,
    result: &mut LedgerImportResult,
    line_num: usize,
    _fmt: LedgerFormat,
) -> Result<(), String> {
    // P YYYY-MM-DD COMMODITY AMOUNT COMMODITY (also accepts YYYY/MM/DD)
    let tokens: Vec<&str> = line.split_whitespace().collect();
    if tokens.len() < 5 {
        return Err(format!("line {}: malformed price directive", line_num));
    }
    let date = NaiveDate::parse_from_str(tokens[1], "%Y-%m-%d")
        .or_else(|_| NaiveDate::parse_from_str(tokens[1], "%Y/%m/%d"))
        .map_err(|e| format!("line {}: bad date '{}': {}", line_num, tokens[1], e))?;
    let from_commodity = tokens[2];
    let rate = Decimal::from_str(tokens[3])
        .map_err(|e| format!("line {}: bad rate '{}': {}", line_num, tokens[3], e))?;
    let to_commodity = tokens[4];

    ensure_currency(engine, from_commodity, result)?;
    ensure_currency(engine, to_commodity, result)?;

    let er = ExchangeRate {
        id: Uuid::now_v7(),
        date,
        from_currency: from_commodity.to_string(),
        from_currency_asset_type: String::new(),
        from_currency_param: String::new(),
        to_currency: to_commodity.to_string(),
        to_currency_asset_type: String::new(),
        to_currency_param: String::new(),
        rate,
        source: "ledger-file".to_string(),
    };
    engine
        .record_exchange_rate(&er)
        .map_err(|e| e.to_string())?;
    result.prices_imported += 1;
    Ok(())
}

struct ParsedPosting {
    account_name: String,
    amount: Option<Decimal>,
    commodity: Option<String>,
    cost_price: Option<(Decimal, String)>,
}

fn parse_transaction(
    engine: &LedgerEngine,
    date: NaiveDate,
    header_rest: &str,
    lines: &[&str],
    start_idx: usize,
    result: &mut LedgerImportResult,
    fmt: LedgerFormat,
    default_commodity: &mut Option<String>,
) -> Result<(usize, ()), String> {
    // Parse header: [txn|*|!] [(CODE)] [PAYEE |] DESCRIPTION
    let mut rest = header_rest;
    let status = if rest.starts_with("txn ") || rest.starts_with("txn\t") || rest == "txn" {
        rest = if rest.len() > 3 { rest[3..].trim_start() } else { "" };
        JournalEntryStatus::Confirmed
    } else if rest.starts_with("* ") || rest.starts_with("*\t") {
        rest = rest[2..].trim_start();
        JournalEntryStatus::Confirmed
    } else if rest.starts_with("! ") || rest.starts_with("!\t") {
        rest = rest[2..].trim_start();
        JournalEntryStatus::Pending
    } else {
        JournalEntryStatus::Confirmed
    };

    // Handle (CODE)
    if rest.starts_with('(') {
        if let Some(end) = rest.find(')') {
            let code = &rest[1..end];
            let after = rest[end + 1..].trim_start();
            rest = after;
            // Prepend code to description
            if !rest.is_empty() {
                let mut description = format!("({}) {}", code, rest);
                // Beancount: strip quotes from description
                if fmt == LedgerFormat::Beancount {
                    description = strip_beancount_quotes(&description);
                }
                return parse_transaction_body(
                    engine, date, status, &description, lines, start_idx, result, default_commodity,
                );
            }
        }
    }

    let mut description = rest.to_string();
    // Beancount: strip quotes from description
    if fmt == LedgerFormat::Beancount {
        description = strip_beancount_quotes(&description);
    }
    parse_transaction_body(engine, date, status, &description, lines, start_idx, result, default_commodity)
}

fn strip_beancount_quotes(s: &str) -> String {
    let s = s.trim();
    if s.starts_with('"') {
        if let Some(end) = s[1..].find('"') {
            return s[1..end + 1].to_string();
        }
    }
    s.to_string()
}

fn parse_transaction_body(
    engine: &LedgerEngine,
    date: NaiveDate,
    status: JournalEntryStatus,
    description: &str,
    lines: &[&str],
    start_idx: usize,
    result: &mut LedgerImportResult,
    default_commodity: &mut Option<String>,
) -> Result<(usize, ()), String> {
    // Collect posting lines (indented lines following the header)
    let mut postings: Vec<ParsedPosting> = Vec::new();
    let mut i = start_idx + 1;

    while i < lines.len() {
        let line = lines[i];
        // Posting lines must start with whitespace
        if !line.starts_with(' ') && !line.starts_with('\t') {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        // Skip comment-only posting lines
        if trimmed.starts_with(';') || trimmed.starts_with('#') {
            i += 1;
            continue;
        }
        // Skip "tags ..." lines silently
        if trimmed.starts_with("tags ") {
            i += 1;
            continue;
        }

        // Strip inline comments
        let without_comment = if let Some(pos) = trimmed.find(';') {
            trimmed[..pos].trim()
        } else {
            trimmed
        };

        if without_comment.is_empty() {
            i += 1;
            continue;
        }

        // Parse posting: ACCOUNT [AMOUNT COMMODITY [@ PRICE COMMODITY]]
        // or: ACCOUNT BOOK COMMODITY (skip with warning)
        let posting = parse_posting_line(without_comment, i + 1, result, default_commodity)?;
        if let Some(p) = posting {
            postings.push(p);
        }
        i += 1;
    }

    let consumed = i - start_idx;

    if postings.is_empty() {
        result.warnings.push(format!(
            "line {}: transaction '{}' has no postings, skipped",
            start_idx + 1, description
        ));
        return Ok((consumed, ()));
    }

    // Handle elided amounts
    let elided_count = postings.iter().filter(|p| p.amount.is_none()).count();
    if elided_count > 1 {
        return Err(format!(
            "line {}: transaction has {} postings with elided amounts (max 1)",
            start_idx + 1, elided_count
        ));
    }

    // Compute elided amount if needed
    if elided_count == 1 {
        // Sum amounts by currency for all non-elided postings.
        // When a posting has `@ PRICE COMMODITY`, the posting's own commodity
        // is considered self-balancing (beancount cost conversion), and instead
        // the cost total (amount * price) in the cost commodity is used for balancing.
        let mut sums: HashMap<String, Decimal> = HashMap::new();
        for p in postings.iter().filter(|p| p.amount.is_some()) {
            let commodity = p.commodity.as_deref().unwrap();
            if let Some((price, cost_commodity)) = &p.cost_price {
                // Cost conversion: the primary commodity balances to zero,
                // and the cost total goes into the cost commodity.
                let cost_total = p.amount.unwrap() * price;
                *sums.entry(cost_commodity.clone()).or_default() += cost_total;
            } else {
                *sums.entry(commodity.to_string()).or_default() += p.amount.unwrap();
            }
        }

        // Collect unbalanced currencies
        let unbalanced: Vec<(String, Decimal)> = sums
            .into_iter()
            .filter(|(_, sum)| !sum.is_zero())
            .collect();

        if unbalanced.is_empty() {
            return Err(format!(
                "line {}: cannot auto-balance: all currencies already balance",
                start_idx + 1
            ));
        } else if unbalanced.len() == 1 {
            let (commodity, sum) = unbalanced.into_iter().next().unwrap();
            let elided = postings.iter_mut().find(|p| p.amount.is_none()).unwrap();
            elided.amount = Some(-sum);
            elided.commodity = Some(commodity);
        } else {
            // Multi-currency: expand the single elided posting into one posting
            // per unbalanced currency, all going to the same account.
            let elided_idx = postings.iter().position(|p| p.amount.is_none()).unwrap();
            let elided_account = postings[elided_idx].account_name.clone();
            postings.remove(elided_idx);

            for (commodity, sum) in unbalanced {
                postings.push(ParsedPosting {
                    account_name: elided_account.clone(),
                    amount: Some(-sum),
                    commodity: Some(commodity),
                    cost_price: None,
                });
            }
        }
    }

    // Ensure all accounts and currencies exist, then build line items.
    // Postings with `@ PRICE COMMODITY` need Equity:Trading accounts to
    // balance both currencies (same convention as crypto source plugins).
    let entry_id = Uuid::now_v7();
    let mut items: Vec<LineItem> = Vec::new();
    let mut cost_prices: Vec<(Uuid, String, String)> = Vec::new();

    for p in &postings {
        let amount = p.amount.unwrap();
        let commodity = p.commodity.as_deref().unwrap();

        ensure_currency(engine, commodity, result)?;
        let account_id = ensure_account(engine, &p.account_name, vec![], date, result)?;

        items.push(LineItem {
            id: Uuid::now_v7(),
            journal_entry_id: entry_id,
            account_id,
            currency: commodity.to_string(),
            currency_asset_type: String::new(),
            currency_param: String::new(),
            amount,
            lot_id: None,
        });

        if let Some((price, price_commodity)) = &p.cost_price {
            // Create Equity:Trading entries to balance both currencies.
            // E.g. for `30 AAPL @ 185.40 USD`:
            //   Equity:Trading:AAPL  -30 AAPL     (balances AAPL)
            //   Equity:Trading:AAPL  +5562 USD     (cost total into USD)
            ensure_currency(engine, price_commodity, result)?;
            let trading_account_name = format!("Equity:Trading:{}", commodity);
            let trading_id =
                ensure_account(engine, &trading_account_name, vec![], date, result)?;

            // Balance the primary commodity
            items.push(LineItem {
                id: Uuid::now_v7(),
                journal_entry_id: entry_id,
                account_id: trading_id,
                currency: commodity.to_string(),
                currency_asset_type: String::new(),
                currency_param: String::new(),
                amount: -amount,
                lot_id: None,
            });

            // Add the cost total in the cost commodity
            let cost_total = amount * price;
            items.push(LineItem {
                id: Uuid::now_v7(),
                journal_entry_id: entry_id,
                account_id: trading_id,
                currency: price_commodity.to_string(),
                currency_asset_type: String::new(),
                currency_param: String::new(),
                amount: cost_total,
                lot_id: None,
            });

            cost_prices.push((
                entry_id,
                "cost_price".to_string(),
                format!("{} {}", price, price_commodity),
            ));

            // Record implied exchange rate from cost syntax
            let trade_rate = ExchangeRate {
                id: Uuid::now_v7(),
                date,
                from_currency: commodity.to_string(),
                from_currency_asset_type: String::new(),
                from_currency_param: String::new(),
                to_currency: price_commodity.to_string(),
                to_currency_asset_type: String::new(),
                to_currency_param: String::new(),
                rate: *price,
                source: "transaction".to_string(),
            };
            let _ = engine.record_exchange_rate(&trade_rate);
        }
    }

    // Post the journal entry
    let entry = JournalEntry {
        id: entry_id,
        date,
        description: description.to_string(),
        status,
        source: "ledger-file".to_string(),
        voided_by: None,
        created_at: date,
    };

    engine
        .post_journal_entry(&entry, &items)
        .map_err(|e| format!("line {}: {}", start_idx + 1, e))?;
    result.transactions_imported += 1;

    // Collect unique (currency, date) pairs for historical rate backfill
    let date_str = date.format("%Y-%m-%d").to_string();
    for item in &items {
        let pair = (item.currency.clone(), date_str.clone());
        if !result.transaction_currency_dates.contains(&pair) {
            result.transaction_currency_dates.push(pair);
        }
    }

    // Store cost price metadata
    for (eid, key, value) in &cost_prices {
        let _ = engine.add_metadata(eid, key, value);
    }

    Ok((consumed, ()))
}

fn parse_posting_line(
    line: &str,
    line_num: usize,
    result: &mut LedgerImportResult,
    default_commodity: &mut Option<String>,
) -> Result<Option<ParsedPosting>, String> {
    // Tokenize carefully: account name can contain hyphens and special chars
    // The account is the first whitespace-separated token(s) before a numeric amount or end of line
    // Strategy: split on 2+ whitespace to separate account from amount+commodity

    // Try splitting on double-space or tab as separator between account and amount
    let (account, rest) = split_account_amount(line);

    if rest.is_empty() {
        // Elided amount
        return Ok(Some(ParsedPosting {
            account_name: account.to_string(),
            amount: None,
            commodity: None,
            cost_price: None,
        }));
    }

    let tokens: Vec<&str> = rest.split_whitespace().collect();
    if tokens.is_empty() {
        return Ok(Some(ParsedPosting {
            account_name: account.to_string(),
            amount: None,
            commodity: None,
            cost_price: None,
        }));
    }

    // Check for BOOK COMMODITY pattern
    if tokens.len() >= 2 && tokens[0] == "BOOK" {
        result.warnings.push(format!(
            "line {}: BOOK {} posting skipped",
            line_num, tokens[1]
        ));
        return Ok(None);
    }

    // Parse amount
    let amount_str = tokens[0];
    let amount = Decimal::from_str(amount_str).map_err(|e| {
        format!("line {}: bad amount '{}': {}", line_num, amount_str, e)
    })?;

    let commodity = if tokens.len() >= 2 {
        let c = tokens[1].to_string();
        if default_commodity.is_none() {
            *default_commodity = Some(c.clone());
        }
        c
    } else if let Some(ref dc) = default_commodity {
        dc.clone()
    } else {
        return Err(format!(
            "line {}: posting has amount but no commodity",
            line_num
        ));
    };

    // Check for @ PRICE COMMODITY
    let cost_price = if tokens.len() >= 5 && tokens[2] == "@" {
        let price = Decimal::from_str(tokens[3]).map_err(|e| {
            format!("line {}: bad cost price '{}': {}", line_num, tokens[3], e)
        })?;
        Some((price, tokens[4].to_string()))
    } else {
        None
    };

    Ok(Some(ParsedPosting {
        account_name: account.to_string(),
        amount: Some(amount),
        commodity: Some(commodity),
        cost_price,
    }))
}

/// Split a posting line into (account_name, rest).
/// Account names are separated from amounts by 2+ spaces or tab.
fn split_account_amount(line: &str) -> (&str, &str) {
    // Find the first occurrence of two consecutive spaces or a tab after the account name
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\t' {
            return (line[..i].trim(), line[i..].trim());
        }
        if i + 1 < bytes.len() && bytes[i] == b' ' && bytes[i + 1] == b' ' {
            return (line[..i].trim(), line[i..].trim());
        }
        i += 1;
    }
    // Fallback: single space before a number/sign (for beancount single-space postings)
    // Account names contain colons and never start with digits, so we look for
    // a non-whitespace token followed by whitespace and a numeric amount.
    if let Some(pos) = line.find(|c: char| c == ' ' || c == '\t') {
        let rest = line[pos..].trim_start();
        if rest.starts_with(|c: char| c.is_ascii_digit() || c == '-' || c == '+') {
            return (line[..pos].trim(), rest);
        }
    }
    // No separator found — entire line is account name (elided amount)
    (line.trim(), "")
}
