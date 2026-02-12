use rusqlite::Connection;
use std::sync::Mutex;

/// Plugin-scoped key-value storage backed by SQLite.
/// Each plugin gets its own namespace, isolated from other plugins.
pub struct PluginKvStorage {
    conn: Mutex<Connection>,
}

impl PluginKvStorage {
    pub fn new(db_path: &str) -> Result<Self, String> {
        let conn =
            Connection::open(db_path).map_err(|e| format!("Failed to open plugin DB: {e}"))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS plugin_kv (
                plugin_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                PRIMARY KEY (plugin_id, key)
            );",
        )
        .map_err(|e| format!("Failed to create plugin_kv table: {e}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn get(&self, plugin_id: &str, key: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT value FROM plugin_kv WHERE plugin_id = ?1 AND key = ?2")
            .map_err(|e| e.to_string())?;
        let result = stmt
            .query_row(rusqlite::params![plugin_id, key], |row| row.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(result)
    }

    pub fn set(&self, plugin_id: &str, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO plugin_kv (plugin_id, key, value) VALUES (?1, ?2, ?3)
             ON CONFLICT(plugin_id, key) DO UPDATE SET value = ?3",
            rusqlite::params![plugin_id, key, value],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete(&self, plugin_id: &str, key: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM plugin_kv WHERE plugin_id = ?1 AND key = ?2",
            rusqlite::params![plugin_id, key],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_keys(&self, plugin_id: &str) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT key FROM plugin_kv WHERE plugin_id = ?1 ORDER BY key")
            .map_err(|e| e.to_string())?;
        let keys = stmt
            .query_map(rusqlite::params![plugin_id], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(keys)
    }
}

trait OptionalExt<T> {
    fn optional(self) -> Result<Option<T>, rusqlite::Error>;
}

impl<T> OptionalExt<T> for Result<T, rusqlite::Error> {
    fn optional(self) -> Result<Option<T>, rusqlite::Error> {
        match self {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
}
