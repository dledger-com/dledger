use std::collections::{BTreeMap, HashSet};
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
    ChainInfo { chain_id: 1,      name: "Ethereum",         native_currency: "ETH",    decimals: 18 },
    ChainInfo { chain_id: 10,     name: "Optimism",         native_currency: "ETH",    decimals: 18 },
    ChainInfo { chain_id: 42161,  name: "Arbitrum",         native_currency: "ETH",    decimals: 18 },
    ChainInfo { chain_id: 8453,   name: "Base",             native_currency: "ETH",    decimals: 18 },
    ChainInfo { chain_id: 59144,  name: "Linea",            native_currency: "ETH",    decimals: 18 },
    ChainInfo { chain_id: 534352, name: "Scroll",           native_currency: "ETH",    decimals: 18 },
    ChainInfo { chain_id: 81457,  name: "Blast",            native_currency: "ETH",    decimals: 18 },
    ChainInfo { chain_id: 56,     name: "BSC",              native_currency: "BNB",    decimals: 18 },
    ChainInfo { chain_id: 137,    name: "Polygon",          native_currency: "POL",    decimals: 18 },
    ChainInfo { chain_id: 43114,  name: "Avalanche",        native_currency: "AVAX",   decimals: 18 },
    ChainInfo { chain_id: 100,    name: "Gnosis",           native_currency: "xDAI",   decimals: 18 },
    ChainInfo { chain_id: 50,     name: "XDC",              native_currency: "XDC",    decimals: 18 },
    ChainInfo { chain_id: 130,    name: "Unichain",         native_currency: "ETH",    decimals: 18 },
    ChainInfo { chain_id: 143,    name: "Monad",            native_currency: "MON",    decimals: 18 },
    ChainInfo { chain_id: 146,    name: "Sonic",            native_currency: "S",      decimals: 18 },
    ChainInfo { chain_id: 199,    name: "BitTorrent Chain", native_currency: "BTT",    decimals: 18 },
    ChainInfo { chain_id: 204,    name: "opBNB",            native_currency: "BNB",    decimals: 18 },
    ChainInfo { chain_id: 252,    name: "Fraxtal",          native_currency: "frxETH", decimals: 18 },
    ChainInfo { chain_id: 480,    name: "World",            native_currency: "ETH",    decimals: 18 },
    ChainInfo { chain_id: 988,    name: "Stable",           native_currency: "STABLE", decimals: 18 },
    ChainInfo { chain_id: 999,    name: "HyperEVM",         native_currency: "HYPE",   decimals: 18 },
    ChainInfo { chain_id: 1284,   name: "Moonbeam",         native_currency: "GLMR",   decimals: 18 },
    ChainInfo { chain_id: 1285,   name: "Moonriver",        native_currency: "MOVR",   decimals: 18 },
    ChainInfo { chain_id: 1329,   name: "Sei",              native_currency: "SEI",    decimals: 18 },
    ChainInfo { chain_id: 1923,   name: "Swellchain",       native_currency: "ETH",    decimals: 18 },
    ChainInfo { chain_id: 2741,   name: "Abstract",         native_currency: "ETH",    decimals: 18 },
    ChainInfo { chain_id: 4326,   name: "MegaETH",          native_currency: "ETH",    decimals: 18 },
    ChainInfo { chain_id: 4352,   name: "Memecore",         native_currency: "MCORE",  decimals: 18 },
    ChainInfo { chain_id: 5000,   name: "Mantle",           native_currency: "MNT",    decimals: 18 },
    ChainInfo { chain_id: 9745,   name: "Plasma",           native_currency: "PLASMA", decimals: 18 },
    ChainInfo { chain_id: 33139,  name: "ApeChain",         native_currency: "APE",    decimals: 18 },
    ChainInfo { chain_id: 42220,  name: "Celo",             native_currency: "CELO",   decimals: 18 },
    ChainInfo { chain_id: 80094,  name: "Berachain",        native_currency: "BERA",   decimals: 18 },
    ChainInfo { chain_id: 167000, name: "Taiko",            native_currency: "ETH",    decimals: 18 },
    ChainInfo { chain_id: 747474, name: "Katana",           native_currency: "ETH",    decimals: 18 },
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
    #[allow(dead_code)]
    trace_id: String,
}

