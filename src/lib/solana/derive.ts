/**
 * Unified Solana derivation — Tauri backend preferred, JS fallback for browser-only mode.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hasTauri = (): boolean => !!(globalThis as any).__TAURI_INTERNALS__;

export type { DerivedSolAddress } from "./derive-js.js";

/**
 * Derive Solana addresses from a seed phrase.
 * Delegates to Rust when available, falls back to JS implementation.
 */
export async function deriveSolAddresses(
  mnemonic: string,
  count: number,
  passphrase?: string,
  startIndex?: number,
): Promise<import("./derive-js.js").DerivedSolAddress[]> {
  if (hasTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke("derive_sol_addresses", {
        mnemonic,
        count,
        passphrase: passphrase ?? null,
        startIndex: startIndex ?? 0,
      });
    } catch {
      // Fall through to JS
    }
  }

  const { deriveSolAddresses: deriveJs } = await import("./derive-js.js");
  return deriveJs(mnemonic, count, passphrase, startIndex);
}

/**
 * Validate a Solana address.
 */
export async function validateSolAddress(address: string): Promise<boolean> {
  if (hasTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke("validate_sol_address", { address });
    } catch {
      // Fall through to JS
    }
  }

  const { validateSolAddress: validateJs } = await import("./derive-js.js");
  return validateJs(address);
}

/**
 * Detect the type of a Solana-related input.
 */
export async function detectSolInputType(
  input: string,
): Promise<import("./types.js").SolInputDetection> {
  if (hasTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke("detect_sol_input_type", { input });
    } catch {
      // Fall through to JS
    }
  }

  const { detectSolInputType: detectJs } = await import("./derive-js.js");
  return detectJs(input);
}
