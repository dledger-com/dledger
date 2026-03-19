use bitcoin::Network;
use tauri::State;

use crate::bitcoin_state::{BitcoinAccount, BitcoinState};
use dledger_core::bitcoin_addr::{self, BtcAddressInfo, BtcXpubInfo};
use dledger_core::bitcoin_derive;

#[tauri::command]
pub fn validate_btc_address(address: String) -> Result<BtcAddressInfo, String> {
    Ok(bitcoin_addr::validate_btc_address(&address))
}

#[tauri::command]
pub fn validate_btc_xpub(xpub: String) -> Result<BtcXpubInfo, String> {
    Ok(bitcoin_addr::validate_btc_xpub(&xpub))
}

#[tauri::command]
pub fn derive_btc_addresses(
    xpub: String,
    bip: u32,
    change: u32,
    from_index: u32,
    count: u32,
    network: String,
) -> Result<Vec<String>, String> {
    let net = match network.as_str() {
        "mainnet" => Network::Bitcoin,
        "testnet" => Network::Testnet,
        _ => return Err(format!("unsupported network: {network}")),
    };
    bitcoin_derive::derive_addresses(&xpub, bip, change, from_index, count, net)
}

#[tauri::command]
pub fn list_bitcoin_accounts(
    state: State<'_, BitcoinState>,
) -> Result<Vec<BitcoinAccount>, String> {
    state.list_accounts()
}

#[tauri::command]
pub fn add_bitcoin_account(
    state: State<'_, BitcoinState>,
    account: BitcoinAccount,
) -> Result<(), String> {
    state.add_account(&account)
}

#[tauri::command]
pub fn remove_bitcoin_account(state: State<'_, BitcoinState>, id: String) -> Result<(), String> {
    state.remove_account(&id)
}

#[tauri::command]
pub fn get_btc_tracked_addresses(
    state: State<'_, BitcoinState>,
    account_id: String,
) -> Result<Vec<String>, String> {
    state.get_tracked_addresses(&account_id)
}

#[tauri::command]
pub fn store_btc_derived_addresses(
    state: State<'_, BitcoinState>,
    account_id: String,
    addresses: Vec<(String, i32, i32)>,
) -> Result<(), String> {
    state.store_derived_addresses(&account_id, &addresses)
}

#[tauri::command]
pub fn update_btc_derivation_index(
    state: State<'_, BitcoinState>,
    account_id: String,
    receive_index: i32,
    change_index: i32,
) -> Result<(), String> {
    state.update_derivation_index(&account_id, receive_index, change_index)
}
