use bitcoin::address::NetworkUnchecked;
use bitcoin::{Address, Network};
use serde::{Deserialize, Serialize};
use std::str::FromStr;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BtcAddressInfo {
    pub valid: bool,
    pub network: String,
    pub address_type: String,
}

pub fn validate_btc_address(address: &str) -> BtcAddressInfo {
    let invalid = BtcAddressInfo {
        valid: false,
        network: String::new(),
        address_type: "unknown".to_string(),
    };

    // Parse as unchecked-network address
    let parsed = match Address::<NetworkUnchecked>::from_str(address) {
        Ok(a) => a,
        Err(_) => return invalid,
    };

    // Try mainnet first, then testnet
    let (network_str, checked) =
        if let Ok(a) = parsed.clone().require_network(Network::Bitcoin) {
            ("mainnet", a)
        } else if let Ok(a) = parsed.clone().require_network(Network::Testnet) {
            ("testnet", a)
        } else if let Ok(a) = parsed.require_network(Network::Signet) {
            ("testnet", a)
        } else {
            return invalid;
        };

    let addr_type = match checked.address_type() {
        Some(bitcoin::AddressType::P2pkh) => "p2pkh",
        Some(bitcoin::AddressType::P2sh) => "p2sh",
        Some(bitcoin::AddressType::P2wpkh) => "p2wpkh",
        Some(bitcoin::AddressType::P2wsh) => "p2wsh",
        Some(bitcoin::AddressType::P2tr) => "p2tr",
        _ => "unknown",
    };

    BtcAddressInfo {
        valid: true,
        network: network_str.to_string(),
        address_type: addr_type.to_string(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BtcXpubInfo {
    pub valid: bool,
    pub key_type: String,
    pub network: String,
    pub suggested_bip: u32,
}

pub fn validate_btc_xpub(xpub: &str) -> BtcXpubInfo {
    let invalid = BtcXpubInfo {
        valid: false,
        key_type: "unknown".to_string(),
        network: String::new(),
        suggested_bip: 0,
    };

    if xpub.len() < 4 {
        return invalid;
    }

    let prefix = &xpub[..4];

    let (key_type, network, suggested_bip) = match prefix {
        "xpub" => ("xpub", "mainnet", 44u32),
        "ypub" => ("ypub", "mainnet", 49),
        "zpub" => ("zpub", "mainnet", 84),
        "tpub" => ("tpub", "testnet", 44),
        "upub" => ("upub", "testnet", 49),
        "vpub" => ("vpub", "testnet", 84),
        _ => return invalid,
    };

    // For xpub/tpub, try parsing with bitcoin crate directly
    if prefix == "xpub" || prefix == "tpub" {
        if bitcoin::bip32::Xpub::from_str(xpub).is_ok() {
            return BtcXpubInfo {
                valid: true,
                key_type: key_type.to_string(),
                network: network.to_string(),
                suggested_bip,
            };
        }
        return invalid;
    }

    // For ypub/zpub/upub/vpub, decode base58check and validate length + version bytes
    let decoded = match bitcoin::base58::decode_check(xpub) {
        Ok(d) => d,
        Err(_) => return invalid,
    };

    if decoded.len() != 78 {
        return invalid;
    }

    // Verify version bytes match expected prefix
    let version = &decoded[..4];
    let valid_version = match prefix {
        "ypub" => version == [0x04, 0x9D, 0x7C, 0xB2],
        "zpub" => version == [0x04, 0xB2, 0x47, 0x46],
        "upub" => version == [0x04, 0x4A, 0x52, 0x62],
        "vpub" => version == [0x04, 0x5F, 0x1C, 0xF6],
        _ => false,
    };

    if !valid_version {
        return invalid;
    }

    BtcXpubInfo {
        valid: true,
        key_type: key_type.to_string(),
        network: network.to_string(),
        suggested_bip,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_mainnet_p2pkh() {
        let info = validate_btc_address("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
        assert!(info.valid);
        assert_eq!(info.network, "mainnet");
        assert_eq!(info.address_type, "p2pkh");
    }

    #[test]
    fn test_validate_mainnet_p2sh() {
        let info = validate_btc_address("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy");
        assert!(info.valid);
        assert_eq!(info.network, "mainnet");
        assert_eq!(info.address_type, "p2sh");
    }

    #[test]
    fn test_validate_mainnet_bech32() {
        let info = validate_btc_address("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
        assert!(info.valid);
        assert_eq!(info.network, "mainnet");
        assert_eq!(info.address_type, "p2wpkh");
    }

    #[test]
    fn test_validate_mainnet_taproot() {
        let info =
            validate_btc_address("bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297");
        assert!(info.valid);
        assert_eq!(info.network, "mainnet");
        assert_eq!(info.address_type, "p2tr");
    }

    #[test]
    fn test_validate_testnet_p2pkh() {
        let info = validate_btc_address("mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn");
        assert!(info.valid);
        assert_eq!(info.network, "testnet");
        assert_eq!(info.address_type, "p2pkh");
    }

    #[test]
    fn test_validate_testnet_bech32() {
        let info = validate_btc_address("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx");
        assert!(info.valid);
        assert_eq!(info.network, "testnet");
        assert_eq!(info.address_type, "p2wpkh");
    }

    #[test]
    fn test_validate_invalid() {
        let info = validate_btc_address("not-an-address");
        assert!(!info.valid);
    }

    #[test]
    fn test_validate_empty() {
        let info = validate_btc_address("");
        assert!(!info.valid);
    }

    #[test]
    fn test_validate_xpub() {
        let info = validate_btc_xpub("xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8");
        assert!(info.valid);
        assert_eq!(info.key_type, "xpub");
        assert_eq!(info.network, "mainnet");
        assert_eq!(info.suggested_bip, 44);
    }

    #[test]
    fn test_validate_xpub_invalid() {
        let info = validate_btc_xpub("not-an-xpub");
        assert!(!info.valid);
    }

    #[test]
    fn test_validate_xpub_empty() {
        let info = validate_btc_xpub("");
        assert!(!info.valid);
    }

    #[test]
    fn test_validate_xpub_short() {
        let info = validate_btc_xpub("xpu");
        assert!(!info.valid);
    }
}
