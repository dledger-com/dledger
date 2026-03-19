/**
 * Unified address derivation — Tauri backend preferred, JS fallback for browser-only mode.
 *
 * The JS fallback uses audited @scure/@noble libraries for pure-JS derivation.
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
    return await deriveBtcAddressesJsFallback(xpub, bip, change, fromIndex, count, network);
  } catch (e) {
    throw new Error(
      "HD address derivation failed: " + (e instanceof Error ? e.message : String(e)),
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

// ---- JS fallback using @scure/@noble libraries ----

async function deriveBtcAddressesJsFallback(
  xpub: string,
  bip: number,
  change: number,
  fromIndex: number,
  count: number,
  network: "mainnet" | "testnet",
): Promise<string[]> {
  const { deriveBtcAddressesJs } = await import("./derive-js.js");
  return deriveBtcAddressesJs(xpub, bip, change, fromIndex, count, network);
}

/**
 * Detect the type of a Bitcoin-related input string (address, xpub, WIF, xprv, seed phrase).
 * Delegates to Rust for full validation; falls back to regex for non-Tauri environments.
 */
export async function detectBtcInputType(
  input: string,
): Promise<import("./types.js").BtcInputDetection> {
  if (hasTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke("detect_btc_input_type", { input });
  }
  // Enhanced fallback using @scure libraries for proper validation
  const { isValidBtcAddress, detectAddressNetwork, isValidBtcExtendedKey, detectKeyType } = await import("./validate.js");
  if (isValidBtcAddress(input)) {
    return {
      input_type: "address",
      is_private: false,
      network: detectAddressNetwork(input) as "mainnet" | "testnet" | "unknown",
      suggested_bip: null,
      description: "Bitcoin Address",
      valid: true,
      word_count: null,
      invalid_words: null,
    };
  }
  if (isValidBtcExtendedKey(input)) {
    const info = detectKeyType(input);
    return {
      input_type: info.type as any,
      is_private: false,
      network: info.network,
      suggested_bip: info.suggestedBip,
      description: `Extended Public Key (BIP${info.suggestedBip})`,
      valid: true,
      word_count: null,
      invalid_words: null,
    };
  }
  // Use @scure-based detection for private key types (seed, WIF, xprv)
  const { detectBtcInputTypeJs } = await import("./derive-js.js");
  const result = detectBtcInputTypeJs(input);
  if (result.input_type !== "unknown") return result;
  return {
    input_type: "unknown",
    is_private: false,
    network: "unknown",
    suggested_bip: null,
    description: "",
    valid: false,
    word_count: null,
    invalid_words: null,
  };
}

/**
 * Convert a private key input (WIF, xprv, seed phrase) to its public equivalent.
 * Uses Tauri backend when available, falls back to @scure/@noble JS libraries.
 */
export async function convertPrivateKey(
  input: string,
  bip?: number,
  passphrase?: string,
  network?: string,
): Promise<import("./types.js").PrivateKeyConversion> {
  if (hasTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke("convert_btc_private_key", {
      input,
      bip: bip ?? null,
      passphrase: passphrase ?? null,
      network: network ?? null,
    });
  }
  const { convertPrivateKeyJs } = await import("./derive-js.js");
  return convertPrivateKeyJs(input, bip ?? undefined, passphrase ?? undefined, network ?? undefined);
}
