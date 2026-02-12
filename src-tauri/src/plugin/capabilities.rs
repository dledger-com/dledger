use std::collections::HashSet;

use super::manifest::CapabilitiesDecl;

/// The set of capabilities actually granted to a plugin (after user approval).
#[derive(Debug, Clone)]
pub struct GrantedCapabilities {
    pub ledger_read: bool,
    pub ledger_write: bool,
    pub http: bool,
    pub allowed_domains: HashSet<String>,
    pub rate_limit: u32,
    pub max_memory_bytes: u64,
    pub max_fuel: u64,
}

impl GrantedCapabilities {
    /// Create granted capabilities from a declaration (grants everything declared).
    /// In the future, the user may narrow these.
    pub fn from_declaration(decl: &CapabilitiesDecl) -> Self {
        let allowed_domains: HashSet<String> = decl
            .network
            .as_ref()
            .map(|n| n.allowed_domains.iter().cloned().collect())
            .unwrap_or_default();

        let rate_limit = decl.network.as_ref().map(|n| n.rate_limit).unwrap_or(30);

        let limits = decl.limits.clone().unwrap_or_default();

        Self {
            ledger_read: decl.ledger_read,
            ledger_write: decl.ledger_write,
            http: decl.http,
            allowed_domains,
            rate_limit,
            max_memory_bytes: limits.max_memory_mb * 1024 * 1024,
            // Convert ms to fuel: roughly 1 fuel = 1 wasm instruction.
            // 30_000ms ~= 100M instructions as a rough heuristic.
            max_fuel: limits.max_execution_time_ms * 3_333,
        }
    }

    /// Check if an HTTP request to the given URL is allowed.
    pub fn is_domain_allowed(&self, url: &str) -> bool {
        if !self.http {
            return false;
        }
        // Extract host from URL
        let host = extract_host(url);
        match host {
            Some(h) => self.allowed_domains.iter().any(|d| {
                h == *d || h.ends_with(&format!(".{d}"))
            }),
            None => false,
        }
    }
}

fn extract_host(url: &str) -> Option<String> {
    // Simple host extraction from URL
    let url = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let host = url.split('/').next()?;
    let host = host.split(':').next()?;
    Some(host.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_domain_allowed() {
        let caps = GrantedCapabilities {
            ledger_read: true,
            ledger_write: false,
            http: true,
            allowed_domains: HashSet::from(["api.etherscan.io".into(), "kraken.com".into()]),
            rate_limit: 30,
            max_memory_bytes: 128 * 1024 * 1024,
            max_fuel: 100_000_000,
        };

        assert!(caps.is_domain_allowed("https://api.etherscan.io/api?module=account"));
        assert!(caps.is_domain_allowed("https://www.kraken.com/api/v1/trades"));
        assert!(!caps.is_domain_allowed("https://evil.com/steal"));
        assert!(!caps.is_domain_allowed("https://notetherscan.io/phish"));
    }

    #[test]
    fn test_http_disabled() {
        let caps = GrantedCapabilities {
            ledger_read: true,
            ledger_write: false,
            http: false,
            allowed_domains: HashSet::from(["api.etherscan.io".into()]),
            rate_limit: 30,
            max_memory_bytes: 128 * 1024 * 1024,
            max_fuel: 100_000_000,
        };

        assert!(!caps.is_domain_allowed("https://api.etherscan.io/api"));
    }
}
