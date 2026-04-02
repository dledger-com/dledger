// Bitshares input detection — no derivation needed (named accounts, not derived addresses)

import type { InputDetection } from "../blockchain-registry.js";

/** Bitshares account names: lowercase, 3-63 chars, starts with letter, allows digits/dots/dashes. */
const BITSHARES_ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,62}$/;

/** Validate and classify user input as a Bitshares account name. */
export function detectBitsharesInputType(input: string): InputDetection {
  const s = input.trim();
  if (!s) return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };

  if (BITSHARES_ACCOUNT_RE.test(s)) {
    return { input_type: "address", is_private: false, valid: true, word_count: null, description: "Bitshares Account Name" };
  }

  return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
}
