/**
 * Unified address derivation — Tauri backend preferred, JS fallback for browser-only mode.
 *
 * In the current implementation only the Tauri path is wired. The JS fallback
 * stub throws so that callers know they need to install the optional
 * `bitcoinjs-lib` / `bip32` / `tiny-secp256k1` packages if running without Tauri.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hasTauri = (): boolean => !!(globalThis as any).__TAURI_INTERNALS__;

/**
 * Derive child addresses from an extended public key.
 *
 * Delegates to the Rust `derive_btc_addresses` Tauri command when available,
 * otherwise falls back to a JS implementation (requires optional deps).
 */
export async function deriveAddresses(
  xpub: string,
  bip: number,
  change: number,
  fromIndex: number,
  count: number,
  network: "mainnet" | "testnet",
): Promise<string[]> {
  if (hasTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string[]>("derive_btc_addresses", {
      xpub,
      bip,
      change,
      fromIndex,
      count,
      network,
    });
  }

  // JS fallback — attempt dynamic import of optional deps
  try {
    return await deriveBtcAddressesJs(xpub, bip, change, fromIndex, count, network);
  } catch {
    throw new Error(
      "HD address derivation requires the Tauri backend or optional JS dependencies (bitcoinjs-lib, bip32, tiny-secp256k1). " +
      "Install them with: bun add bitcoinjs-lib bip32 tiny-secp256k1",
    );
  }
}

/**
 * Validate a Bitcoin address.
 */
export async function validateAddress(
  address: string,
): Promise<{ valid: boolean; network: string; address_type: string }> {
  if (hasTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke("validate_btc_address", { address });
  }
  // Fallback to regex validation
  const { isValidBtcAddress, detectAddressNetwork } = await import("./validate.js");
  return {
    valid: isValidBtcAddress(address),
    network: detectAddressNetwork(address),
    address_type: "unknown",
  };
}

/**
 * Validate an extended public key (xpub/ypub/zpub).
 */
export async function validateXpub(
  xpub: string,
): Promise<{ valid: boolean; key_type: string; network: string; suggested_bip: number }> {
  if (hasTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke("validate_btc_xpub", { xpub });
  }
  // Fallback to regex validation
  const { isValidBtcExtendedKey, detectKeyType } = await import("./validate.js");
  const info = detectKeyType(xpub);
  return {
    valid: isValidBtcExtendedKey(xpub),
    key_type: info.type,
    network: info.network,
    suggested_bip: info.suggestedBip,
  };
}

// ---- JS fallback (requires optional deps) ----

async function deriveBtcAddressesJs(
  _xpub: string,
  _bip: number,
  _change: number,
  _fromIndex: number,
  _count: number,
  _network: "mainnet" | "testnet",
): Promise<string[]> {
  // This would use bitcoinjs-lib + bip32 + tiny-secp256k1 if installed.
  // For now, throw to indicate the deps are needed.
  throw new Error("JS derivation not implemented — install optional dependencies");
}
