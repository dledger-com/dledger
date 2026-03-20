import type { Backend } from "../../backend.js";
import type { AppSettings } from "../../data/settings.svelte.js";
import type { HandlerResult } from "../../handlers/types.js";
import type { SolTxGroup } from "../types.js";

export interface SolanaHandler {
  id: string;
  name: string;
  description: string;

  /** 0 = cannot handle, 1-100 = confidence (higher = more specific) */
  match(tx: SolTxGroup, ctx: SolanaHandlerContext): number;

  /** Interpret the Solana transaction into ledger entries */
  process(tx: SolTxGroup, ctx: SolanaHandlerContext): Promise<HandlerResult>;
}

export interface SolanaHandlerContext {
  address: string;
  label: string;
  backend: Backend;
  settings: AppSettings;
  ensureAccount(fullName: string, date: string): Promise<string>;
  ensureCurrency(code: string, decimals: number, mintAddress?: string): Promise<void>;
}
