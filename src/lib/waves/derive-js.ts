// Waves address detection.
// Mainnet addresses are Base58-encoded, start with "3P" (chain ID byte 'W' = 87 = 0x57),
// and are 35 characters long. Full BIP39 seed derivation is out of scope for v1.

import type { WavesInputDetection } from "./types.js";

const WAVES_ADDRESS_RE = /^3P[1-9A-HJ-NP-Za-km-z]{33}$/;

/** Validate a Waves mainnet address by format only (no checksum). */
export function validateWavesAddress(address: string): boolean {
  return WAVES_ADDRESS_RE.test(address);
}

export function detectWavesInputType(input: string): WavesInputDetection {
  const s = input.trim();
  if (!s) return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };

  // Seed phrase: Waves uses BIP39 12/15/18/21/24-word phrases.
  const words = s.split(/\s+/);
  if (words.length >= 12 && words.length <= 24 && /^[a-z]+(\s+[a-z]+){11,23}$/.test(s)) {
    const wordCount = words.length;
    const valid = [12, 15, 18, 21, 24].includes(wordCount);
    return {
      input_type: "seed",
      is_private: true,
      valid,
      word_count: wordCount,
      description: `Seed phrase (${wordCount} words) — derivation not yet supported`,
    };
  }

  if (WAVES_ADDRESS_RE.test(s)) {
    return { input_type: "address", is_private: false, valid: true, word_count: null, description: "Waves Address" };
  }

  return { input_type: "unknown", is_private: false, valid: false, word_count: null, description: "" };
}
