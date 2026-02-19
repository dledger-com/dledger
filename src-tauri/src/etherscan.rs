use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

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

// ---- Public types ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EtherscanAccount {
    pub address: String,
    pub chain_id: u64,
    pub label: String,
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
