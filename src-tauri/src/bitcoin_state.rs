use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BitcoinAccount {
    pub id: String,
    pub address_or_xpub: String,
    pub account_type: String,
    pub derivation_bip: Option<u32>,
    pub network: String,
    pub label: String,
    pub last_receive_index: i32,
    pub last_change_index: i32,
    pub last_sync: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BtcDerivedAddress {
    pub address: String,
    pub bitcoin_account_id: String,
    pub change_chain: i32,
    pub address_index: i32,
    pub has_transactions: bool,
}

pub struct BitcoinState {
    conn: Mutex<Connection>,
}

impl BitcoinState {
    pub fn new(db_path: &str) -> Result<Self, String> {
        let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS bitcoin_account (
                id TEXT PRIMARY KEY NOT NULL,
                address_or_xpub TEXT NOT NULL,
                account_type TEXT NOT NULL DEFAULT 'address',
                derivation_bip INTEGER,
                network TEXT NOT NULL DEFAULT 'mainnet',
                label TEXT NOT NULL,
                last_receive_index INTEGER NOT NULL DEFAULT -1,
                last_change_index INTEGER NOT NULL DEFAULT -1,
                last_sync TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS btc_derived_address (
                address TEXT PRIMARY KEY NOT NULL,
                bitcoin_account_id TEXT NOT NULL REFERENCES bitcoin_account(id) ON DELETE CASCADE,
                change_chain INTEGER NOT NULL DEFAULT 0,
                address_index INTEGER NOT NULL,
                has_transactions INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_btc_derived_account ON btc_derived_address(bitcoin_account_id);",
        )
        .map_err(|e| e.to_string())?;

        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|e| e.to_string())?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn list_accounts(&self) -> Result<Vec<BitcoinAccount>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, address_or_xpub, account_type, derivation_bip, network, label, \
                 last_receive_index, last_change_index, last_sync, created_at \
                 FROM bitcoin_account ORDER BY label",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok(BitcoinAccount {
                    id: row.get(0)?,
                    address_or_xpub: row.get(1)?,
                    account_type: row.get(2)?,
                    derivation_bip: row.get(3)?,
                    network: row.get(4)?,
                    label: row.get(5)?,
                    last_receive_index: row.get(6)?,
                    last_change_index: row.get(7)?,
                    last_sync: row.get(8)?,
                    created_at: row.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn add_account(&self, account: &BitcoinAccount) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO bitcoin_account \
             (id, address_or_xpub, account_type, derivation_bip, network, label, \
              last_receive_index, last_change_index, last_sync, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                account.id,
                account.address_or_xpub,
                account.account_type,
                account.derivation_bip,
                account.network,
                account.label,
                account.last_receive_index,
                account.last_change_index,
                account.last_sync,
                account.created_at,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn remove_account(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM bitcoin_account WHERE id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_tracked_addresses(&self, account_id: &str) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let account_type: String = conn
            .query_row(
                "SELECT account_type FROM bitcoin_account WHERE id = ?1",
                params![account_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        if account_type == "address" {
            let addr: String = conn
                .query_row(
                    "SELECT address_or_xpub FROM bitcoin_account WHERE id = ?1",
                    params![account_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            return Ok(vec![addr]);
        }

        // xpub type - return derived addresses
        let mut stmt = conn
            .prepare(
                "SELECT address FROM btc_derived_address \
                 WHERE bitcoin_account_id = ?1 \
                 ORDER BY change_chain, address_index",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![account_id], |row| row.get(0))
            .map_err(|e| e.to_string())?;

        rows.collect::<Result<Vec<String>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn store_derived_addresses(
        &self,
        account_id: &str,
        addresses: &[(String, i32, i32)],
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "INSERT OR REPLACE INTO btc_derived_address \
                 (address, bitcoin_account_id, change_chain, address_index, has_transactions) \
                 VALUES (?1, ?2, ?3, ?4, 0)",
            )
            .map_err(|e| e.to_string())?;

        for (addr, change, index) in addresses {
            stmt.execute(params![addr, account_id, change, index])
                .map_err(|e| e.to_string())?;
        }

        Ok(())
    }

    pub fn update_derivation_index(
        &self,
        account_id: &str,
        receive_index: i32,
        change_index: i32,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE bitcoin_account SET last_receive_index = ?1, last_change_index = ?2 WHERE id = ?3",
            params![receive_index, change_index, account_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn mark_address_has_transactions(&self, address: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE btc_derived_address SET has_transactions = 1 WHERE address = ?1",
            params![address],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_last_sync(&self, account_id: &str, timestamp: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE bitcoin_account SET last_sync = ?1 WHERE id = ?2",
            params![timestamp, account_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bitcoin_state_crud() {
        let state = BitcoinState::new(":memory:").unwrap();

        let account = BitcoinAccount {
            id: "test-1".to_string(),
            address_or_xpub: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq".to_string(),
            account_type: "address".to_string(),
            derivation_bip: None,
            network: "mainnet".to_string(),
            label: "My Wallet".to_string(),
            last_receive_index: -1,
            last_change_index: -1,
            last_sync: None,
            created_at: "2024-01-01T00:00:00Z".to_string(),
        };
        state.add_account(&account).unwrap();

        // List
        let accounts = state.list_accounts().unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].label, "My Wallet");

        // Get tracked addresses for single address
        let addrs = state.get_tracked_addresses("test-1").unwrap();
        assert_eq!(
            addrs,
            vec!["bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"]
        );

        // Update last sync
        state
            .update_last_sync("test-1", "2024-06-01T12:00:00Z")
            .unwrap();
        let accounts = state.list_accounts().unwrap();
        assert_eq!(
            accounts[0].last_sync.as_deref(),
            Some("2024-06-01T12:00:00Z")
        );

        // Remove
        state.remove_account("test-1").unwrap();
        let accounts = state.list_accounts().unwrap();
        assert!(accounts.is_empty());
    }

    #[test]
    fn test_derived_addresses() {
        let state = BitcoinState::new(":memory:").unwrap();

        let account = BitcoinAccount {
            id: "xpub-1".to_string(),
            address_or_xpub: "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8".to_string(),
            account_type: "xpub".to_string(),
            derivation_bip: Some(84),
            network: "mainnet".to_string(),
            label: "HD Wallet".to_string(),
            last_receive_index: -1,
            last_change_index: -1,
            last_sync: None,
            created_at: "2024-01-01T00:00:00Z".to_string(),
        };
        state.add_account(&account).unwrap();

        // Store derived addresses
        let derived = vec![
            ("bc1qaddr1".to_string(), 0, 0),
            ("bc1qaddr2".to_string(), 0, 1),
            ("bc1qchange1".to_string(), 1, 0),
        ];
        state.store_derived_addresses("xpub-1", &derived).unwrap();

        // Get tracked addresses
        let addrs = state.get_tracked_addresses("xpub-1").unwrap();
        assert_eq!(addrs.len(), 3);

        // Mark address has transactions
        state
            .mark_address_has_transactions("bc1qaddr1")
            .unwrap();

        // Update derivation index
        state.update_derivation_index("xpub-1", 1, 0).unwrap();
        let accounts = state.list_accounts().unwrap();
        assert_eq!(accounts[0].last_receive_index, 1);
    }

    #[test]
    fn test_cascade_delete() {
        let state = BitcoinState::new(":memory:").unwrap();

        let account = BitcoinAccount {
            id: "xpub-2".to_string(),
            address_or_xpub: "xpub-test".to_string(),
            account_type: "xpub".to_string(),
            derivation_bip: Some(84),
            network: "mainnet".to_string(),
            label: "Delete Test".to_string(),
            last_receive_index: -1,
            last_change_index: -1,
            last_sync: None,
            created_at: "2024-01-01T00:00:00Z".to_string(),
        };
        state.add_account(&account).unwrap();

        let derived = vec![
            ("addr1".to_string(), 0, 0),
            ("addr2".to_string(), 0, 1),
        ];
        state.store_derived_addresses("xpub-2", &derived).unwrap();

        // Derived addresses exist
        let addrs = state.get_tracked_addresses("xpub-2").unwrap();
        assert_eq!(addrs.len(), 2);

        // Remove account — derived addresses should cascade delete
        state.remove_account("xpub-2").unwrap();
        let accounts = state.list_accounts().unwrap();
        assert!(accounts.is_empty());
    }
}
