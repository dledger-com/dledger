import type Decimal from "decimal.js-light";
import type { Backend } from "../backend.js";
import type { AppSettings } from "../data/settings.svelte.js";
import type {
  JournalEntry,
  LineItem,
  ChainInfo,
} from "../types/index.js";
import type {
  TxHashGroup,
} from "../browser-etherscan.js";

export type { TxHashGroup, NormalTx, InternalTx, Erc20Tx, Erc721Tx, Erc1155Tx } from "../browser-etherscan.js";

export interface TransactionHandler {
  id: string;
  name: string;
  description: string;
  /** Chains this handler supports (empty = all chains) */
  supportedChainIds: number[];

  /** 0 = cannot handle, 1-100 = confidence (higher = more specific) */
  match(group: TxHashGroup, ctx: HandlerContext): number;

  /** Interpret the transaction group into ledger entries */
  process(group: TxHashGroup, ctx: HandlerContext): Promise<HandlerResult>;
}

export interface HandlerContext {
  address: string;
  chainId: number;
  label: string;
  chain: ChainInfo;
  backend: Backend;
  settings: AppSettings;
  ensureAccount(fullName: string, date: string): Promise<string>;
  ensureCurrency(code: string, decimals: number): Promise<void>;
}

export type HandlerResult =
  | { type: "entries"; entries: HandlerEntry[] }
  | { type: "skip"; reason: string }
  | { type: "review"; entries: HandlerEntry[]; reason: string };

export interface HandlerEntry {
  entry: Omit<JournalEntry, "id" | "created_at">;
  items: Omit<LineItem, "id" | "journal_entry_id">[];
  metadata: Record<string, string>;
}
