use bitcoin::bip32::{ChildNumber, Xpub};
use bitcoin::secp256k1::Secp256k1;
use bitcoin::{Address, CompressedPublicKey, Network, PublicKey};
use std::str::FromStr;

/// Derive addresses from an extended public key.
///
/// - `xpub_str`: the extended public key (xpub, ypub, zpub, tpub, upub, vpub)
/// - `bip`: the BIP standard (44, 49, 84, 86)
/// - `change`: 0 for receive, 1 for change
/// - `from_index`: starting child index
/// - `count`: number of addresses to derive
/// - `network`: Bitcoin or Testnet
pub fn derive_addresses(
    xpub_str: &str,
    bip: u32,
    change: u32,
    from_index: u32,
    count: u32,
    network: Network,
) -> Result<Vec<String>, String> {
    let secp = Secp256k1::verification_only();
    let xpub = parse_extended_key(xpub_str)?;

    let mut addresses = Vec::with_capacity(count as usize);
    for i in from_index..(from_index + count) {
        let child = xpub
            .derive_pub(
                &secp,
                &[
                    ChildNumber::Normal { index: change },
                    ChildNumber::Normal { index: i },
                ],
            )
            .map_err(|e| format!("derivation error: {e}"))?;

        let addr = match bip {
            44 => {
                let pk = PublicKey::new(child.public_key);
                let cpk = CompressedPublicKey::try_from(pk)
                    .map_err(|e| e.to_string())?;
                Address::p2pkh(cpk, network)
            }
            49 => {
                let pk = PublicKey::new(child.public_key);
                let cpk = CompressedPublicKey::try_from(pk)
                    .map_err(|e| e.to_string())?;
                Address::p2shwpkh(&cpk, network)
            }
            84 => {
                let pk = PublicKey::new(child.public_key);
                let cpk = CompressedPublicKey::try_from(pk)
                    .map_err(|e| e.to_string())?;
                Address::p2wpkh(&cpk, network)
            }
            86 => {
                let internal_key = child.public_key.x_only_public_key().0;
                Address::p2tr(&secp, internal_key, None, network)
            }
            _ => return Err(format!("unsupported BIP: {bip}")),
        };

        addresses.push(addr.to_string());
    }

    Ok(addresses)
}