#[allow(dead_code)]
#[derive(Deserialize)]
struct Erc20Tx {
    hash: String,
    #[serde(rename = "timeStamp")]
    timestamp: String,
    from: String,
    to: String,
    value: String,
    #[serde(rename = "contractAddress")]
    contract_address: String,
    #[serde(rename = "tokenName")]
    token_name: String,
    #[serde(rename = "tokenSymbol")]
    token_symbol: String,
    #[serde(rename = "tokenDecimal")]
    token_decimal: String,
}

#[allow(dead_code)]
#[derive(Deserialize)]
struct Erc721Tx {
    hash: String,
    #[serde(rename = "timeStamp")]
    timestamp: String,
    from: String,
    to: String,
    #[serde(rename = "contractAddress")]
    contract_address: String,
    #[serde(rename = "tokenID")]
    token_id: String,
    #[serde(rename = "tokenName")]
    token_name: String,
    #[serde(rename = "tokenSymbol")]
    token_symbol: String,
}

#[allow(dead_code)]
#[derive(Deserialize)]
struct Erc1155Tx {
    hash: String,
    #[serde(rename = "timeStamp")]
    timestamp: String,
    from: String,
    to: String,
    #[serde(rename = "contractAddress")]
    contract_address: String,
    #[serde(rename = "tokenID")]
    token_id: String,
    #[serde(rename = "tokenValue")]
    token_value: String,
    #[serde(rename = "tokenName")]
    token_name: String,
    #[serde(rename = "tokenSymbol")]
    token_symbol: String,
}

// ---- Hash grouping ----

#[derive(Default)]
struct TxHashGroup {
    hash: String,
    timestamp: String,
    normal: Option<NormalTx>,
    internals: Vec<InternalTx>,
    erc20s: Vec<Erc20Tx>,
    erc721s: Vec<Erc721Tx>,
    erc1155s: Vec<Erc1155Tx>,
}

fn update_min_timestamp(current: &mut String, new_ts: &str) {
    if current.is_empty() {
        *current = new_ts.to_string();
        return;
    }
    let cur: u64 = current.parse().unwrap_or(u64::MAX);
    let new: u64 = new_ts.parse().unwrap_or(u64::MAX);
    if new < cur {
        *current = new_ts.to_string();
    }
}

