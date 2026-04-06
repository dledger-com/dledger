use bitcoin::bip32::{ChildNumber, Xpriv, Xpub};
use bitcoin::secp256k1::Secp256k1;
use bitcoin::{Address, CompressedPublicKey, Network, NetworkKind, PrivateKey};
use serde::{Deserialize, Serialize};
use std::str::FromStr;

use crate::bitcoin_addr::{validate_btc_address, validate_btc_xpub};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BtcInputDetection {
    pub input_type: String,
    pub is_private: bool,
    pub network: String,
    pub suggested_bip: Option<u32>,
    pub description: String,
    pub valid: bool,
    pub word_count: Option<u32>,
    pub invalid_words: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum PublicResult {
    Address { address: String },
    Xpub { xpub: String, key_type: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrivateKeyConversion {
    pub input_type: String,
    pub public_result: PublicResult,
    pub network: String,
    pub suggested_bip: u32,
}

// Version bytes for extended private keys
const XPRV_VERSION: [u8; 4] = [0x04, 0x88, 0xAD, 0xE4];
const TPRV_VERSION: [u8; 4] = [0x04, 0x35, 0x83, 0x94];
#[allow(dead_code)]
const YPRV_VERSION: [u8; 4] = [0x04, 0x9D, 0x78, 0x78];
#[allow(dead_code)]
const ZPRV_VERSION: [u8; 4] = [0x04, 0xB2, 0x43, 0x0C];
#[allow(dead_code)]
const UPRV_VERSION: [u8; 4] = [0x04, 0x4A, 0x4E, 0x28];
#[allow(dead_code)]
const VPRV_VERSION: [u8; 4] = [0x04, 0x5F, 0x18, 0xBC];

// Version bytes for extended public keys
const YPUB_VERSION: [u8; 4] = [0x04, 0x9D, 0x7C, 0xB2];
const ZPUB_VERSION: [u8; 4] = [0x04, 0xB2, 0x47, 0x46];
const UPUB_VERSION: [u8; 4] = [0x04, 0x4A, 0x52, 0x62];
const VPUB_VERSION: [u8; 4] = [0x04, 0x5F, 0x1C, 0xF6];

fn network_kind_str(network: NetworkKind) -> &'static str {
    match network {
        NetworkKind::Main => "mainnet",
        NetworkKind::Test => "testnet",
    }
}

fn network_kind_to_network(kind: NetworkKind) -> Network {
    match kind {
        NetworkKind::Main => Network::Bitcoin,
        NetworkKind::Test => Network::Testnet,
    }
}

fn address_type_description(addr_type: &str) -> &'static str {
    match addr_type {
        "p2pkh" => "Bitcoin Address (P2PKH, Legacy)",
        "p2sh" => "Bitcoin Address (P2SH, Script Hash)",
        "p2wpkh" => "Bitcoin Address (P2WPKH, Native SegWit)",
        "p2wsh" => "Bitcoin Address (P2WSH)",
        "p2tr" => "Bitcoin Address (P2TR, Taproot)",
        _ => "Bitcoin Address",
    }
}

/// Try to parse an extended private key (xprv/yprv/zprv/tprv/uprv/vprv).
/// Returns (Xpriv, prefix_str, network_str, suggested_bip) on success.
fn try_parse_xprv(input: &str) -> Option<(Xpriv, String, String, u32)> {
    if input.len() < 4 {
        return None;
    }
    let prefix = &input[..4];

    match prefix {
        "xprv" | "tprv" => {
            let xpriv = Xpriv::from_str(input).ok()?;
            let net = if prefix == "xprv" {
                "mainnet"
            } else {
                "testnet"
            };
            let bip: u32 = 44;
            Some((xpriv, prefix.to_string(), net.to_string(), bip))
        }
        "yprv" | "zprv" | "uprv" | "vprv" => {
            let (target_version, net, bip, key_type) = match prefix {
                "yprv" => (XPRV_VERSION, "mainnet", 49u32, "yprv"),
                "zprv" => (XPRV_VERSION, "mainnet", 84, "zprv"),
                "uprv" => (TPRV_VERSION, "testnet", 49, "uprv"),
                "vprv" => (TPRV_VERSION, "testnet", 84, "vprv"),
                _ => unreachable!(),
            };

            let mut decoded = bitcoin::base58::decode_check(input).ok()?;
            if decoded.len() != 78 {
                return None;
            }
            decoded[..4].copy_from_slice(&target_version);
            let converted = bitcoin::base58::encode_check(&decoded);
            let xpriv = Xpriv::from_str(&converted).ok()?;
            Some((xpriv, key_type.to_string(), net.to_string(), bip))
        }
        _ => None,
    }
}

pub fn detect_input_type(input: &str) -> BtcInputDetection {
    let input = input.trim();

    // 1. Check if it's a Bitcoin address
    let addr_info = validate_btc_address(input);
    if addr_info.valid {
        return BtcInputDetection {
            input_type: "address".to_string(),
            is_private: false,
            network: addr_info.network,
            suggested_bip: None,
            description: address_type_description(&addr_info.address_type).to_string(),
            valid: true,
            word_count: None,
            invalid_words: None,
        };
    }

    // 2. Check if it's an extended public key
    let xpub_info = validate_btc_xpub(input);
    if xpub_info.valid {
        let description = match xpub_info.key_type.as_str() {
            "xpub" => "BIP44 Extended Public Key (Legacy)",
            "ypub" => "BIP49 Extended Public Key (Wrapped SegWit)",
            "zpub" => "BIP84 Extended Public Key (Native SegWit)",
            "tpub" => "BIP44 Extended Public Key (Legacy, Testnet)",
            "upub" => "BIP49 Extended Public Key (Wrapped SegWit, Testnet)",
            "vpub" => "BIP84 Extended Public Key (Native SegWit, Testnet)",
            _ => "Extended Public Key",
        };
        return BtcInputDetection {
            input_type: xpub_info.key_type,
            is_private: false,
            network: xpub_info.network,
            suggested_bip: Some(xpub_info.suggested_bip),
            description: description.to_string(),
            valid: true,
            word_count: None,
            invalid_words: None,
        };
    }

    // 3. Check if it's a WIF private key
    if let Ok(pk) = PrivateKey::from_str(input) {
        return BtcInputDetection {
            input_type: "wif".to_string(),
            is_private: true,
            network: network_kind_str(pk.network).to_string(),
            suggested_bip: None,
            description: "WIF Private Key".to_string(),
            valid: true,
            word_count: None,
            invalid_words: None,
        };
    }

    // 4. Check if it's an extended private key
    if let Some((_xpriv, key_type, net, bip)) = try_parse_xprv(input) {
        let description = match key_type.as_str() {
            "xprv" => "BIP44 Extended Private Key (Legacy)",
            "yprv" => "BIP49 Extended Private Key (Wrapped SegWit)",
            "zprv" => "BIP84 Extended Private Key (Native SegWit)",
            "tprv" => "BIP44 Extended Private Key (Legacy, Testnet)",
            "uprv" => "BIP49 Extended Private Key (Wrapped SegWit, Testnet)",
            "vprv" => "BIP84 Extended Private Key (Native SegWit, Testnet)",
            _ => "Extended Private Key",
        };
        return BtcInputDetection {
            input_type: key_type,
            is_private: true,
            network: net,
            suggested_bip: Some(bip),
            description: description.to_string(),
            valid: true,
            word_count: None,
            invalid_words: None,
        };
    }

    // 5. Check if it's a seed phrase
    match bip39::Mnemonic::parse(input) {
        Ok(mnemonic) => {
            let word_count = mnemonic.word_count() as u32;
            return BtcInputDetection {
                input_type: "seed".to_string(),
                is_private: true,
                network: "unknown".to_string(),
                suggested_bip: Some(84),
                description: format!("BIP39 Seed Phrase ({word_count} words)"),
                valid: true,
                word_count: Some(word_count),
                invalid_words: None,
            };
        }
        Err(_) => {
            // Check if it looks like words (12-24 words)
            let words: Vec<&str> = input.split_whitespace().collect();
            if (12..=24).contains(&words.len()) {
                let invalid: Vec<String> = words
                    .iter()
                    .filter(|w| {
                        bip39::Language::English.find_word(w).is_none()
                    })
                    .map(|w| w.to_string())
                    .collect();
                if !invalid.is_empty() {
                    let word_count = words.len() as u32;
                    return BtcInputDetection {
                        input_type: "seed".to_string(),
                        is_private: true,
                        network: "unknown".to_string(),
                        suggested_bip: Some(84),
                        description: format!("BIP39 Seed Phrase ({word_count} words)"),
                        valid: false,
                        word_count: Some(word_count),
                        invalid_words: Some(invalid),
                    };
                }
                // All words valid but mnemonic still invalid (bad checksum)
                let word_count = words.len() as u32;
                return BtcInputDetection {
                    input_type: "seed".to_string(),
                    is_private: true,
                    network: "unknown".to_string(),
                    suggested_bip: Some(84),
                    description: format!("BIP39 Seed Phrase ({word_count} words)"),
                    valid: false,
                    word_count: Some(word_count),
                    invalid_words: None,
                };
            }
        }
    }

    // 6. Unknown
    BtcInputDetection {
        input_type: "unknown".to_string(),
        is_private: false,
        network: "unknown".to_string(),
        suggested_bip: None,
        description: "Unknown input".to_string(),
        valid: false,
        word_count: None,
        invalid_words: None,
    }
}

pub fn convert_wif_to_address(wif: &str) -> Result<PrivateKeyConversion, String> {
    let pk = PrivateKey::from_str(wif).map_err(|e| format!("invalid WIF: {e}"))?;
    let secp = Secp256k1::new();
    let pubkey = pk.public_key(&secp);
    let net_kind = pk.network;
    let net = network_kind_to_network(net_kind);

    if pk.compressed {
        // Compressed → P2WPKH (BIP84)
        let cpk =
            CompressedPublicKey::try_from(pubkey).map_err(|e| format!("compressed key: {e}"))?;
        let address = Address::p2wpkh(&cpk, net);
        Ok(PrivateKeyConversion {
            input_type: "wif".to_string(),
            public_result: PublicResult::Address {
                address: address.to_string(),
            },
            network: network_kind_str(net_kind).to_string(),
            suggested_bip: 84,
        })
    } else {
        // Uncompressed → P2PKH (BIP44)
        let address = Address::p2pkh(pubkey, net_kind);
        Ok(PrivateKeyConversion {
            input_type: "wif".to_string(),
            public_result: PublicResult::Address {
                address: address.to_string(),
            },
            network: network_kind_str(net_kind).to_string(),
            suggested_bip: 44,
        })
    }
}

/// Swap xpub/tpub version bytes to ypub/zpub/upub/vpub encoding.
fn encode_xpub_with_version(xpub: &Xpub, target_version: Option<[u8; 4]>) -> String {
    match target_version {
        None => xpub.to_string(),
        Some(version) => {
            let xpub_str = xpub.to_string();
            let mut decoded = bitcoin::base58::decode_check(&xpub_str)
                .expect("xpub encoding should be valid base58check");
            decoded[..4].copy_from_slice(&version);
            bitcoin::base58::encode_check(&decoded)
        }
    }
}

pub fn convert_xprv_to_xpub(xprv_str: &str) -> Result<PrivateKeyConversion, String> {
    let (xpriv, key_type, net, bip) =
        try_parse_xprv(xprv_str).ok_or_else(|| "invalid extended private key".to_string())?;

    let secp = Secp256k1::new();
    let xpub = Xpub::from_priv(&secp, &xpriv);

    // Determine output version bytes and key type
    let (pub_version, pub_key_type) = match key_type.as_str() {
        "xprv" => (None, "xpub"),
        "yprv" => (Some(YPUB_VERSION), "ypub"),
        "zprv" => (Some(ZPUB_VERSION), "zpub"),
        "tprv" => (None, "tpub"),
        "uprv" => (Some(UPUB_VERSION), "upub"),
        "vprv" => (Some(VPUB_VERSION), "vpub"),
        _ => return Err(format!("unsupported key type: {key_type}")),
    };

    let xpub_str = encode_xpub_with_version(&xpub, pub_version);

    Ok(PrivateKeyConversion {
        input_type: key_type,
        public_result: PublicResult::Xpub {
            xpub: xpub_str,
            key_type: pub_key_type.to_string(),
        },
        network: net,
        suggested_bip: bip,
    })
}

pub fn convert_seed_to_xpub(
    mnemonic_str: &str,
    passphrase: &str,
    bip: u32,
    network_str: &str,
) -> Result<PrivateKeyConversion, String> {
    let mnemonic =
        bip39::Mnemonic::parse(mnemonic_str).map_err(|e| format!("invalid mnemonic: {e}"))?;
    let seed = mnemonic.to_seed(passphrase);

    let network = match network_str {
        "mainnet" => Network::Bitcoin,
        "testnet" => Network::Testnet,
        _ => return Err(format!("unsupported network: {network_str}")),
    };

    let master = Xpriv::new_master(network, &seed).map_err(|e| format!("master key: {e}"))?;

    let secp = Secp256k1::new();
    let path = [
        ChildNumber::Hardened { index: bip },
        ChildNumber::Hardened { index: 0 },
        ChildNumber::Hardened { index: 0 },
    ];
    let derived = master
        .derive_priv(&secp, &path)
        .map_err(|e| format!("derivation error: {e}"))?;

    let xpub = Xpub::from_priv(&secp, &derived);

    // Determine output version bytes based on BIP and network
    let (pub_version, key_type) = match (bip, network_str) {
        (44, "mainnet") => (None, "xpub"),
        (44, "testnet") => (None, "tpub"),
        (49, "mainnet") => (Some(YPUB_VERSION), "ypub"),
        (49, "testnet") => (Some(UPUB_VERSION), "upub"),
        (84, "mainnet") => (Some(ZPUB_VERSION), "zpub"),
        (84, "testnet") => (Some(VPUB_VERSION), "vpub"),
        _ => (None, "xpub"),
    };

    let xpub_str = encode_xpub_with_version(&xpub, pub_version);

    Ok(PrivateKeyConversion {
        input_type: "seed".to_string(),
        public_result: PublicResult::Xpub {
            xpub: xpub_str,
            key_type: key_type.to_string(),
        },
        network: network_str.to_string(),
        suggested_bip: bip,
    })
}

pub fn convert_private_input(
    input: &str,
    bip: Option<u32>,
    passphrase: &str,
    network_str: &str,
) -> Result<PrivateKeyConversion, String> {
    let input = input.trim();

    // 1. Try WIF
    if let Ok(result) = convert_wif_to_address(input) {
        return Ok(result);
    }

    // 2. Try xprv/yprv/zprv
    if let Ok(result) = convert_xprv_to_xpub(input) {
        return Ok(result);
    }

    // 3. Try seed
    if bip39::Mnemonic::parse(input).is_ok() {
        return convert_seed_to_xpub(input, passphrase, bip.unwrap_or(84), network_str);
    }

    Err("unrecognized private key format".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_address() {
        let det = detect_input_type("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
        assert!(det.valid);
        assert_eq!(det.input_type, "address");
        assert!(!det.is_private);
        assert_eq!(det.network, "mainnet");
    }

    #[test]
    fn test_detect_xpub() {
        let det = detect_input_type("xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8");
        assert!(det.valid);
        assert_eq!(det.input_type, "xpub");
        assert!(!det.is_private);
    }

    #[test]
    fn test_detect_wif_compressed() {
        let det = detect_input_type("KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn");
        assert!(det.valid);
        assert_eq!(det.input_type, "wif");
        assert!(det.is_private);
        assert_eq!(det.network, "mainnet");
    }

    #[test]
    fn test_detect_wif_uncompressed() {
        let det = detect_input_type("5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ");
        assert!(det.valid);
        assert_eq!(det.input_type, "wif");
        assert!(det.is_private);
    }

    #[test]
    fn test_detect_seed_12() {
        let det = detect_input_type("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
        assert!(det.valid);
        assert_eq!(det.input_type, "seed");
        assert!(det.is_private);
        assert_eq!(det.word_count, Some(12));
    }

    #[test]
    fn test_detect_seed_invalid_word() {
        let det = detect_input_type("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon xyz123");
        assert!(!det.valid);
        assert_eq!(det.input_type, "seed");
        assert!(det.invalid_words.as_ref().unwrap().contains(&"xyz123".to_string()));
    }

    #[test]
    fn test_detect_xprv() {
        let det = detect_input_type("xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi");
        assert!(det.valid);
        assert_eq!(det.input_type, "xprv");
        assert!(det.is_private);
        assert_eq!(det.network, "mainnet");
    }

    #[test]
    fn test_detect_unknown() {
        let det = detect_input_type("hello world");
        assert!(!det.valid);
        assert_eq!(det.input_type, "unknown");
    }

    #[test]
    fn test_convert_wif_compressed() {
        let result = convert_wif_to_address("KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn");
        assert!(result.is_ok());
        let conv = result.unwrap();
        assert_eq!(conv.input_type, "wif");
        assert_eq!(conv.network, "mainnet");
        match &conv.public_result {
            PublicResult::Address { address } => {
                assert!(address.starts_with("bc1q"), "got: {address}");
            }
            _ => panic!("expected Address"),
        }
    }

    #[test]
    fn test_convert_wif_uncompressed() {
        let result = convert_wif_to_address("5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ");
        assert!(result.is_ok());
        let conv = result.unwrap();
        match &conv.public_result {
            PublicResult::Address { address } => {
                assert!(address.starts_with('1'), "got: {address}");
            }
            _ => panic!("expected Address"),
        }
    }

    #[test]
    fn test_convert_xprv_to_xpub() {
        let result = convert_xprv_to_xpub("xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi");
        assert!(result.is_ok());
        let conv = result.unwrap();
        assert_eq!(conv.input_type, "xprv");
        match &conv.public_result {
            PublicResult::Xpub { xpub, key_type } => {
                assert!(xpub.starts_with("xpub"));
                assert_eq!(key_type, "xpub");
                assert_eq!(xpub, "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8");
            }
            _ => panic!("expected Xpub"),
        }
    }

    #[test]
    fn test_convert_seed_to_xpub_bip84() {
        let mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let result = convert_seed_to_xpub(mnemonic, "", 84, "mainnet");
        assert!(result.is_ok());
        let conv = result.unwrap();
        assert_eq!(conv.suggested_bip, 84);
        match &conv.public_result {
            PublicResult::Xpub { xpub, key_type } => {
                assert!(xpub.starts_with("zpub"), "BIP84 should produce zpub, got: {xpub}");
                assert_eq!(key_type, "zpub");
            }
            _ => panic!("expected Xpub"),
        }
    }

    #[test]
    fn test_convert_seed_to_xpub_bip44() {
        let mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let result = convert_seed_to_xpub(mnemonic, "", 44, "mainnet");
        assert!(result.is_ok());
        let conv = result.unwrap();
        match &conv.public_result {
            PublicResult::Xpub { xpub, key_type } => {
                assert!(xpub.starts_with("xpub"), "BIP44 should produce xpub, got: {xpub}");
                assert_eq!(key_type, "xpub");
            }
            _ => panic!("expected Xpub"),
        }
    }

    #[test]
    fn test_convert_seed_to_xpub_bip49() {
        let mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let result = convert_seed_to_xpub(mnemonic, "", 49, "mainnet");
        assert!(result.is_ok());
        let conv = result.unwrap();
        match &conv.public_result {
            PublicResult::Xpub { xpub, key_type } => {
                assert!(xpub.starts_with("ypub"), "BIP49 should produce ypub, got: {xpub}");
                assert_eq!(key_type, "ypub");
            }
            _ => panic!("expected Xpub"),
        }
    }

    #[test]
    fn test_convert_private_input_dispatches() {
        // Should dispatch to WIF
        let r = convert_private_input("KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn", None, "", "mainnet");
        assert!(r.is_ok());
        assert_eq!(r.unwrap().input_type, "wif");

        // Should dispatch to xprv
        let r = convert_private_input("xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi", None, "", "mainnet");
        assert!(r.is_ok());
        assert_eq!(r.unwrap().input_type, "xprv");
    }

    #[test]
    fn test_network_detection_wif() {
        let det = detect_input_type("KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn");
        assert_eq!(det.network, "mainnet");
    }
}