/// Parse an extended public key string, handling xpub/ypub/zpub/tpub/upub/vpub formats.
///
/// For xpub/tpub, uses `bitcoin::bip32::Xpub::from_str()` directly.
/// For ypub/zpub/upub/vpub, swaps the version bytes to xpub/tpub format and re-parses.
fn parse_extended_key(key_str: &str) -> Result<Xpub, String> {
    if key_str.len() < 4 {
        return Err("key too short".to_string());
    }

    // For standard xpub/tpub, parse directly
    if key_str.starts_with("xpub") || key_str.starts_with("tpub") {
        return Xpub::from_str(key_str).map_err(|e| format!("invalid xpub: {e}"));
    }

    // For ypub/zpub/upub/vpub, swap version bytes to xpub/tpub format
    let target_version: [u8; 4] = match &key_str[..4] {
        "ypub" | "zpub" => [0x04, 0x88, 0xB2, 0x1E], // xpub version
        "upub" | "vpub" => [0x04, 0x35, 0x87, 0xCF], // tpub version
        other => return Err(format!("unknown key prefix: {other}")),
    };

    // Base58check decode
    let mut decoded =
        bitcoin::base58::decode_check(key_str).map_err(|e| format!("base58 decode error: {e}"))?;

    if decoded.len() != 78 {
        return Err(format!(
            "invalid extended key length: {} (expected 78)",
            decoded.len()
        ));
    }

    // Replace version bytes
    decoded[..4].copy_from_slice(&target_version);

    // Re-encode as base58check and parse
    let converted = bitcoin::base58::encode_check(&decoded);
    Xpub::from_str(&converted).map_err(|e| format!("invalid converted xpub: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // BIP32 test vector — master public key
    const TEST_XPUB: &str = "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8";

    #[test]
    fn test_derive_p2pkh_addresses() {
        let result = derive_addresses(TEST_XPUB, 44, 0, 0, 3, Network::Bitcoin);
        assert!(result.is_ok(), "derive failed: {:?}", result.err());
        let addrs = result.unwrap();
        assert_eq!(addrs.len(), 3);
        for addr in &addrs {
            assert!(
                addr.starts_with('1'),
                "P2PKH address should start with 1, got: {addr}"
            );
        }
    }

    #[test]
    fn test_derive_p2sh_addresses() {
        let result = derive_addresses(TEST_XPUB, 49, 0, 0, 3, Network::Bitcoin);
        assert!(result.is_ok(), "derive failed: {:?}", result.err());
        let addrs = result.unwrap();
        assert_eq!(addrs.len(), 3);
        for addr in &addrs {
            assert!(
                addr.starts_with('3'),
                "P2SH address should start with 3, got: {addr}"
            );
        }
    }

    #[test]
    fn test_derive_p2wpkh_addresses() {
        let result = derive_addresses(TEST_XPUB, 84, 0, 0, 3, Network::Bitcoin);
        assert!(result.is_ok(), "derive failed: {:?}", result.err());
        let addrs = result.unwrap();
        assert_eq!(addrs.len(), 3);
        for addr in &addrs {
            assert!(
                addr.starts_with("bc1q"),
                "P2WPKH address should start with bc1q, got: {addr}"
            );
        }
    }

    #[test]
    fn test_derive_p2tr_addresses() {
        let result = derive_addresses(TEST_XPUB, 86, 0, 0, 3, Network::Bitcoin);
        assert!(result.is_ok(), "derive failed: {:?}", result.err());
        let addrs = result.unwrap();
        assert_eq!(addrs.len(), 3);
        for addr in &addrs {
            assert!(
                addr.starts_with("bc1p"),
                "P2TR address should start with bc1p, got: {addr}"
            );
        }
    }

    #[test]
    fn test_derive_change_addresses() {
        let result = derive_addresses(TEST_XPUB, 84, 1, 0, 2, Network::Bitcoin);
        assert!(result.is_ok());
        let addrs = result.unwrap();
        assert_eq!(addrs.len(), 2);
        // Change addresses should be different from receive addresses
        let receive = derive_addresses(TEST_XPUB, 84, 0, 0, 2, Network::Bitcoin).unwrap();
        assert_ne!(addrs[0], receive[0]);
    }

    #[test]
    fn test_derive_with_offset() {
        let all = derive_addresses(TEST_XPUB, 84, 0, 0, 5, Network::Bitcoin).unwrap();
        let offset = derive_addresses(TEST_XPUB, 84, 0, 2, 3, Network::Bitcoin).unwrap();
        assert_eq!(offset[0], all[2]);
        assert_eq!(offset[1], all[3]);
        assert_eq!(offset[2], all[4]);
    }

    #[test]
    fn test_derive_unsupported_bip() {
        let result = derive_addresses(TEST_XPUB, 999, 0, 0, 1, Network::Bitcoin);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unsupported BIP"));
    }

    #[test]
    fn test_parse_invalid_key() {
        let result = derive_addresses("not-a-key", 84, 0, 0, 1, Network::Bitcoin);
        assert!(result.is_err());
    }

    #[test]
    fn test_derive_testnet() {
        // tpub is the testnet equivalent of xpub — we can't easily test without a real tpub,
        // but we can verify the function handles network correctly by using xpub with testnet
        // addresses (they'd be wrong BIP-wise but structurally valid)
        let result = derive_addresses(TEST_XPUB, 84, 0, 0, 1, Network::Testnet);
        assert!(result.is_ok());
        let addrs = result.unwrap();
        assert!(
            addrs[0].starts_with("tb1q"),
            "Testnet P2WPKH should start with tb1q, got: {}",
            addrs[0]
        );
    }
}
