use std::collections::HashSet;
use std::str::FromStr;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use dledger_core::models::*;
use dledger_core::LedgerEngine;

// ---- Chain definitions ----

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ChainInfo {
    pub chain_id: u64,
    pub name: &'static str,
    pub native_currency: &'static str,
    pub decimals: u8,
}

pub const SUPPORTED_CHAINS: &[ChainInfo] = &[
    ChainInfo { chain_id: 1,      name: "Ethereum",  native_currency: "ETH",  decimals: 18 },
    ChainInfo { chain_id: 10,     name: "Optimism",  native_currency: "ETH",  decimals: 18 },
    ChainInfo { chain_id: 42161,  name: "Arbitrum",  native_currency: "ETH",  decimals: 18 },
    ChainInfo { chain_id: 8453,   name: "Base",      native_currency: "ETH",  decimals: 18 },
    ChainInfo { chain_id: 59144,  name: "Linea",     native_currency: "ETH",  decimals: 18 },
    ChainInfo { chain_id: 534352, name: "Scroll",    native_currency: "ETH",  decimals: 18 },
    ChainInfo { chain_id: 324,    name: "ZkSync",    native_currency: "ETH",  decimals: 18 },
    ChainInfo { chain_id: 81457,  name: "Blast",     native_currency: "ETH",  decimals: 18 },
    ChainInfo { chain_id: 56,     name: "BSC",       native_currency: "BNB",  decimals: 18 },
    ChainInfo { chain_id: 137,    name: "Polygon",   native_currency: "POL",  decimals: 18 },
    ChainInfo { chain_id: 43114,  name: "Avalanche", native_currency: "AVAX", decimals: 18 },
    ChainInfo { chain_id: 250,    name: "Fantom",    native_currency: "FTM",  decimals: 18 },
    ChainInfo { chain_id: 100,    name: "Gnosis",    native_currency: "xDAI", decimals: 18 },
];

pub fn get_chain_info(chain_id: u64) -> Result<&'static ChainInfo, String> {
    SUPPORTED_CHAINS
        .iter()
        .find(|c| c.chain_id == chain_id)
        .ok_or_else(|| format!("unsupported chain_id: {chain_id}"))
}

// ---- Public types ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EtherscanAccount {
    pub address: String,
    pub chain_id: u64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EtherscanSyncResult {
    pub transactions_imported: usize,
    pub transactions_skipped: usize,
    pub accounts_created: usize,
    pub warnings: Vec<String>,
}

// ---- Managed state for tracked addresses ----

pub struct EtherscanState {
    conn: Mutex<Connection>,
}

