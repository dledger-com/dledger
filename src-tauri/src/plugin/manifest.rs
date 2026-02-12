use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
pub struct PluginManifest {
    pub plugin: PluginInfo,
    #[serde(default)]
    pub capabilities: CapabilitiesDecl,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PluginInfo {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    /// "source" or "handler"
    pub kind: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct CapabilitiesDecl {
    #[serde(default)]
    pub ledger_read: bool,
    #[serde(default)]
    pub ledger_write: bool,
    #[serde(default)]
    pub http: bool,
    #[serde(default)]
    pub network: Option<NetworkDecl>,
    #[serde(default)]
    pub limits: Option<LimitsDecl>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct NetworkDecl {
    #[serde(default)]
    pub allowed_domains: Vec<String>,
    #[serde(default = "default_rate_limit")]
    pub rate_limit: u32,
}

fn default_rate_limit() -> u32 {
    30
}

#[derive(Debug, Clone, Deserialize)]
pub struct LimitsDecl {
    #[serde(default = "default_max_memory_mb")]
    pub max_memory_mb: u64,
    #[serde(default = "default_max_execution_ms")]
    pub max_execution_time_ms: u64,
}

fn default_max_memory_mb() -> u64 {
    128
}

fn default_max_execution_ms() -> u64 {
    30_000
}

impl Default for LimitsDecl {
    fn default() -> Self {
        Self {
            max_memory_mb: default_max_memory_mb(),
            max_execution_time_ms: default_max_execution_ms(),
        }
    }
}

impl PluginManifest {
    pub fn from_file(path: &Path) -> Result<Self, String> {
        let content =
            std::fs::read_to_string(path).map_err(|e| format!("Failed to read manifest: {e}"))?;
        toml::from_str(&content).map_err(|e| format!("Failed to parse manifest: {e}"))
    }

    pub fn limits(&self) -> LimitsDecl {
        self.capabilities.limits.clone().unwrap_or_default()
    }

    pub fn allowed_domains(&self) -> Vec<String> {
        self.capabilities
            .network
            .as_ref()
            .map(|n| n.allowed_domains.clone())
            .unwrap_or_default()
    }

    pub fn rate_limit(&self) -> u32 {
        self.capabilities
            .network
            .as_ref()
            .map(|n| n.rate_limit)
            .unwrap_or(default_rate_limit())
    }
}