fn group_by_hash(
    normal: Vec<NormalTx>,
    internal: Vec<InternalTx>,
    erc20: Vec<Erc20Tx>,
    erc721: Vec<Erc721Tx>,
    erc1155: Vec<Erc1155Tx>,
) -> BTreeMap<String, TxHashGroup> {
    let mut groups: BTreeMap<String, TxHashGroup> = BTreeMap::new();

    for tx in normal {
        let key = tx.hash.to_lowercase();
        let group = groups.entry(key.clone()).or_insert_with(|| TxHashGroup {
            hash: key,
            ..Default::default()
        });
        update_min_timestamp(&mut group.timestamp, &tx.timestamp);
        group.normal = Some(tx);
    }

    for tx in internal {
        let key = tx.hash.to_lowercase();
        let group = groups.entry(key.clone()).or_insert_with(|| TxHashGroup {
            hash: key,
            ..Default::default()
        });
        update_min_timestamp(&mut group.timestamp, &tx.timestamp);
        group.internals.push(tx);
    }

    for tx in erc20 {
        let key = tx.hash.to_lowercase();
        let group = groups.entry(key.clone()).or_insert_with(|| TxHashGroup {
            hash: key,
            ..Default::default()
        });
        update_min_timestamp(&mut group.timestamp, &tx.timestamp);
        group.erc20s.push(tx);
    }

    for tx in erc721 {
        let key = tx.hash.to_lowercase();
        let group = groups.entry(key.clone()).or_insert_with(|| TxHashGroup {
            hash: key,
            ..Default::default()
        });
        update_min_timestamp(&mut group.timestamp, &tx.timestamp);
        group.erc721s.push(tx);
    }

    for tx in erc1155 {
        let key = tx.hash.to_lowercase();
        let group = groups.entry(key.clone()).or_insert_with(|| TxHashGroup {
            hash: key,
            ..Default::default()
        });
        update_min_timestamp(&mut group.timestamp, &tx.timestamp);
        group.erc1155s.push(tx);
    }

    groups
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

    // 3. Fetch all 5 transfer types (with rate-limiting delays)
    let normal_json = fetch_paginated(api_key, &address, "txlist", chain_id)?;
    let normal_txns: Vec<NormalTx> =
        serde_json::from_value(normal_json).map_err(|e| format!("parse normal txns: {e}"))?;

    thread::sleep(Duration::from_millis(250));
    let internal_json = fetch_paginated(api_key, &address, "txlistinternal", chain_id)?;
    let internal_txns: Vec<InternalTx> =
        serde_json::from_value(internal_json).map_err(|e| format!("parse internal txns: {e}"))?;

    thread::sleep(Duration::from_millis(250));
    let erc20_json = fetch_paginated(api_key, &address, "tokentx", chain_id)?;
    let erc20_txns: Vec<Erc20Tx> =
        serde_json::from_value(erc20_json).map_err(|e| format!("parse ERC20 txns: {e}"))?;

    thread::sleep(Duration::from_millis(250));
    let erc721_json = fetch_paginated(api_key, &address, "tokennfttx", chain_id)?;
    let erc721_txns: Vec<Erc721Tx> =
        serde_json::from_value(erc721_json).map_err(|e| format!("parse ERC721 txns: {e}"))?;

    thread::sleep(Duration::from_millis(250));
    let erc1155_json = fetch_paginated(api_key, &address, "token1155tx", chain_id)?;
    let erc1155_txns: Vec<Erc1155Tx> =
        serde_json::from_value(erc1155_json).map_err(|e| format!("parse ERC1155 txns: {e}"))?;

    // 4. Group by hash
    let groups = group_by_hash(normal_txns, internal_txns, erc20_txns, erc721_txns, erc1155_txns);

    // 5. Sort groups by timestamp and process
    let mut sorted_groups: Vec<TxHashGroup> = groups.into_values().collect();
    sorted_groups.sort_by(|a, b| {
        let a_ts: u64 = a.timestamp.parse().unwrap_or(0);
        let b_ts: u64 = b.timestamp.parse().unwrap_or(0);
        a_ts.cmp(&b_ts)
    });

    for group in &sorted_groups {
        let source = format!("etherscan:{}:{}", chain_id, group.hash);
        if existing.contains(&source) {
            result.transactions_skipped += 1;
            continue;
        }
        process_hash_group(engine, group, &address, label, chain, &mut result)?;
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

// ---- Item builders ----

fn build_normal_items(
    engine: &LedgerEngine,
    tx: &NormalTx,
    our_address: &str,
    label: &str,
    entry_id: Uuid,
    date: NaiveDate,
    chain: &ChainInfo,
    result: &mut EtherscanSyncResult,
) -> Result<Vec<LineItem>, String> {
    let value = wei_to_native(&tx.value, chain.decimals)?;
    let gas_fee = calculate_gas_fee(&tx.gas_used, &tx.gas_price, chain.decimals)?;

    let from = tx.from.to_lowercase();
    let to = tx.to.to_lowercase();

    let chain_name = chain.name;
    let our_account = format!("Assets:{chain_name}:{label}");
    let mut items = Vec::new();

    if from == our_address && to == our_address {
        // Self-transfer: only gas
        if !gas_fee.is_zero() {
            let gas_acc_id = ensure_account(engine, &format!("Expenses:{chain_name}:Gas"), date, result)?;
            let our_acc_id = ensure_account(engine, &our_account, date, result)?;
            items.push(make_line_item(entry_id, gas_acc_id, gas_fee, chain.native_currency));
            items.push(make_line_item(entry_id, our_acc_id, -gas_fee, chain.native_currency));
        }
    } else if to.is_empty() {
        // Contract creation
        if !gas_fee.is_zero() {
            let cc_acc_id =
                ensure_account(engine, &format!("Expenses:{chain_name}:ContractCreation"), date, result)?;
            let our_acc_id = ensure_account(engine, &our_account, date, result)?;
            items.push(make_line_item(entry_id, cc_acc_id, gas_fee, chain.native_currency));
            items.push(make_line_item(entry_id, our_acc_id, -gas_fee, chain.native_currency));
        }
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
        if !value.is_zero() {
            let counterparty = short_addr(&from);
            let ext_account = format!("Equity:{chain_name}:External:{counterparty}");
            let ext_acc_id = ensure_account(engine, &ext_account, date, result)?;
            let our_acc_id = ensure_account(engine, &our_account, date, result)?;
            items.push(make_line_item(entry_id, our_acc_id, value, chain.native_currency));
            items.push(make_line_item(entry_id, ext_acc_id, -value, chain.native_currency));
        }
    }

    Ok(items)
}

fn build_internal_items(
    engine: &LedgerEngine,
    tx: &InternalTx,
    our_address: &str,
    label: &str,
    entry_id: Uuid,
    date: NaiveDate,
    chain: &ChainInfo,
    result: &mut EtherscanSyncResult,
) -> Result<Vec<LineItem>, String> {
    let value = wei_to_native(&tx.value, chain.decimals)?;
    if value.is_zero() {
        return Ok(Vec::new());
    }

    let from = tx.from.to_lowercase();
    let to = tx.to.to_lowercase();

    let chain_name = chain.name;
    let our_account = format!("Assets:{chain_name}:{label}");
    let mut items = Vec::new();

    if from == our_address && to == our_address {
        // Self-transfer internal: no net effect
    } else if from == our_address {
        let counterparty = short_addr(&to);
        let ext_account = format!("Equity:{chain_name}:External:{counterparty}");
        let ext_acc_id = ensure_account(engine, &ext_account, date, result)?;
        let our_acc_id = ensure_account(engine, &our_account, date, result)?;
        items.push(make_line_item(entry_id, ext_acc_id, value, chain.native_currency));
        items.push(make_line_item(entry_id, our_acc_id, -value, chain.native_currency));
    } else if to == our_address {
        let counterparty = short_addr(&from);
        let ext_account = format!("Equity:{chain_name}:External:{counterparty}");
        let ext_acc_id = ensure_account(engine, &ext_account, date, result)?;
        let our_acc_id = ensure_account(engine, &our_account, date, result)?;
        items.push(make_line_item(entry_id, our_acc_id, value, chain.native_currency));
        items.push(make_line_item(entry_id, ext_acc_id, -value, chain.native_currency));
    }

    Ok(items)
}

fn build_erc20_items(
    engine: &LedgerEngine,
    tx: &Erc20Tx,
    our_address: &str,
    label: &str,
    entry_id: Uuid,
    date: NaiveDate,
    chain: &ChainInfo,
    result: &mut EtherscanSyncResult,
) -> Result<Vec<LineItem>, String> {
    let decimals: u8 = tx.token_decimal.parse().unwrap_or(18);
    let value = wei_to_native(&tx.value, decimals)?;
    if value.is_zero() {
        return Ok(Vec::new());
    }

    let currency = if tx.token_symbol.is_empty() {
        format!("ERC20:{}", short_addr(&tx.contract_address))
    } else {
        tx.token_symbol.clone()
    };

    ensure_currency(engine, &currency, decimals, result)?;

    let from = tx.from.to_lowercase();
    let to = tx.to.to_lowercase();
    let chain_name = chain.name;
    let our_account = format!("Assets:{chain_name}:{label}");
    let mut items = Vec::new();

    if from == our_address && to == our_address {
        // Self-transfer: no net effect
    } else if from == our_address {
        let counterparty = short_addr(&to);
        let ext_account = format!("Equity:{chain_name}:External:{counterparty}");
        let ext_acc_id = ensure_account(engine, &ext_account, date, result)?;
        let our_acc_id = ensure_account(engine, &our_account, date, result)?;
        items.push(make_line_item(entry_id, ext_acc_id, value, &currency));
        items.push(make_line_item(entry_id, our_acc_id, -value, &currency));
    } else if to == our_address {
        let counterparty = short_addr(&from);
        let ext_account = format!("Equity:{chain_name}:External:{counterparty}");
        let ext_acc_id = ensure_account(engine, &ext_account, date, result)?;
        let our_acc_id = ensure_account(engine, &our_account, date, result)?;
        items.push(make_line_item(entry_id, our_acc_id, value, &currency));
        items.push(make_line_item(entry_id, ext_acc_id, -value, &currency));
    }

    Ok(items)
}

fn build_erc721_items(
    engine: &LedgerEngine,
    tx: &Erc721Tx,
    our_address: &str,
    label: &str,
    entry_id: Uuid,
    date: NaiveDate,
    chain: &ChainInfo,
    result: &mut EtherscanSyncResult,
) -> Result<Vec<LineItem>, String> {
    let value = Decimal::ONE;

    let currency = if tx.token_symbol.is_empty() {
        format!("NFT:{}", short_addr(&tx.contract_address))
    } else {
        tx.token_symbol.clone()
    };

    ensure_currency(engine, &currency, 0, result)?;

    let from = tx.from.to_lowercase();
    let to = tx.to.to_lowercase();
    let chain_name = chain.name;
    let our_account = format!("Assets:{chain_name}:{label}");
    let mut items = Vec::new();

    if from == our_address && to == our_address {
        // Self-transfer: no net effect
    } else if from == our_address {
        let counterparty = short_addr(&to);
        let ext_account = format!("Equity:{chain_name}:External:{counterparty}");
        let ext_acc_id = ensure_account(engine, &ext_account, date, result)?;
        let our_acc_id = ensure_account(engine, &our_account, date, result)?;
        items.push(make_line_item(entry_id, ext_acc_id, value, &currency));
        items.push(make_line_item(entry_id, our_acc_id, -value, &currency));
    } else if to == our_address {
        let counterparty = short_addr(&from);
        let ext_account = format!("Equity:{chain_name}:External:{counterparty}");
        let ext_acc_id = ensure_account(engine, &ext_account, date, result)?;
        let our_acc_id = ensure_account(engine, &our_account, date, result)?;
        items.push(make_line_item(entry_id, our_acc_id, value, &currency));
        items.push(make_line_item(entry_id, ext_acc_id, -value, &currency));
    }

    Ok(items)
}

fn build_erc1155_items(
    engine: &LedgerEngine,
    tx: &Erc1155Tx,
    our_address: &str,
    label: &str,
    entry_id: Uuid,
    date: NaiveDate,
    chain: &ChainInfo,
    result: &mut EtherscanSyncResult,
) -> Result<Vec<LineItem>, String> {
    let value = Decimal::from_str(&tx.token_value).unwrap_or(Decimal::ZERO);
    if value.is_zero() {
        return Ok(Vec::new());
    }

    let currency = if tx.token_symbol.is_empty() {
        format!("ERC1155:{}", short_addr(&tx.contract_address))
    } else {
        tx.token_symbol.clone()
    };

    ensure_currency(engine, &currency, 0, result)?;

    let from = tx.from.to_lowercase();
    let to = tx.to.to_lowercase();
    let chain_name = chain.name;
    let our_account = format!("Assets:{chain_name}:{label}");
    let mut items = Vec::new();

    if from == our_address && to == our_address {
        // Self-transfer: no net effect
    } else if from == our_address {
        let counterparty = short_addr(&to);
        let ext_account = format!("Equity:{chain_name}:External:{counterparty}");
        let ext_acc_id = ensure_account(engine, &ext_account, date, result)?;
        let our_acc_id = ensure_account(engine, &our_account, date, result)?;
        items.push(make_line_item(entry_id, ext_acc_id, value, &currency));
        items.push(make_line_item(entry_id, our_acc_id, -value, &currency));
    } else if to == our_address {
        let counterparty = short_addr(&from);
        let ext_account = format!("Equity:{chain_name}:External:{counterparty}");
        let ext_acc_id = ensure_account(engine, &ext_account, date, result)?;
        let our_acc_id = ensure_account(engine, &our_account, date, result)?;
        items.push(make_line_item(entry_id, our_acc_id, value, &currency));
        items.push(make_line_item(entry_id, ext_acc_id, -value, &currency));
    }

    Ok(items)
}

// ---- Item merging ----

fn merge_items(items: Vec<LineItem>) -> Vec<LineItem> {
    // Group by (account_id, currency), sum amounts, drop zeros
    let mut sums: BTreeMap<(Uuid, String), (Uuid, Decimal)> = BTreeMap::new();

    for item in &items {
        let key = (item.account_id, item.currency.clone());
        let entry = sums
            .entry(key)
            .or_insert((item.journal_entry_id, Decimal::ZERO));
        entry.1 += item.amount;
    }

    sums.into_iter()
        .filter(|(_, (_, amount))| !amount.is_zero())
        .map(|((account_id, currency), (entry_id, amount))| LineItem {
            id: Uuid::now_v7(),
            journal_entry_id: entry_id,
            account_id,
            currency,
            amount,
            lot_id: None,
        })
        .collect()
}

// ---- Hash group processing ----

fn process_hash_group(
    engine: &LedgerEngine,
    group: &TxHashGroup,
    our_address: &str,
    label: &str,
    chain: &ChainInfo,
    result: &mut EtherscanSyncResult,
) -> Result<(), String> {
    // Skip if normal tx has isError == "1"
    if let Some(ref normal) = group.normal {
        if normal.is_error == "1" {
            return Ok(());
        }
    }

    let date = timestamp_to_date(&group.timestamp)?;
    let entry_id = Uuid::now_v7();
    let mut all_items = Vec::new();

    // Build normal items
    if let Some(ref normal) = group.normal {
        let items = build_normal_items(engine, normal, our_address, label, entry_id, date, chain, result)?;
        all_items.extend(items);
    }

    // Build internal items (skip isError == "1")
    for internal in &group.internals {
        if internal.is_error == "1" {
            continue;
        }
        let items = build_internal_items(engine, internal, our_address, label, entry_id, date, chain, result)?;
        all_items.extend(items);
    }

    // Build ERC20 items
    for erc20 in &group.erc20s {
        let items = build_erc20_items(engine, erc20, our_address, label, entry_id, date, chain, result)?;
        all_items.extend(items);
    }

    // Build ERC721 items
    for erc721 in &group.erc721s {
        let items = build_erc721_items(engine, erc721, our_address, label, entry_id, date, chain, result)?;
        all_items.extend(items);
    }

    // Build ERC1155 items
    for erc1155 in &group.erc1155s {
        let items = build_erc1155_items(engine, erc1155, our_address, label, entry_id, date, chain, result)?;
        all_items.extend(items);
    }

    // Merge items sharing the same (account_id, currency)
    let merged = merge_items(all_items);
    if merged.is_empty() {
        return Ok(());
    }

    // Build description
    let description = build_group_description(group, our_address, chain);

    // Post journal entry
    let source = format!("etherscan:{}:{}", chain.chain_id, group.hash);
    let entry = JournalEntry {
        id: entry_id,
        date,
        description,
        status: JournalEntryStatus::Confirmed,
        source,
        voided_by: None,
        created_at: date,
    };

    engine
        .post_journal_entry(&entry, &merged)
        .map_err(|e| format!("post tx {}: {e}", group.hash))?;
    result.transactions_imported += 1;
    Ok(())
}

// ---- Description builders ----

fn build_group_description(group: &TxHashGroup, our_address: &str, chain: &ChainInfo) -> String {
    let hash_short = if group.hash.len() >= 10 {
        &group.hash[..10]
    } else {
        &group.hash
    };
    let token_count = group.erc20s.len() + group.erc721s.len() + group.erc1155s.len();

    if let Some(ref normal) = group.normal {
        let base = format_tx_description(normal, our_address, chain);
        if token_count > 0 {
            format!("{base} + {token_count} token transfer(s)")
        } else {
            base
        }
    } else if !group.internals.is_empty() && token_count == 0 {
        // Internal-only
        let currency = chain.native_currency;
        format!("{currency} internal transfer ({hash_short})")
    } else {
        // Token-only or mixed internal+token (no normal)
        build_token_description(group, our_address, hash_short)
    }
}

fn build_token_description(group: &TxHashGroup, our_address: &str, hash_short: &str) -> String {
    let total = group.erc20s.len() + group.erc721s.len() + group.erc1155s.len();

    // Find the first token transfer involving our address
    for tx in &group.erc20s {
        let symbol = if tx.token_symbol.is_empty() {
            format!("ERC20:{}", short_addr(&tx.contract_address))
        } else {
            tx.token_symbol.clone()
        };
        let from = tx.from.to_lowercase();
        let to = tx.to.to_lowercase();
        if from == our_address {
            let base = format!("{symbol} sent to {} ({hash_short})", short_addr(&to));
            return if total > 1 { format!("{base} + {} more", total - 1) } else { base };
        } else if to == our_address {
            let base = format!("{symbol} received from {} ({hash_short})", short_addr(&from));
            return if total > 1 { format!("{base} + {} more", total - 1) } else { base };
        }
    }

    for tx in &group.erc721s {
        let symbol = if tx.token_symbol.is_empty() {
            format!("NFT:{}", short_addr(&tx.contract_address))
        } else {
            tx.token_symbol.clone()
        };
        let from = tx.from.to_lowercase();
        let to = tx.to.to_lowercase();
        if from == our_address {
            let base = format!("{symbol} sent to {} ({hash_short})", short_addr(&to));
            return if total > 1 { format!("{base} + {} more", total - 1) } else { base };
        } else if to == our_address {
            let base = format!("{symbol} received from {} ({hash_short})", short_addr(&from));
            return if total > 1 { format!("{base} + {} more", total - 1) } else { base };
        }
    }

    for tx in &group.erc1155s {
        let symbol = if tx.token_symbol.is_empty() {
            format!("ERC1155:{}", short_addr(&tx.contract_address))
        } else {
            tx.token_symbol.clone()
        };
        let from = tx.from.to_lowercase();
        let to = tx.to.to_lowercase();
        if from == our_address {
            let base = format!("{symbol} sent to {} ({hash_short})", short_addr(&to));
            return if total > 1 { format!("{base} + {} more", total - 1) } else { base };
        } else if to == our_address {
            let base = format!("{symbol} received from {} ({hash_short})", short_addr(&from));
            return if total > 1 { format!("{base} + {} more", total - 1) } else { base };
        }
    }

    format!("token transfer ({hash_short})")
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
    let prefix = format!("etherscan:{chain_id}:");

    for (e, _) in entries {
        if !e.source.starts_with("etherscan:") {
            continue;
        }
        set.insert(e.source.clone());

        // Backward compat: old sources like "etherscan:0x..." (no chain_id prefix)
        // When syncing chain_id=1, also match these legacy entries
        if chain_id == 1 && !e.source.starts_with("etherscan:1:") {
            let rest = &e.source["etherscan:".len()..];
            if rest.starts_with("0x") {
                set.insert(format!("etherscan:1:{rest}"));
            } else if rest.starts_with("int:") {
                set.insert(format!("etherscan:1:{rest}"));
                // Also add hash-level key for old internal sources
                let parts: Vec<&str> = rest.splitn(3, ':').collect();
                if parts.len() >= 2 {
                    set.insert(format!("etherscan:1:{}", parts[1]));
                }
            }
        }

        // Backward compat: old internal sources "etherscan:{chainId}:int:{hash}:{traceId}"
        // → also insert hash-level key "etherscan:{chainId}:{hash}"
        if e.source.starts_with(&prefix) {
            let after_prefix = &e.source[prefix.len()..];
            if after_prefix.starts_with("int:") {
                let parts: Vec<&str> = after_prefix.splitn(3, ':').collect();
                if parts.len() >= 2 {
                    set.insert(format!("etherscan:{chain_id}:{}", parts[1]));
                }
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