impl EtherscanState {
    pub fn new(db_path: &str) -> Result<Self, String> {
        let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

        // Check if we need to migrate from old schema (address-only PK) to new (address, chain_id)
        let has_chain_id = {
            let mut stmt = conn
                .prepare("PRAGMA table_info(etherscan_account)")
                .map_err(|e| e.to_string())?;
            let cols: Vec<String> = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();

            if cols.is_empty() {
                // Table doesn't exist yet
                None
            } else {
                Some(cols.iter().any(|c| c == "chain_id"))
            }
        };

        match has_chain_id {
            None => {
                // Fresh install — create table with composite key
                conn.execute_batch(
                    "CREATE TABLE IF NOT EXISTS etherscan_account (
                        address  TEXT NOT NULL,
                        chain_id INTEGER NOT NULL DEFAULT 1,
                        label    TEXT NOT NULL,
                        PRIMARY KEY (address, chain_id)
                    )",
                )
                .map_err(|e| e.to_string())?;
            }
            Some(false) => {
                // Old table exists without chain_id — migrate
                conn.execute_batch(
                    "ALTER TABLE etherscan_account RENAME TO etherscan_account_old;
                     CREATE TABLE etherscan_account (
                         address  TEXT NOT NULL,
                         chain_id INTEGER NOT NULL DEFAULT 1,
                         label    TEXT NOT NULL,
                         PRIMARY KEY (address, chain_id)
                     );
                     INSERT INTO etherscan_account (address, chain_id, label)
                         SELECT address, 1, label FROM etherscan_account_old;
                     DROP TABLE etherscan_account_old;",
                )
                .map_err(|e| e.to_string())?;
            }
            Some(true) => {
                // Already has chain_id — nothing to do
            }
        }

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn list_accounts(&self) -> Result<Vec<EtherscanAccount>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT address, chain_id, label FROM etherscan_account ORDER BY label, chain_id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(EtherscanAccount {
                    address: row.get(0)?,
                    chain_id: row.get(1)?,
                    label: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn add_account(&self, address: &str, chain_id: u64, label: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO etherscan_account (address, chain_id, label) VALUES (?1, ?2, ?3)",
            params![address.to_lowercase(), chain_id, label],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn remove_account(&self, address: &str, chain_id: u64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM etherscan_account WHERE address = ?1 AND chain_id = ?2",
            params![address.to_lowercase(), chain_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

// ---- Etherscan API response types ----

#[derive(Deserialize)]
struct ApiResponse {
    status: String,
    message: String,
    result: serde_json::Value,
}

#[derive(Deserialize)]
struct NormalTx {
    hash: String,
    #[serde(rename = "timeStamp")]
    timestamp: String,
    from: String,
    to: String,
    value: String,
    #[serde(rename = "isError")]
    is_error: String,
    #[serde(rename = "gasUsed")]
    gas_used: String,
    #[serde(rename = "gasPrice")]
    gas_price: String,
}

#[derive(Deserialize)]
struct InternalTx {
    hash: String,
    #[serde(rename = "timeStamp")]
    timestamp: String,
    from: String,
    to: String,
    value: String,
    #[serde(rename = "isError")]
    is_error: String,
    #[serde(rename = "traceId")]
    trace_id: String,
}

// ---- Sync function ----

pub fn sync_etherscan(
    engine: &LedgerEngine,
    api_key: &str,
    address: &str,
    label: &str,
    chain_id: u64,
) -> Result<EtherscanSyncResult, String> {
    let chain = get_chain_info(chain_id)?;

    let mut result = EtherscanSyncResult {
        transactions_imported: 0,
        transactions_skipped: 0,
        accounts_created: 0,
        warnings: Vec::new(),
    };
    let address = address.to_lowercase();

    // 1. Ensure native currency exists
    ensure_currency(engine, chain.native_currency, chain.decimals, &mut result)?;

    // 2. Collect existing etherscan sources for dedup
    let existing = collect_existing_sources(engine, chain_id)?;

    // 3. Fetch normal transactions (paginated)
    let normal_json = fetch_paginated(api_key, &address, "txlist", chain_id)?;
    let normal_txns: Vec<NormalTx> =
        serde_json::from_value(normal_json).map_err(|e| format!("parse normal txns: {e}"))?;

    // 4. Fetch internal transactions (paginated)
    let internal_json = fetch_paginated(api_key, &address, "txlistinternal", chain_id)?;
    let internal_txns: Vec<InternalTx> =
        serde_json::from_value(internal_json).map_err(|e| format!("parse internal txns: {e}"))?;

    // 5. Process normal transactions
    for tx in &normal_txns {
        if tx.is_error == "1" {
            continue;
        }
        let source = format!("etherscan:{}:{}", chain_id, tx.hash);
        if existing.contains(&source) {
            result.transactions_skipped += 1;
            continue;
        }
        process_normal_tx(engine, tx, &address, label, &source, chain, &mut result)?;
    }

    // 6. Process internal transactions
    for tx in &internal_txns {
        if tx.is_error == "1" {
            continue;
        }
        let source = format!("etherscan:{}:int:{}:{}", chain_id, tx.hash, tx.trace_id);
        if existing.contains(&source) {
            result.transactions_skipped += 1;
            continue;
        }
        process_internal_tx(engine, tx, &address, label, &source, chain, &mut result)?;
    }

    Ok(result)
}

// ---- HTTP helpers ----

fn fetch_paginated(
    api_key: &str,
    address: &str,
    action: &str,
    chain_id: u64,
) -> Result<serde_json::Value, String> {
    let mut all_results: Vec<serde_json::Value> = Vec::new();
    let mut page = 1u32;

    loop {
        let url = format!(
            "https://api.etherscan.io/v2/api\
             ?chainid={chain_id}&module=account&action={action}\
             &address={address}&startblock=0&endblock=99999999\
             &page={page}&offset=10000&sort=asc&apikey={api_key}"
        );

        let mut resp = ureq::get(&url)
            .call()
            .map_err(|e| format!("Etherscan HTTP error: {e}"))?;

        let api_resp: ApiResponse = resp
            .body_mut()
            .read_json()
            .map_err(|e| format!("Etherscan JSON parse error: {e}"))?;

        if api_resp.status != "1" {
            // "0" with "No transactions found" is normal (empty result)
            if api_resp.message.contains("No transactions found")
                || api_resp.message == "No records found"
                || api_resp.message == "OK"
            {
                break;
            }
            return Err(format!("Etherscan API error: {}", api_resp.message));
        }

        if let Some(arr) = api_resp.result.as_array() {
            let count = arr.len();
            all_results.extend(arr.iter().cloned());
            if count < 10000 {
                break; // last page
            }
        } else {
            break;
        }

        page += 1;
        thread::sleep(Duration::from_millis(250));
    }

    Ok(serde_json::Value::Array(all_results))
}

// ---- Transaction processing ----

fn process_normal_tx(
    engine: &LedgerEngine,
    tx: &NormalTx,
    our_address: &str,
    label: &str,
    source: &str,
    chain: &ChainInfo,
    result: &mut EtherscanSyncResult,
) -> Result<(), String> {
    let date = timestamp_to_date(&tx.timestamp)?;
    let value = wei_to_native(&tx.value, chain.decimals)?;
    let gas_fee = calculate_gas_fee(&tx.gas_used, &tx.gas_price, chain.decimals)?;

    let from = tx.from.to_lowercase();
    let to = tx.to.to_lowercase();

    let chain_name = chain.name;
    let our_account = format!("Assets:{chain_name}:{label}");
    let entry_id = Uuid::now_v7();
    let mut items = Vec::new();

    if from == our_address && to == our_address {
        // Self-transfer: only gas
        if gas_fee.is_zero() {
            return Ok(());
        }
        let gas_acc_id = ensure_account(engine, &format!("Expenses:{chain_name}:Gas"), date, result)?;
        let our_acc_id = ensure_account(engine, &our_account, date, result)?;
        items.push(make_line_item(entry_id, gas_acc_id, gas_fee, chain.native_currency));
        items.push(make_line_item(entry_id, our_acc_id, -gas_fee, chain.native_currency));
    } else if to.is_empty() {
        // Contract creation
        if gas_fee.is_zero() {
            return Ok(());
        }
        let cc_acc_id =
            ensure_account(engine, &format!("Expenses:{chain_name}:ContractCreation"), date, result)?;
        let our_acc_id = ensure_account(engine, &our_account, date, result)?;
        items.push(make_line_item(entry_id, cc_acc_id, gas_fee, chain.native_currency));
        items.push(make_line_item(entry_id, our_acc_id, -gas_fee, chain.native_currency));
    } else if from == our_address {
        // Outgoing
        let counterparty = short_addr(&to);
        let ext_account = format!("Equity:{chain_name}:External:{counterparty}");
        let ext_acc_id = ensure_account(engine, &ext_account, date, result)?;
        let our_acc_id = ensure_account(engine, &our_account, date, result)?;

        if !value.is_zero() {
            items.push(make_line_item(entry_id, ext_acc_id, value, chain.native_currency));
        }
        if !gas_fee.is_zero() {
            let gas_acc_id =
                ensure_account(engine, &format!("Expenses:{chain_name}:Gas"), date, result)?;
            items.push(make_line_item(entry_id, gas_acc_id, gas_fee, chain.native_currency));
        }
        let total_out = value + gas_fee;
        if !total_out.is_zero() {
            items.push(make_line_item(entry_id, our_acc_id, -total_out, chain.native_currency));
        }
    } else if to == our_address {
        // Incoming
        if value.is_zero() {
            return Ok(());
        }
        let counterparty = short_addr(&from);
        let ext_account = format!("Equity:{chain_name}:External:{counterparty}");
        let ext_acc_id = ensure_account(engine, &ext_account, date, result)?;
        let our_acc_id = ensure_account(engine, &our_account, date, result)?;
        items.push(make_line_item(entry_id, our_acc_id, value, chain.native_currency));
        items.push(make_line_item(entry_id, ext_acc_id, -value, chain.native_currency));
    } else {
        return Ok(());
    }

    if items.is_empty() {
        return Ok(());
    }

    let description = format_tx_description(tx, our_address, chain);
    let entry = JournalEntry {
        id: entry_id,
        date,
        description,
        status: JournalEntryStatus::Confirmed,
        source: source.to_string(),
        voided_by: None,
        created_at: date,
    };

    engine
        .post_journal_entry(&entry, &items)
        .map_err(|e| format!("post tx {}: {e}", tx.hash))?;
    result.transactions_imported += 1;
    Ok(())
}

fn process_internal_tx(
    engine: &LedgerEngine,
    tx: &InternalTx,
    our_address: &str,
    label: &str,
    source: &str,
    chain: &ChainInfo,
    result: &mut EtherscanSyncResult,
) -> Result<(), String> {
    let date = timestamp_to_date(&tx.timestamp)?;
    let value = wei_to_native(&tx.value, chain.decimals)?;

    if value.is_zero() {
        return Ok(());
    }

    let from = tx.from.to_lowercase();
    let to = tx.to.to_lowercase();

    let chain_name = chain.name;
    let our_account = format!("Assets:{chain_name}:{label}");
    let entry_id = Uuid::now_v7();
    let mut items = Vec::new();

    if from == our_address && to == our_address {
        // Self-transfer internal: no net effect
        return Ok(());
    } else if from == our_address {
        // Outgoing internal
        let counterparty = short_addr(&to);
        let ext_account = format!("Equity:{chain_name}:External:{counterparty}");
        let ext_acc_id = ensure_account(engine, &ext_account, date, result)?;
        let our_acc_id = ensure_account(engine, &our_account, date, result)?;
        items.push(make_line_item(entry_id, ext_acc_id, value, chain.native_currency));
        items.push(make_line_item(entry_id, our_acc_id, -value, chain.native_currency));
    } else if to == our_address {
        // Incoming internal
        let counterparty = short_addr(&from);
        let ext_account = format!("Equity:{chain_name}:External:{counterparty}");
        let ext_acc_id = ensure_account(engine, &ext_account, date, result)?;
        let our_acc_id = ensure_account(engine, &our_account, date, result)?;
        items.push(make_line_item(entry_id, our_acc_id, value, chain.native_currency));
        items.push(make_line_item(entry_id, ext_acc_id, -value, chain.native_currency));
    } else {
        return Ok(());
    }

    let hash_short = if tx.hash.len() >= 10 {
        &tx.hash[..10]
    } else {
        &tx.hash
    };
    let currency = chain.native_currency;
    let description = format!("{currency} internal transfer ({hash_short})");
    let entry = JournalEntry {
        id: entry_id,
        date,
        description,
        status: JournalEntryStatus::Confirmed,
        source: source.to_string(),
        voided_by: None,
        created_at: date,
    };

    engine
        .post_journal_entry(&entry, &items)
        .map_err(|e| format!("post internal tx {}: {e}", tx.hash))?;
    result.transactions_imported += 1;
    Ok(())
}

// ---- Helpers ----

fn pow10(exp: u8) -> Decimal {
    let mut result = Decimal::ONE;
    let ten = Decimal::from(10);
    for _ in 0..exp {
        result *= ten;
    }
    result
}

fn wei_to_native(wei_str: &str, decimals: u8) -> Result<Decimal, String> {
    if wei_str.is_empty() || wei_str == "0" {
        return Ok(Decimal::ZERO);
    }
    let wei =
        Decimal::from_str(wei_str).map_err(|e| format!("bad wei value '{wei_str}': {e}"))?;
    let divisor = pow10(decimals);
    Ok(wei / divisor)
}

fn calculate_gas_fee(gas_used: &str, gas_price: &str, decimals: u8) -> Result<Decimal, String> {
    let used = Decimal::from_str(gas_used).unwrap_or(Decimal::ZERO);
    let price = Decimal::from_str(gas_price).unwrap_or(Decimal::ZERO);
    let wei_fee = used * price;
    if wei_fee.is_zero() {
        return Ok(Decimal::ZERO);
    }
    let divisor = pow10(decimals);
    Ok(wei_fee / divisor)
}

fn timestamp_to_date(ts: &str) -> Result<NaiveDate, String> {
    let secs: i64 = ts
        .parse()
        .map_err(|e| format!("bad timestamp '{ts}': {e}"))?;
    chrono::DateTime::from_timestamp(secs, 0)
        .map(|dt| dt.date_naive())
        .ok_or_else(|| format!("invalid timestamp: {ts}"))
}

fn short_addr(addr: &str) -> String {
    if addr.len() >= 10 {
        addr[..10].to_string()
    } else {
        addr.to_string()
    }
}

fn format_tx_description(tx: &NormalTx, our_address: &str, chain: &ChainInfo) -> String {
    let from = tx.from.to_lowercase();
    let to = tx.to.to_lowercase();
    let hash_short = if tx.hash.len() >= 10 {
        &tx.hash[..10]
    } else {
        &tx.hash
    };
    let currency = chain.native_currency;

    if from == our_address && to == our_address {
        format!("{currency} self-transfer ({hash_short})")
    } else if to.is_empty() {
        format!("{currency} contract creation ({hash_short})")
    } else if from == our_address {
        format!("{currency} sent to {} ({hash_short})", short_addr(&to))
    } else {
        format!("{currency} received from {} ({hash_short})", short_addr(&from))
    }
}

fn make_line_item(entry_id: Uuid, account_id: Uuid, amount: Decimal, currency: &str) -> LineItem {
    LineItem {
        id: Uuid::now_v7(),
        journal_entry_id: entry_id,
        account_id,
        currency: currency.to_string(),
        amount,
        lot_id: None,
    }
}

fn collect_existing_sources(engine: &LedgerEngine, chain_id: u64) -> Result<HashSet<String>, String> {
    let entries = engine
        .query_journal_entries(&TransactionFilter::default())
        .map_err(|e| e.to_string())?;

    let mut set: HashSet<String> = HashSet::new();
    for (e, _) in entries {
        if !e.source.starts_with("etherscan:") {
            continue;
        }
        set.insert(e.source.clone());

        // Backward compat: old sources like "etherscan:0x..." (no chain_id prefix)
        // When syncing chain_id=1, also match these legacy entries
        if chain_id == 1 && !e.source.starts_with("etherscan:1:") {
            // Check if it's an old-format source (etherscan:<hash> or etherscan:int:<hash>:<trace>)
            let rest = &e.source["etherscan:".len()..];
            if rest.starts_with("0x") {
                // Old normal tx: "etherscan:0xhash" → also insert "etherscan:1:0xhash"
                set.insert(format!("etherscan:1:{rest}"));
            } else if rest.starts_with("int:") {
                // Old internal tx: "etherscan:int:0xhash:trace" → also insert "etherscan:1:int:0xhash:trace"
                set.insert(format!("etherscan:1:{rest}"));
            }
        }
    }
    Ok(set)
}

fn ensure_currency(
    engine: &LedgerEngine,
    code: &str,
    decimal_places: u8,
    _result: &mut EtherscanSyncResult,
) -> Result<(), String> {
    let existing = engine.get_currency(code).map_err(|e| e.to_string())?;
    if existing.is_none() {
        let currency = Currency {
            code: code.to_string(),
            name: code.to_string(),
            decimal_places,
            is_base: false,
        };
        engine
            .create_currency(&currency)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn ensure_account(
    engine: &LedgerEngine,
    full_name: &str,
    date: NaiveDate,
    result: &mut EtherscanSyncResult,
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

    // Ensure parent accounts exist
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
            };
            engine
                .create_account(&acc)
                .map_err(|e| e.to_string())?;
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
        allowed_currencies: vec![],
        is_postable: true,
        is_archived: false,
        created_at: date,
    };
    engine
        .create_account(&acc)
        .map_err(|e| e.to_string())?;
    result.accounts_created += 1;
    Ok(id)
}

fn infer_account_type(full_name: &str) -> Result<AccountType, String> {
    let first = full_name.split(':').next().unwrap_or("");
    match first {
        "Assets" => Ok(AccountType::Asset),
        "Liabilities" => Ok(AccountType::Liability),
        "Equity" => Ok(AccountType::Equity),
        "Income" => Ok(AccountType::Revenue),
        "Expenses" => Ok(AccountType::Expense),
        _ => Err(format!("cannot infer account type from '{full_name}'")),
    }
}
