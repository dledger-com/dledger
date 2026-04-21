// Wanchain address detection — reuses EVM detection logic.
// Seeds can derive Wanchain addresses via the standard Ethereum BIP44 path.

import { detectEvmInputType } from "../evm/derive.js";
import type { WanchainInputDetection } from "./types.js";

export function detectWanchainInputType(input: string): WanchainInputDetection {
  const d = detectEvmInputType(input);
  const mapped: "address" | "seed" | "unknown" =
    d.type === "address" ? "address" :
    d.type === "seed" ? "seed" :
    "unknown";
  return {
    input_type: mapped,
    is_private: d.isPrivate,
    valid: d.type !== "unknown",
    word_count: null,
    description: d.description,
  };
}
