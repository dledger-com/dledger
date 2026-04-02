import type {
  Account,
  Currency,
  JournalEntry,
  LineItem,
  TransactionFilter,
  CurrencyBalance,
  TrialBalance,
  IncomeStatement,
  BalanceSheet,
  GainLossReport,
  ExchangeRate,
  LedgerImportResult,
  EtherscanAccount,
  EtherscanSyncResult,
  CurrencyOrigin,
  BalanceAssertion,
  BalanceAssertionResult,
  OpenLot,
  Budget,
} from "./types/index.js";
import type { BitcoinAccount, BitcoinSyncResult } from "./bitcoin/types.js";
import type { SolanaAccount, SolanaSyncResult } from "./solana/types.js";
import type { HyperliquidAccount, HyperliquidSyncResult } from "./hyperliquid/types.js";
import type { SuiAccount, SuiSyncResult } from "./sui/types.js";
import type { AptosAccount, AptosSyncResult } from "./aptos/types.js";
import type { TonAccount, TonSyncResult } from "./ton/types.js";
import type { TezosAccount, TezosSyncResult } from "./tezos/types.js";
import type { CosmosAccount, CosmosSyncResult } from "./cosmos/types.js";
import type { PolkadotAccount, PolkadotSyncResult } from "./polkadot/types.js";
import type { BtcForkAccount, BtcForkSyncResult } from "./btc-fork/types.js";
import type { XrpAccount, XrpSyncResult } from "./xrp/types.js";
import type { TronAccount, TronSyncResult } from "./tron/types.js";
import type { StellarAccount, StellarSyncResult } from "./stellar/types.js";
import type { BittensorAccount, BittensorSyncResult } from "./bittensor/types.js";
import type { HederaAccount, HederaSyncResult } from "./hedera/types.js";
import type { NearAccount, NearSyncResult } from "./near/types.js";
import type { AlgorandAccount, AlgorandSyncResult } from "./algorand/types.js";
import type { KaspaAccount, KaspaSyncResult } from "./kaspa/types.js";
import type { ZcashAccount, ZcashSyncResult } from "./zcash/types.js";
import type { StacksAccount, StacksSyncResult } from "./stacks/types.js";
import type { CardanoAccount, CardanoSyncResult } from "./cardano/types.js";
import type { MoneroAccount, MoneroSyncResult } from "./monero/types.js";
import type { BitsharesAccount, BitsharesSyncResult } from "./bitshares/types.js";
import type { ExchangeAccount } from "./cex/types.js";
import type { LedgerFormat } from "./ledger-format.js";
import type { LedgerImportOptions } from "./browser-ledger-file.js";
import type { PersistedFrenchTaxReport, FrenchTaxReport } from "./utils/french-tax.js";
import type { CustomPluginRecord } from "./plugins/custom-plugins.js";

export interface Reconciliation {
  id: string;
  account_id: string;
  statement_date: string;
  statement_balance: string;
  currency: string;
  reconciled_at: string;
  line_item_count: number;
}

export interface UnreconciledLineItem {
  line_item_id: string;
  entry_id: string;
  entry_date: string;
  entry_description: string;
  account_id: string;
  currency: string;
  amount: string;
  is_reconciled: boolean;
}

export interface CurrencyRateSource {
  currency: string;
  asset_type?: string;
  param?: string;
  rate_source: string | null; // null = auto-detect needed
  rate_source_id: string;     // dprice asset ID (or empty)
  set_by: string;             // "user" | "handler:<id>" | "auto"
  updated_at: string;
}

export interface CurrencyDateRequirement {
  currency: string;
  mode: "range" | "dates";
  firstDate: string;   // YYYY-MM-DD
  lastDate: string;
  hasBalance: boolean;  // net balance != 0 → extend to today
  dates: string[];      // populated when mode="dates"
}

export interface Backend {
  // Currencies
  listCurrencies(): Promise<Currency[]>;
  createCurrency(currency: Currency): Promise<void>;
  setCurrencyAssetType(code: string, assetType: string, param?: string): Promise<void>;

  // Accounts
  listAccounts(): Promise<Account[]>;
  getAccount(id: string): Promise<Account | null>;
  createAccount(account: Account): Promise<void>;
  archiveAccount(id: string): Promise<void>;
  unarchiveAccount(id: string): Promise<void>;
  updateAccount(id: string, updates: { full_name?: string; is_postable?: boolean; opened_at?: string | null }): Promise<void>;

  // Journal entries
  postJournalEntry(entry: JournalEntry, items: LineItem[]): Promise<void>;
  voidJournalEntry(id: string): Promise<JournalEntry>;
  editJournalEntry(
    originalId: string,
    newEntry: JournalEntry,
    newItems: LineItem[],
    newMetadata?: Record<string, string>,
    newLinks?: string[],
  ): Promise<{ reversalId: string; newEntryId: string }>;
  getJournalEntry(id: string): Promise<[JournalEntry, LineItem[]] | null>;
  queryJournalEntries(filter: TransactionFilter): Promise<[JournalEntry, LineItem[]][]>;
  queryJournalEntriesOnly?(filter: TransactionFilter, onProgress?: (current: number, total: number) => void, signal?: AbortSignal): Promise<JournalEntry[]>;
  getLineItemsForEntries?(entryIds: string[]): Promise<Map<string, LineItem[]>>;
  getJournalChartAggregation?(filter: TransactionFilter): Promise<{ date: string; income: number; expense: number }[]>;
  countJournalEntries(filter: TransactionFilter): Promise<number>;

  // Balances
  getAccountBalance(accountId: string, asOf?: string): Promise<CurrencyBalance[]>;
  getAccountBalanceWithChildren(accountId: string, asOf?: string): Promise<CurrencyBalance[]>;

  // Reports
  trialBalance(asOf: string): Promise<TrialBalance>;
  incomeStatement(fromDate: string, toDate: string, signal?: AbortSignal): Promise<IncomeStatement>;
  balanceSheet(asOf: string, signal?: AbortSignal): Promise<BalanceSheet>;
  balanceSheetBatch(dates: string[], signal?: AbortSignal): Promise<Map<string, BalanceSheet>>;
  gainLossReport(fromDate: string, toDate: string): Promise<GainLossReport>;
  listOpenLots(): Promise<OpenLot[]>;

  // Budgets
  createBudget(budget: Budget): Promise<void>;
  listBudgets(): Promise<Budget[]>;
  updateBudget(budget: Budget): Promise<void>;
  deleteBudget(id: string): Promise<void>;

  // Exchange rates
  recordExchangeRate(rate: ExchangeRate): Promise<void>;
  recordExchangeRateBatch?(rates: ExchangeRate[]): Promise<void>;
  getExchangeRate(from: string, to: string, date: string): Promise<string | null>;
  getExchangeRatesBatch?(pairs: { currency: string; date: string }[], baseCurrency: string): Promise<Map<string, boolean>>;
  getExchangeRatesBatchExact?(pairs: { currency: string; date: string }[], baseCurrency: string): Promise<Map<string, boolean>>;
  getExchangeRateCurrenciesOnDate?(date: string): Promise<string[]>;
  listExchangeRates(from?: string, to?: string): Promise<ExchangeRate[]>;

  // Auto-backfill: determine which currencies need rates and for which dates
  getCurrencyDateRequirements?(baseCurrency: string): Promise<CurrencyDateRequirement[]>;

  // Ledger file import/export
  importLedgerFile(content: string, format?: LedgerFormat, options?: LedgerImportOptions): Promise<LedgerImportResult>;
  exportLedgerFile(format?: LedgerFormat): Promise<string>;

  // Etherscan
  listEtherscanAccounts(): Promise<EtherscanAccount[]>;
  addEtherscanAccount(address: string, chainId: number, label: string): Promise<void>;
  removeEtherscanAccount(address: string, chainId: number): Promise<void>;
  syncEtherscan(apiKey: string, address: string, label: string, chainId: number): Promise<EtherscanSyncResult>;
  syncTheGraph(apiKey: string, address: string, label: string, chainId: number): Promise<EtherscanSyncResult>;

  // Bitcoin
  listBitcoinAccounts(): Promise<BitcoinAccount[]>;
  addBitcoinAccount(account: Omit<BitcoinAccount, "last_sync">): Promise<void>;
  removeBitcoinAccount(id: string): Promise<void>;
  getBtcTrackedAddresses(accountId: string): Promise<string[]>;
  storeBtcDerivedAddresses(accountId: string, addresses: Array<{address: string; change: number; index: number}>): Promise<void>;
  updateBtcDerivationIndex(accountId: string, receiveIndex: number, changeIndex: number): Promise<void>;
  updateBitcoinAccountLabel(id: string, label: string): Promise<void>;
  syncBitcoin(account: BitcoinAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<BitcoinSyncResult>;

  // Solana
  listSolanaAccounts(): Promise<SolanaAccount[]>;
  addSolanaAccount(account: Omit<SolanaAccount, "last_sync">): Promise<void>;
  removeSolanaAccount(id: string): Promise<void>;
  updateSolanaAccountLabel(id: string, label: string): Promise<void>;
  updateSolanaLastSignature(id: string, signature: string): Promise<void>;
  syncSolana(account: SolanaAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<SolanaSyncResult>;

  // Hyperliquid
  listHyperliquidAccounts(): Promise<HyperliquidAccount[]>;
  addHyperliquidAccount(account: Omit<HyperliquidAccount, "last_sync" | "last_sync_time">): Promise<void>;
  removeHyperliquidAccount(id: string): Promise<void>;
  updateHyperliquidAccountLabel(id: string, label: string): Promise<void>;
  updateHyperliquidSyncCursor(id: string, lastSyncTime: number): Promise<void>;
  syncHyperliquid(account: HyperliquidAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<HyperliquidSyncResult>;

  // Sui
  listSuiAccounts(): Promise<SuiAccount[]>;
  addSuiAccount(account: Omit<SuiAccount, "last_sync" | "last_cursor">): Promise<void>;
  removeSuiAccount(id: string): Promise<void>;
  updateSuiAccountLabel(id: string, label: string): Promise<void>;
  updateSuiSyncCursor(id: string, cursor: string): Promise<void>;
  syncSui(account: SuiAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<SuiSyncResult>;

  // Aptos
  listAptosAccounts(): Promise<AptosAccount[]>;
  addAptosAccount(account: Omit<AptosAccount, "last_sync" | "last_version">): Promise<void>;
  removeAptosAccount(id: string): Promise<void>;
  updateAptosAccountLabel(id: string, label: string): Promise<void>;
  updateAptosSyncVersion(id: string, version: number): Promise<void>;
  syncAptos(account: AptosAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<AptosSyncResult>;

  // TON
  listTonAccounts(): Promise<TonAccount[]>;
  addTonAccount(account: Omit<TonAccount, "last_sync" | "last_lt">): Promise<void>;
  removeTonAccount(id: string): Promise<void>;
  updateTonAccountLabel(id: string, label: string): Promise<void>;
  updateTonSyncCursor(id: string, lt: string): Promise<void>;
  syncTon(account: TonAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<TonSyncResult>;

  // Tezos
  listTezosAccounts(): Promise<TezosAccount[]>;
  addTezosAccount(account: Omit<TezosAccount, "last_sync" | "last_id">): Promise<void>;
  removeTezosAccount(id: string): Promise<void>;
  updateTezosAccountLabel(id: string, label: string): Promise<void>;
  updateTezosSyncCursor(id: string, lastId: number): Promise<void>;
  syncTezos(account: TezosAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<TezosSyncResult>;

  // Cosmos
  listCosmosAccounts(): Promise<CosmosAccount[]>;
  addCosmosAccount(account: Omit<CosmosAccount, "last_sync" | "last_offset">): Promise<void>;
  removeCosmosAccount(id: string): Promise<void>;
  updateCosmosAccountLabel(id: string, label: string): Promise<void>;
  updateCosmosSyncOffset(id: string, offset: number): Promise<void>;
  syncCosmos(account: CosmosAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<CosmosSyncResult>;

  // Polkadot
  listPolkadotAccounts(): Promise<PolkadotAccount[]>;
  addPolkadotAccount(account: Omit<PolkadotAccount, "last_sync" | "last_page">): Promise<void>;
  removePolkadotAccount(id: string): Promise<void>;
  updatePolkadotAccountLabel(id: string, label: string): Promise<void>;
  updatePolkadotSyncPage(id: string, page: number): Promise<void>;
  syncPolkadot(account: PolkadotAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<PolkadotSyncResult>;

  // Dogecoin
  listDogeAccounts(): Promise<BtcForkAccount[]>;
  addDogeAccount(account: Omit<BtcForkAccount, "last_sync" | "chain">): Promise<void>;
  removeDogeAccount(id: string): Promise<void>;
  updateDogeAccountLabel(id: string, label: string): Promise<void>;
  updateDogeSyncTimestamp(id: string): Promise<void>;
  syncDoge(account: BtcForkAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<BtcForkSyncResult>;

  // Litecoin
  listLtcAccounts(): Promise<BtcForkAccount[]>;
  addLtcAccount(account: Omit<BtcForkAccount, "last_sync" | "chain">): Promise<void>;
  removeLtcAccount(id: string): Promise<void>;
  updateLtcAccountLabel(id: string, label: string): Promise<void>;
  updateLtcSyncTimestamp(id: string): Promise<void>;
  syncLtc(account: BtcForkAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<BtcForkSyncResult>;

  // Bitcoin Cash
  listBchAccounts(): Promise<BtcForkAccount[]>;
  addBchAccount(account: Omit<BtcForkAccount, "last_sync" | "chain">): Promise<void>;
  removeBchAccount(id: string): Promise<void>;
  updateBchAccountLabel(id: string, label: string): Promise<void>;
  updateBchSyncTimestamp(id: string): Promise<void>;
  syncBch(account: BtcForkAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<BtcForkSyncResult>;

  // Dash
  listDashAccounts(): Promise<BtcForkAccount[]>;
  addDashAccount(account: Omit<BtcForkAccount, "last_sync" | "chain">): Promise<void>;
  removeDashAccount(id: string): Promise<void>;
  updateDashAccountLabel(id: string, label: string): Promise<void>;
  updateDashSyncTimestamp(id: string): Promise<void>;
  syncDash(account: BtcForkAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<BtcForkSyncResult>;

  // Bitcoin SV
  listBsvAccounts(): Promise<BtcForkAccount[]>;
  addBsvAccount(account: Omit<BtcForkAccount, "last_sync" | "chain">): Promise<void>;
  removeBsvAccount(id: string): Promise<void>;
  updateBsvAccountLabel(id: string, label: string): Promise<void>;
  updateBsvSyncTimestamp(id: string): Promise<void>;
  syncBsv(account: BtcForkAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<BtcForkSyncResult>;

  // eCash
  listXecAccounts(): Promise<BtcForkAccount[]>;
  addXecAccount(account: Omit<BtcForkAccount, "last_sync" | "chain">): Promise<void>;
  removeXecAccount(id: string): Promise<void>;
  updateXecAccountLabel(id: string, label: string): Promise<void>;
  updateXecSyncTimestamp(id: string): Promise<void>;
  syncXec(account: BtcForkAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<BtcForkSyncResult>;

  // Groestlcoin
  listGrsAccounts(): Promise<BtcForkAccount[]>;
  addGrsAccount(account: Omit<BtcForkAccount, "last_sync" | "chain">): Promise<void>;
  removeGrsAccount(id: string): Promise<void>;
  updateGrsAccountLabel(id: string, label: string): Promise<void>;
  updateGrsSyncTimestamp(id: string): Promise<void>;
  syncGrs(account: BtcForkAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<BtcForkSyncResult>;

  // XRP
  listXrpAccounts(): Promise<XrpAccount[]>;
  addXrpAccount(account: Omit<XrpAccount, "last_sync" | "last_marker">): Promise<void>;
  removeXrpAccount(id: string): Promise<void>;
  updateXrpAccountLabel(id: string, label: string): Promise<void>;
  updateXrpSyncMarker(id: string, marker: string): Promise<void>;
  syncXrp(account: XrpAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<XrpSyncResult>;

  // TRON
  listTronAccounts(): Promise<TronAccount[]>;
  addTronAccount(account: Omit<TronAccount, "last_sync" | "last_fingerprint">): Promise<void>;
  removeTronAccount(id: string): Promise<void>;
  updateTronAccountLabel(id: string, label: string): Promise<void>;
  updateTronSyncFingerprint(id: string, fingerprint: string): Promise<void>;
  syncTron(account: TronAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<TronSyncResult>;

  // Stellar
  listStellarAccounts(): Promise<StellarAccount[]>;
  addStellarAccount(account: Omit<StellarAccount, "last_sync" | "last_cursor">): Promise<void>;
  removeStellarAccount(id: string): Promise<void>;
  updateStellarAccountLabel(id: string, label: string): Promise<void>;
  updateStellarSyncCursor(id: string, cursor: string): Promise<void>;
  syncStellar(account: StellarAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<StellarSyncResult>;

  // Bittensor
  listBittensorAccounts(): Promise<BittensorAccount[]>;
  addBittensorAccount(account: Omit<BittensorAccount, "last_sync" | "last_page">): Promise<void>;
  removeBittensorAccount(id: string): Promise<void>;
  updateBittensorAccountLabel(id: string, label: string): Promise<void>;
  updateBittensorSyncPage(id: string, page: number): Promise<void>;
  syncBittensor(account: BittensorAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<BittensorSyncResult>;

  // Hedera
  listHederaAccounts(): Promise<HederaAccount[]>;
  addHederaAccount(account: Omit<HederaAccount, "last_sync" | "last_timestamp">): Promise<void>;
  removeHederaAccount(id: string): Promise<void>;
  updateHederaAccountLabel(id: string, label: string): Promise<void>;
  updateHederaSyncCursor(id: string, timestamp: string): Promise<void>;
  syncHedera(account: HederaAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<HederaSyncResult>;

  // NEAR
  listNearAccounts(): Promise<NearAccount[]>;
  addNearAccount(account: Omit<NearAccount, "last_sync" | "last_cursor">): Promise<void>;
  removeNearAccount(id: string): Promise<void>;
  updateNearAccountLabel(id: string, label: string): Promise<void>;
  updateNearSyncCursor(id: string, cursor: string): Promise<void>;
  syncNear(account: NearAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<NearSyncResult>;

  // Algorand
  listAlgorandAccounts(): Promise<AlgorandAccount[]>;
  addAlgorandAccount(account: Omit<AlgorandAccount, "last_sync" | "next_token">): Promise<void>;
  removeAlgorandAccount(id: string): Promise<void>;
  updateAlgorandAccountLabel(id: string, label: string): Promise<void>;
  updateAlgorandSyncCursor(id: string, token: string): Promise<void>;
  syncAlgorand(account: AlgorandAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<AlgorandSyncResult>;

  // Kaspa
  listKaspaAccounts(): Promise<KaspaAccount[]>;
  addKaspaAccount(account: Omit<KaspaAccount, "last_sync" | "last_cursor">): Promise<void>;
  removeKaspaAccount(id: string): Promise<void>;
  updateKaspaAccountLabel(id: string, label: string): Promise<void>;
  updateKaspaSyncCursor(id: string, cursor: string): Promise<void>;
  syncKaspa(account: KaspaAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<KaspaSyncResult>;

  // Zcash
  listZcashAccounts(): Promise<ZcashAccount[]>;
  addZcashAccount(account: Omit<ZcashAccount, "last_sync" | "last_cursor">): Promise<void>;
  removeZcashAccount(id: string): Promise<void>;
  updateZcashAccountLabel(id: string, label: string): Promise<void>;
  updateZcashSyncCursor(id: string, cursor: string): Promise<void>;
  syncZcash(account: ZcashAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<ZcashSyncResult>;

  // Stacks
  listStacksAccounts(): Promise<StacksAccount[]>;
  addStacksAccount(account: Omit<StacksAccount, "last_sync" | "last_offset">): Promise<void>;
  removeStacksAccount(id: string): Promise<void>;
  updateStacksAccountLabel(id: string, label: string): Promise<void>;
  updateStacksSyncOffset(id: string, offset: number): Promise<void>;
  syncStacks(account: StacksAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<StacksSyncResult>;

  // Cardano
  listCardanoAccounts(): Promise<CardanoAccount[]>;
  addCardanoAccount(account: Omit<CardanoAccount, "last_sync" | "last_page">): Promise<void>;
  removeCardanoAccount(id: string): Promise<void>;
  updateCardanoAccountLabel(id: string, label: string): Promise<void>;
  updateCardanoSyncPage(id: string, page: number): Promise<void>;
  syncCardano(account: CardanoAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<CardanoSyncResult>;

  // Monero
  listMoneroAccounts(): Promise<MoneroAccount[]>;
  addMoneroAccount(account: Omit<MoneroAccount, "last_sync" | "last_sync_height">): Promise<void>;
  removeMoneroAccount(id: string): Promise<void>;
  updateMoneroAccountLabel(id: string, label: string): Promise<void>;
  updateMoneroSyncHeight(id: string, height: number): Promise<void>;
  syncMonero(account: MoneroAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<MoneroSyncResult>;

  // Bitshares
  listBitsharesAccounts(): Promise<BitsharesAccount[]>;
  addBitsharesAccount(account: Omit<BitsharesAccount, "last_sync" | "last_operation_id">): Promise<void>;
  removeBitsharesAccount(id: string): Promise<void>;
  updateBitsharesAccountLabel(id: string, label: string): Promise<void>;
  updateBitsharesAccountObjectId(id: string, objectId: string): Promise<void>;
  updateBitsharesSyncCursor(id: string, operationId: string): Promise<void>;
  syncBitshares(account: BitsharesAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<BitsharesSyncResult>;

  // Exchange accounts (CEX)
  listExchangeAccounts(): Promise<ExchangeAccount[]>;
  addExchangeAccount(account: ExchangeAccount): Promise<void>;
  updateExchangeAccount(id: string, updates: Partial<ExchangeAccount>): Promise<void>;
  removeExchangeAccount(id: string): Promise<void>;

  // Metadata
  setMetadata(entryId: string, entries: Record<string, string>): Promise<void>;
  getMetadata(entryId: string): Promise<Record<string, string>>;
  queryEntriesByMetadata(key: string, value: string): Promise<string[]>;
  getAllTagValues(): Promise<string[]>;
  getAllMetadataKeys(): Promise<string[]>;

  // Batch metadata/links (for virtual scrolling visible-range loading)
  getMetadataBatch?(entryIds: string[]): Promise<Map<string, Record<string, string>>>;
  getEntryLinksBatch?(entryIds: string[]): Promise<Map<string, string[]>>;

  // Entry links
  setEntryLinks(entryId: string, links: string[]): Promise<void>;
  getEntryLinks(entryId: string): Promise<string[]>;
  getEntriesByLink(linkName: string): Promise<string[]>;
  getAllLinkNames(): Promise<string[]>;
  getAllLinksWithCounts(): Promise<Array<{ link_name: string; entry_count: number }>>;

  // Account metadata
  setAccountMetadata(accountId: string, entries: Record<string, string>): Promise<void>;
  getAccountMetadata(accountId: string): Promise<Record<string, string>>;

  // Raw transactions
  storeRawTransaction(source: string, data: string): Promise<void>;
  getRawTransaction(source: string): Promise<string | null>;
  queryRawTransactions(sourcePrefix: string): Promise<Array<{ source: string; data: string }>>;

  // Crypto asset info
  listCryptoAssetInfo(): Promise<Map<string, string>>;
  setCryptoAssetCoingeckoId(code: string, geckoId: string): Promise<void>;

  // Currency origins
  getCurrencyOrigins(): Promise<CurrencyOrigin[]>;

  // Currency rate source management
  getCurrencyRateSources(): Promise<CurrencyRateSource[]>;
  setCurrencyRateSource(currency: string, rateSource: string | null, setBy: string, rateSourceId?: string): Promise<boolean>;
  clearAutoRateSources(): Promise<void>;
  clearNonUserRateSources(): Promise<void>;

  // Currency token addresses (for DeFi pricing via DefiLlama)
  setCurrencyTokenAddress(currency: string, chain: string, contractAddress: string): Promise<void>;
  getCurrencyTokenAddresses(): Promise<Array<{ currency: string; chain: string; contract_address: string }>>;
  getCurrencyTokenAddress(currency: string): Promise<{ chain: string; contract_address: string } | null>;

  // Currency management
  setCurrencyName(code: string, name: string): Promise<void>;
  setCurrencyHidden(code: string, isHidden: boolean): Promise<void>;
  listHiddenCurrencies(): Promise<string[]>;

  // Balance assertions
  createBalanceAssertion(assertion: BalanceAssertion): Promise<void>;
  listBalanceAssertions(accountId?: string): Promise<BalanceAssertion[]>;
  checkBalanceAssertions(): Promise<BalanceAssertionResult[]>;

  // Integrity checks
  countOrphanedLineItems(): Promise<number>;
  countDuplicateSources(): Promise<number>;

  // Reconciliation
  getUnreconciledLineItems(accountId: string, currency: string, upToDate?: string): Promise<UnreconciledLineItem[]>;
  markReconciled(reconciliation: Reconciliation, lineItemIds: string[]): Promise<void>;
  listReconciliations(accountId?: string): Promise<Reconciliation[]>;
  getReconciliationDetail(id: string): Promise<{ reconciliation: Reconciliation; lineItemIds: string[] } | null>;

  // Database export/import (optional)
  exportDatabase?(): Promise<Uint8Array>;
  importDatabase?(data: Uint8Array): Promise<void>;

  // Transaction control (optional, SqlJsBackend only)
  beginTransaction?(): void;
  commitTransaction?(): void;
  rollbackTransaction?(): void;

  // Account rename / merge
  renameAccountPrefix(oldPrefix: string, newPrefix: string): Promise<{ renamed: number; skipped: number }>;
  mergeAccounts(sourceId: string, targetId: string): Promise<{ lineItems: number; lots: number; assertions: number; reconciliations: number; metadata: number }>;

  // French tax reports
  saveFrenchTaxReport(taxYear: number, report: FrenchTaxReport, checklist?: Record<string, boolean>): Promise<void>;
  getFrenchTaxReport(taxYear: number): Promise<PersistedFrenchTaxReport | null>;
  listFrenchTaxReportYears(): Promise<number[]>;
  deleteFrenchTaxReport(taxYear: number): Promise<void>;

  // Custom plugins
  listCustomPlugins(): Promise<CustomPluginRecord[]>;
  saveCustomPlugin(plugin: CustomPluginRecord): Promise<void>;
  deleteCustomPlugin(id: string): Promise<void>;
  setCustomPluginEnabled(id: string, enabled: boolean): Promise<void>;

  // Database repair
  repairDatabase(): Promise<string[]>;

  // Data management
  clearExchangeRates(): Promise<void>;
  clearLedgerData(): Promise<void>;
  clearAllData(): Promise<void>;

  // Lifecycle
  close?(): void;
}

class TauriBackend implements Backend {
  private bridgeReady: Promise<void> | null = null;

  private waitForBridge(): Promise<void> {
    if (this.bridgeReady) return this.bridgeReady;
    this.bridgeReady = new Promise<void>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((window as any).__TAURI_INTERNALS__) { resolve(); return; }
      let elapsed = 0;
      const poll = setInterval(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((window as any).__TAURI_INTERNALS__) { clearInterval(poll); resolve(); }
        else if ((elapsed += 50) >= 3000) { clearInterval(poll); reject(new Error("Tauri IPC bridge not available")); }
      }, 50);
    });
    return this.bridgeReady;
  }

  private async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    await this.waitForBridge();
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
  }

  // Currencies
  async listCurrencies(): Promise<Currency[]> {
    return this.invoke("list_currencies");
  }
  async createCurrency(currency: Currency): Promise<void> {
    return this.invoke("create_currency", { currency });
  }
  async setCurrencyAssetType(code: string, assetType: string, param?: string): Promise<void> {
    return this.invoke("set_currency_asset_type", { code, assetType, param: param ?? "" });
  }

  // Accounts
  async listAccounts(): Promise<Account[]> {
    return this.invoke("list_accounts");
  }
  async getAccount(id: string): Promise<Account | null> {
    return this.invoke("get_account", { id });
  }
  async createAccount(account: Account): Promise<void> {
    return this.invoke("create_account", { account });
  }
  async archiveAccount(id: string): Promise<void> {
    return this.invoke("archive_account", { id });
  }
  async unarchiveAccount(id: string): Promise<void> {
    return this.invoke("unarchive_account", { id });
  }
  async updateAccount(id: string, updates: { full_name?: string; is_postable?: boolean; opened_at?: string | null }): Promise<void> {
    return this.invoke("update_account", { id, updates });
  }

  // Journal entries
  async postJournalEntry(entry: JournalEntry, items: LineItem[]): Promise<void> {
    return this.invoke("post_journal_entry", { entry, items });
  }
  async voidJournalEntry(id: string): Promise<JournalEntry> {
    return this.invoke("void_journal_entry", { id });
  }
  async editJournalEntry(
    originalId: string,
    newEntry: JournalEntry,
    newItems: LineItem[],
    newMetadata?: Record<string, string>,
    newLinks?: string[],
  ): Promise<{ reversalId: string; newEntryId: string }> {
    return this.invoke("edit_journal_entry", {
      originalId,
      newEntry,
      newItems,
      newMetadata: newMetadata ?? {},
      newLinks: newLinks ?? null,
    });
  }
  async getJournalEntry(id: string): Promise<[JournalEntry, LineItem[]] | null> {
    return this.invoke("get_journal_entry", { id });
  }
  async queryJournalEntries(filter: TransactionFilter): Promise<[JournalEntry, LineItem[]][]> {
    return this.invoke("query_journal_entries", { filter });
  }
  async queryJournalEntriesOnly(filter: TransactionFilter): Promise<JournalEntry[]> {
    // Tauri backend: fall back to queryJournalEntries and strip line items
    const pairs = await this.queryJournalEntries(filter);
    return pairs.map(([e]) => e);
  }
  async getLineItemsForEntries(entryIds: string[]): Promise<Map<string, LineItem[]>> {
    // Tauri backend: fetch each entry individually
    const map = new Map<string, LineItem[]>();
    for (const id of entryIds) {
      const result = await this.getJournalEntry(id);
      if (result) map.set(id, result[1]);
    }
    return map;
  }
  async countJournalEntries(filter: TransactionFilter): Promise<number> {
    return this.invoke("count_journal_entries", { filter });
  }

  // Balances
  async getAccountBalance(accountId: string, asOf?: string): Promise<CurrencyBalance[]> {
    return this.invoke("get_account_balance", { accountId, asOf: asOf ?? null });
  }
  async getAccountBalanceWithChildren(accountId: string, asOf?: string): Promise<CurrencyBalance[]> {
    return this.invoke("get_account_balance_with_children", { accountId, asOf: asOf ?? null });
  }

  // Reports
  async trialBalance(asOf: string): Promise<TrialBalance> {
    return this.invoke("trial_balance", { asOf });
  }
  async incomeStatement(fromDate: string, toDate: string): Promise<IncomeStatement> {
    return this.invoke("income_statement", { fromDate, toDate });
  }
  async balanceSheet(asOf: string): Promise<BalanceSheet> {
    return this.invoke("balance_sheet", { asOf });
  }
  async balanceSheetBatch(dates: string[]): Promise<Map<string, BalanceSheet>> {
    const entries = await Promise.all(dates.map(async d => [d, await this.balanceSheet(d)] as const));
    return new Map(entries);
  }
  async gainLossReport(fromDate: string, toDate: string): Promise<GainLossReport> {
    return this.invoke("gain_loss_report", { fromDate, toDate });
  }
  async listOpenLots(): Promise<OpenLot[]> {
    return this.invoke("list_open_lots");
  }

  // Budgets
  async createBudget(budget: Budget): Promise<void> {
    return this.invoke("create_budget", { budget });
  }
  async listBudgets(): Promise<Budget[]> {
    return this.invoke("list_budgets");
  }
  async updateBudget(budget: Budget): Promise<void> {
    return this.invoke("update_budget", { budget });
  }
  async deleteBudget(id: string): Promise<void> {
    return this.invoke("delete_budget", { id });
  }

  // Reconciliation
  async getUnreconciledLineItems(accountId: string, currency: string, upToDate?: string): Promise<UnreconciledLineItem[]> {
    return this.invoke("get_unreconciled_line_items", { accountId, currency, upToDate: upToDate ?? null });
  }
  async markReconciled(reconciliation: Reconciliation, lineItemIds: string[]): Promise<void> {
    return this.invoke("mark_reconciled", { reconciliation, lineItemIds });
  }
  async listReconciliations(accountId?: string): Promise<Reconciliation[]> {
    return this.invoke("list_reconciliations", { accountId: accountId ?? null });
  }
  async getReconciliationDetail(id: string): Promise<{ reconciliation: Reconciliation; lineItemIds: string[] } | null> {
    return this.invoke("get_reconciliation_detail", { id });
  }

  // Exchange rates
  async recordExchangeRate(rate: ExchangeRate): Promise<void> {
    return this.invoke("record_exchange_rate", { rate });
  }
  async getExchangeRate(from: string, to: string, date: string): Promise<string | null> {
    return this.invoke("get_exchange_rate", { from, to, date });
  }
  async listExchangeRates(from?: string, to?: string): Promise<ExchangeRate[]> {
    return this.invoke("list_exchange_rates", { from: from ?? null, to: to ?? null });
  }
  async getExchangeRateCurrenciesOnDate(date: string): Promise<string[]> {
    return this.invoke("get_exchange_rate_currencies_on_date", { date });
  }

  // Ledger file import/export
  async importLedgerFile(content: string, format?: LedgerFormat): Promise<LedgerImportResult> {
    return this.invoke("import_ledger_file", { content, format: format ?? null });
  }
  async exportLedgerFile(format?: LedgerFormat): Promise<string> {
    return this.invoke("export_ledger_file", { format: format ?? null });
  }

  // Metadata
  async setMetadata(entryId: string, entries: Record<string, string>): Promise<void> {
    return this.invoke("set_metadata", { entryId, entries });
  }
  async getMetadata(entryId: string): Promise<Record<string, string>> {
    return this.invoke("get_metadata", { entryId });
  }

  async queryEntriesByMetadata(key: string, value: string): Promise<string[]> {
    return this.invoke("query_entries_by_metadata", { key, value });
  }
  async getAllTagValues(): Promise<string[]> {
    return [];
  }
  async getAllMetadataKeys(): Promise<string[]> {
    return [];
  }

  // Batch metadata/links
  async getMetadataBatch(entryIds: string[]): Promise<Map<string, Record<string, string>>> {
    if (entryIds.length === 0) return new Map();
    const results = await Promise.all(entryIds.map(id => this.getMetadata(id)));
    const map = new Map<string, Record<string, string>>();
    for (let i = 0; i < entryIds.length; i++) {
      map.set(entryIds[i], results[i]);
    }
    return map;
  }

  async getEntryLinksBatch(entryIds: string[]): Promise<Map<string, string[]>> {
    if (entryIds.length === 0) return new Map();
    const results = await Promise.all(entryIds.map(id => this.getEntryLinks(id)));
    const map = new Map<string, string[]>();
    for (let i = 0; i < entryIds.length; i++) {
      map.set(entryIds[i], results[i]);
    }
    return map;
  }

  // Entry links
  async setEntryLinks(entryId: string, links: string[]): Promise<void> {
    return this.invoke("set_entry_links", { entryId, links });
  }
  async getEntryLinks(entryId: string): Promise<string[]> {
    return this.invoke("get_entry_links", { entryId });
  }
  async getEntriesByLink(linkName: string): Promise<string[]> {
    return this.invoke("get_entries_by_link", { linkName });
  }
  async getAllLinkNames(): Promise<string[]> {
    return this.invoke("get_all_link_names");
  }
  async getAllLinksWithCounts(): Promise<Array<{ link_name: string; entry_count: number }>> {
    return this.invoke("get_all_links_with_counts");
  }

  // Account metadata
  async setAccountMetadata(accountId: string, entries: Record<string, string>): Promise<void> {
    return this.invoke("set_account_metadata", { accountId, entries });
  }
  async getAccountMetadata(accountId: string): Promise<Record<string, string>> {
    return this.invoke("get_account_metadata", { accountId });
  }

  // Raw transactions
  async storeRawTransaction(source: string, data: string): Promise<void> {
    return this.invoke("store_raw_transaction", { source, data });
  }
  async getRawTransaction(source: string): Promise<string | null> {
    return this.invoke("get_raw_transaction", { source });
  }
  async queryRawTransactions(sourcePrefix: string): Promise<Array<{ source: string; data: string }>> {
    return this.invoke("query_raw_transactions", { sourcePrefix });
  }

  // Etherscan
  async listEtherscanAccounts(): Promise<EtherscanAccount[]> {
    return this.invoke("list_etherscan_accounts");
  }
  async addEtherscanAccount(address: string, chainId: number, label: string): Promise<void> {
    return this.invoke("add_etherscan_account", { address, chainId, label });
  }
  async removeEtherscanAccount(address: string, chainId: number): Promise<void> {
    return this.invoke("remove_etherscan_account", { address, chainId });
  }
  async syncEtherscan(apiKey: string, address: string, label: string, chainId: number): Promise<EtherscanSyncResult> {
    const { syncEtherscanWithHandlers, getDefaultRegistry } = await import("./handlers/index.js");
    const { loadSettings } = await import("./data/settings.svelte.js");
    return syncEtherscanWithHandlers(this, getDefaultRegistry(), apiKey, address, label, chainId, loadSettings());
  }
  async syncTheGraph(apiKey: string, address: string, label: string, chainId: number): Promise<EtherscanSyncResult> {
    const { syncTheGraphWithHandlers, getDefaultRegistry } = await import("./handlers/index.js");
    const { loadSettings } = await import("./data/settings.svelte.js");
    return syncTheGraphWithHandlers(this, getDefaultRegistry(), apiKey, address, label, chainId, loadSettings());
  }

  // Bitcoin
  async listBitcoinAccounts(): Promise<BitcoinAccount[]> {
    return this.invoke("list_bitcoin_accounts");
  }
  async addBitcoinAccount(account: Omit<BitcoinAccount, "last_sync">): Promise<void> {
    return this.invoke("add_bitcoin_account", { account });
  }
  async removeBitcoinAccount(id: string): Promise<void> {
    return this.invoke("remove_bitcoin_account", { id });
  }
  async getBtcTrackedAddresses(accountId: string): Promise<string[]> {
    return this.invoke("get_btc_tracked_addresses", { accountId });
  }
  async storeBtcDerivedAddresses(accountId: string, addresses: Array<{address: string; change: number; index: number}>): Promise<void> {
    return this.invoke("store_btc_derived_addresses", { accountId, addresses });
  }
  async updateBtcDerivationIndex(accountId: string, receiveIndex: number, changeIndex: number): Promise<void> {
    return this.invoke("update_btc_derivation_index", { accountId, receiveIndex, changeIndex });
  }
  async updateBitcoinAccountLabel(id: string, label: string): Promise<void> {
    return this.invoke("update_bitcoin_account_label", { id, label });
  }
  async syncBitcoin(account: BitcoinAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<BitcoinSyncResult> {
    const { syncBitcoinAccount } = await import("./bitcoin/sync.js");
    const { loadSettings } = await import("./data/settings.svelte.js");
    const allAccounts = await this.listBitcoinAccounts();
    return syncBitcoinAccount(this, account, allAccounts, loadSettings(), onProgress, signal);
  }

  // Solana
  async listSolanaAccounts(): Promise<SolanaAccount[]> {
    return this.invoke("list_solana_accounts");
  }
  async addSolanaAccount(account: Omit<SolanaAccount, "last_sync">): Promise<void> {
    return this.invoke("add_solana_account", { account });
  }
  async removeSolanaAccount(id: string): Promise<void> {
    return this.invoke("remove_solana_account", { id });
  }
  async updateSolanaAccountLabel(id: string, label: string): Promise<void> {
    return this.invoke("update_solana_account_label", { id, label });
  }
  async updateSolanaLastSignature(id: string, signature: string): Promise<void> {
    return this.invoke("update_solana_last_signature", { id, signature });
  }
  async syncSolana(account: SolanaAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<SolanaSyncResult> {
    const { syncSolanaAccount } = await import("./solana/sync.js");
    const { loadSettings } = await import("./data/settings.svelte.js");
    return syncSolanaAccount(this, account, loadSettings(), onProgress, signal);
  }

  // Hyperliquid
  async listHyperliquidAccounts(): Promise<HyperliquidAccount[]> {
    return this.invoke("list_hyperliquid_accounts");
  }
  async addHyperliquidAccount(account: Omit<HyperliquidAccount, "last_sync" | "last_sync_time">): Promise<void> {
    return this.invoke("add_hyperliquid_account", { account });
  }
  async removeHyperliquidAccount(id: string): Promise<void> {
    return this.invoke("remove_hyperliquid_account", { id });
  }
  async updateHyperliquidAccountLabel(id: string, label: string): Promise<void> {
    return this.invoke("update_hyperliquid_account_label", { id, label });
  }
  async updateHyperliquidSyncCursor(id: string, lastSyncTime: number): Promise<void> {
    return this.invoke("update_hyperliquid_sync_cursor", { id, lastSyncTime });
  }
  async syncHyperliquid(account: HyperliquidAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<HyperliquidSyncResult> {
    const { syncHyperliquidAccount } = await import("./hyperliquid/sync.js");
    return syncHyperliquidAccount(this, account, onProgress, signal);
  }

  // Sui
  async listSuiAccounts(): Promise<SuiAccount[]> { return this.invoke("list_sui_accounts"); }
  async addSuiAccount(account: Omit<SuiAccount, "last_sync" | "last_cursor">): Promise<void> { return this.invoke("add_sui_account", { account }); }
  async removeSuiAccount(id: string): Promise<void> { return this.invoke("remove_sui_account", { id }); }
  async updateSuiAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_sui_account_label", { id, label }); }
  async updateSuiSyncCursor(id: string, cursor: string): Promise<void> { return this.invoke("update_sui_sync_cursor", { id, cursor }); }
  async syncSui(account: SuiAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<SuiSyncResult> {
    const { syncSuiAccount } = await import("./sui/sync.js");
    return syncSuiAccount(this, account, onProgress, signal);
  }

  // Aptos
  async listAptosAccounts(): Promise<AptosAccount[]> { return this.invoke("list_aptos_accounts"); }
  async addAptosAccount(account: Omit<AptosAccount, "last_sync" | "last_version">): Promise<void> { return this.invoke("add_aptos_account", { account }); }
  async removeAptosAccount(id: string): Promise<void> { return this.invoke("remove_aptos_account", { id }); }
  async updateAptosAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_aptos_account_label", { id, label }); }
  async updateAptosSyncVersion(id: string, version: number): Promise<void> { return this.invoke("update_aptos_sync_version", { id, version }); }
  async syncAptos(account: AptosAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<AptosSyncResult> {
    const { syncAptosAccount } = await import("./aptos/sync.js");
    return syncAptosAccount(this, account, onProgress, signal);
  }

  // TON
  async listTonAccounts(): Promise<TonAccount[]> { return this.invoke("list_ton_accounts"); }
  async addTonAccount(account: Omit<TonAccount, "last_sync" | "last_lt">): Promise<void> { return this.invoke("add_ton_account", { account }); }
  async removeTonAccount(id: string): Promise<void> { return this.invoke("remove_ton_account", { id }); }
  async updateTonAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_ton_account_label", { id, label }); }
  async updateTonSyncCursor(id: string, lt: string): Promise<void> { return this.invoke("update_ton_sync_cursor", { id, lt }); }
  async syncTon(account: TonAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<TonSyncResult> {
    const { syncTonAccount } = await import("./ton/sync.js");
    return syncTonAccount(this, account, onProgress, signal);
  }

  // Tezos
  async listTezosAccounts(): Promise<TezosAccount[]> { return this.invoke("list_tezos_accounts"); }
  async addTezosAccount(account: Omit<TezosAccount, "last_sync" | "last_id">): Promise<void> { return this.invoke("add_tezos_account", { account }); }
  async removeTezosAccount(id: string): Promise<void> { return this.invoke("remove_tezos_account", { id }); }
  async updateTezosAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_tezos_account_label", { id, label }); }
  async updateTezosSyncCursor(id: string, lastId: number): Promise<void> { return this.invoke("update_tezos_sync_cursor", { id, lastId }); }
  async syncTezos(account: TezosAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<TezosSyncResult> {
    const { syncTezosAccount } = await import("./tezos/sync.js");
    return syncTezosAccount(this, account, onProgress, signal);
  }

  // Cosmos
  async listCosmosAccounts(): Promise<CosmosAccount[]> { return this.invoke("list_cosmos_accounts"); }
  async addCosmosAccount(account: Omit<CosmosAccount, "last_sync" | "last_offset">): Promise<void> { return this.invoke("add_cosmos_account", { account }); }
  async removeCosmosAccount(id: string): Promise<void> { return this.invoke("remove_cosmos_account", { id }); }
  async updateCosmosAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_cosmos_account_label", { id, label }); }
  async updateCosmosSyncOffset(id: string, offset: number): Promise<void> { return this.invoke("update_cosmos_sync_offset", { id, offset }); }
  async syncCosmos(account: CosmosAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<CosmosSyncResult> {
    const { syncCosmosAccount } = await import("./cosmos/sync.js");
    return syncCosmosAccount(this, account, onProgress, signal);
  }

  // Polkadot
  async listPolkadotAccounts(): Promise<PolkadotAccount[]> { return this.invoke("list_polkadot_accounts"); }
  async addPolkadotAccount(account: Omit<PolkadotAccount, "last_sync" | "last_page">): Promise<void> { return this.invoke("add_polkadot_account", { account }); }
  async removePolkadotAccount(id: string): Promise<void> { return this.invoke("remove_polkadot_account", { id }); }
  async updatePolkadotAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_polkadot_account_label", { id, label }); }
  async updatePolkadotSyncPage(id: string, page: number): Promise<void> { return this.invoke("update_polkadot_sync_page", { id, page }); }
  async syncPolkadot(account: PolkadotAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<PolkadotSyncResult> {
    const { syncPolkadotAccount } = await import("./polkadot/sync.js");
    return syncPolkadotAccount(this, account, onProgress, signal);
  }

  // Dogecoin
  async listDogeAccounts(): Promise<BtcForkAccount[]> { return this.invoke("list_doge_accounts"); }
  async addDogeAccount(account: Omit<BtcForkAccount, "last_sync" | "chain">): Promise<void> { return this.invoke("add_doge_account", { account }); }
  async removeDogeAccount(id: string): Promise<void> { return this.invoke("remove_doge_account", { id }); }
  async updateDogeAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_doge_account_label", { id, label }); }
  async updateDogeSyncTimestamp(id: string): Promise<void> { return this.invoke("update_doge_sync_timestamp", { id }); }
  async syncDoge(account: BtcForkAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<BtcForkSyncResult> {
    const { syncBtcForkAccount } = await import("./btc-fork/sync.js");
    const { BTC_FORK_CHAINS } = await import("./btc-fork/types.js");
    return syncBtcForkAccount(this, { ...account, chain: "doge" }, BTC_FORK_CHAINS.doge, onProgress, signal);
  }

  // Litecoin
  async listLtcAccounts(): Promise<BtcForkAccount[]> { return this.invoke("list_ltc_accounts"); }
  async addLtcAccount(account: Omit<BtcForkAccount, "last_sync" | "chain">): Promise<void> { return this.invoke("add_ltc_account", { account }); }
  async removeLtcAccount(id: string): Promise<void> { return this.invoke("remove_ltc_account", { id }); }
  async updateLtcAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_ltc_account_label", { id, label }); }
  async updateLtcSyncTimestamp(id: string): Promise<void> { return this.invoke("update_ltc_sync_timestamp", { id }); }
  async syncLtc(account: BtcForkAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<BtcForkSyncResult> {
    const { syncBtcForkAccount } = await import("./btc-fork/sync.js");
    const { BTC_FORK_CHAINS } = await import("./btc-fork/types.js");
    return syncBtcForkAccount(this, { ...account, chain: "ltc" }, BTC_FORK_CHAINS.ltc, onProgress, signal);
  }

  // Bitcoin Cash
  async listBchAccounts(): Promise<BtcForkAccount[]> { return this.invoke("list_bch_accounts"); }
  async addBchAccount(account: Omit<BtcForkAccount, "last_sync" | "chain">): Promise<void> { return this.invoke("add_bch_account", { account }); }
  async removeBchAccount(id: string): Promise<void> { return this.invoke("remove_bch_account", { id }); }
  async updateBchAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_bch_account_label", { id, label }); }
  async updateBchSyncTimestamp(id: string): Promise<void> { return this.invoke("update_bch_sync_timestamp", { id }); }
  async syncBch(account: BtcForkAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<BtcForkSyncResult> {
    const { syncBtcForkAccount } = await import("./btc-fork/sync.js");
    const { BTC_FORK_CHAINS } = await import("./btc-fork/types.js");
    return syncBtcForkAccount(this, { ...account, chain: "bch" }, BTC_FORK_CHAINS.bch, onProgress, signal);
  }

  // Dash
  async listDashAccounts(): Promise<BtcForkAccount[]> { return this.invoke("list_dash_accounts"); }
  async addDashAccount(account: Omit<BtcForkAccount, "last_sync" | "chain">): Promise<void> { return this.invoke("add_dash_account", { account }); }
  async removeDashAccount(id: string): Promise<void> { return this.invoke("remove_dash_account", { id }); }
  async updateDashAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_dash_account_label", { id, label }); }
  async updateDashSyncTimestamp(id: string): Promise<void> { return this.invoke("update_dash_sync_timestamp", { id }); }
  async syncDash(account: BtcForkAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<BtcForkSyncResult> {
    const { syncBtcForkAccount } = await import("./btc-fork/sync.js");
    const { BTC_FORK_CHAINS } = await import("./btc-fork/types.js");
    return syncBtcForkAccount(this, { ...account, chain: "dash" }, BTC_FORK_CHAINS.dash, onProgress, signal);
  }

  // Bitcoin SV
  async listBsvAccounts(): Promise<BtcForkAccount[]> { return this.invoke("list_bsv_accounts"); }
  async addBsvAccount(account: Omit<BtcForkAccount, "last_sync" | "chain">): Promise<void> { return this.invoke("add_bsv_account", { account }); }
  async removeBsvAccount(id: string): Promise<void> { return this.invoke("remove_bsv_account", { id }); }
  async updateBsvAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_bsv_account_label", { id, label }); }
  async updateBsvSyncTimestamp(id: string): Promise<void> { return this.invoke("update_bsv_sync_timestamp", { id }); }
  async syncBsv(account: BtcForkAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<BtcForkSyncResult> {
    const { syncBtcForkAccount } = await import("./btc-fork/sync.js");
    const { BTC_FORK_CHAINS } = await import("./btc-fork/types.js");
    return syncBtcForkAccount(this, { ...account, chain: "bsv" }, BTC_FORK_CHAINS.bsv, onProgress, signal);
  }

  // eCash
  async listXecAccounts(): Promise<BtcForkAccount[]> { return this.invoke("list_xec_accounts"); }
  async addXecAccount(account: Omit<BtcForkAccount, "last_sync" | "chain">): Promise<void> { return this.invoke("add_xec_account", { account }); }
  async removeXecAccount(id: string): Promise<void> { return this.invoke("remove_xec_account", { id }); }
  async updateXecAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_xec_account_label", { id, label }); }
  async updateXecSyncTimestamp(id: string): Promise<void> { return this.invoke("update_xec_sync_timestamp", { id }); }
  async syncXec(account: BtcForkAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<BtcForkSyncResult> {
    const { syncBtcForkAccount } = await import("./btc-fork/sync.js");
    const { BTC_FORK_CHAINS } = await import("./btc-fork/types.js");
    return syncBtcForkAccount(this, { ...account, chain: "xec" }, BTC_FORK_CHAINS.xec, onProgress, signal);
  }

  // Groestlcoin
  async listGrsAccounts(): Promise<BtcForkAccount[]> { return this.invoke("list_grs_accounts"); }
  async addGrsAccount(account: Omit<BtcForkAccount, "last_sync" | "chain">): Promise<void> { return this.invoke("add_grs_account", { account }); }
  async removeGrsAccount(id: string): Promise<void> { return this.invoke("remove_grs_account", { id }); }
  async updateGrsAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_grs_account_label", { id, label }); }
  async updateGrsSyncTimestamp(id: string): Promise<void> { return this.invoke("update_grs_sync_timestamp", { id }); }
  async syncGrs(account: BtcForkAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<BtcForkSyncResult> {
    const { syncBtcForkAccount } = await import("./btc-fork/sync.js");
    const { BTC_FORK_CHAINS } = await import("./btc-fork/types.js");
    return syncBtcForkAccount(this, { ...account, chain: "grs" }, BTC_FORK_CHAINS.grs, onProgress, signal);
  }

  // XRP
  async listXrpAccounts(): Promise<XrpAccount[]> { return this.invoke("list_xrp_accounts"); }
  async addXrpAccount(account: Omit<XrpAccount, "last_sync" | "last_marker">): Promise<void> { return this.invoke("add_xrp_account", { account }); }
  async removeXrpAccount(id: string): Promise<void> { return this.invoke("remove_xrp_account", { id }); }
  async updateXrpAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_xrp_account_label", { id, label }); }
  async updateXrpSyncMarker(id: string, marker: string): Promise<void> { return this.invoke("update_xrp_sync_marker", { id, marker }); }
  async syncXrp(account: XrpAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<XrpSyncResult> {
    const { syncXrpAccount } = await import("./xrp/sync.js");
    return syncXrpAccount(this, account, onProgress, signal);
  }

  // TRON
  async listTronAccounts(): Promise<TronAccount[]> { return this.invoke("list_tron_accounts"); }
  async addTronAccount(account: Omit<TronAccount, "last_sync" | "last_fingerprint">): Promise<void> { return this.invoke("add_tron_account", { account }); }
  async removeTronAccount(id: string): Promise<void> { return this.invoke("remove_tron_account", { id }); }
  async updateTronAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_tron_account_label", { id, label }); }
  async updateTronSyncFingerprint(id: string, fingerprint: string): Promise<void> { return this.invoke("update_tron_sync_fingerprint", { id, fingerprint }); }
  async syncTron(account: TronAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<TronSyncResult> {
    const { syncTronAccount } = await import("./tron/sync.js");
    return syncTronAccount(this, account, onProgress, signal);
  }

  // Stellar
  async listStellarAccounts(): Promise<StellarAccount[]> { return this.invoke("list_stellar_accounts"); }
  async addStellarAccount(account: Omit<StellarAccount, "last_sync" | "last_cursor">): Promise<void> { return this.invoke("add_stellar_account", { account }); }
  async removeStellarAccount(id: string): Promise<void> { return this.invoke("remove_stellar_account", { id }); }
  async updateStellarAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_stellar_account_label", { id, label }); }
  async updateStellarSyncCursor(id: string, cursor: string): Promise<void> { return this.invoke("update_stellar_sync_cursor", { id, cursor }); }
  async syncStellar(account: StellarAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<StellarSyncResult> {
    const { syncStellarAccount } = await import("./stellar/sync.js");
    return syncStellarAccount(this, account, onProgress, signal);
  }

  // Bittensor
  async listBittensorAccounts(): Promise<BittensorAccount[]> { return this.invoke("list_bittensor_accounts"); }
  async addBittensorAccount(account: Omit<BittensorAccount, "last_sync" | "last_page">): Promise<void> { return this.invoke("add_bittensor_account", { account }); }
  async removeBittensorAccount(id: string): Promise<void> { return this.invoke("remove_bittensor_account", { id }); }
  async updateBittensorAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_bittensor_account_label", { id, label }); }
  async updateBittensorSyncPage(id: string, page: number): Promise<void> { return this.invoke("update_bittensor_sync_page", { id, page }); }
  async syncBittensor(account: BittensorAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<BittensorSyncResult> {
    const { syncBittensorAccount } = await import("./bittensor/sync.js");
    return syncBittensorAccount(this, account, onProgress, signal);
  }

  // Hedera
  async listHederaAccounts(): Promise<HederaAccount[]> { return this.invoke("list_hedera_accounts"); }
  async addHederaAccount(account: Omit<HederaAccount, "last_sync" | "last_timestamp">): Promise<void> { return this.invoke("add_hedera_account", { account }); }
  async removeHederaAccount(id: string): Promise<void> { return this.invoke("remove_hedera_account", { id }); }
  async updateHederaAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_hedera_account_label", { id, label }); }
  async updateHederaSyncCursor(id: string, timestamp: string): Promise<void> { return this.invoke("update_hedera_sync_cursor", { id, timestamp }); }
  async syncHedera(account: HederaAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<HederaSyncResult> {
    const { syncHederaAccount } = await import("./hedera/sync.js");
    return syncHederaAccount(this, account, onProgress, signal);
  }

  // NEAR
  async listNearAccounts(): Promise<NearAccount[]> { return this.invoke("list_near_accounts"); }
  async addNearAccount(account: Omit<NearAccount, "last_sync" | "last_cursor">): Promise<void> { return this.invoke("add_near_account", { account }); }
  async removeNearAccount(id: string): Promise<void> { return this.invoke("remove_near_account", { id }); }
  async updateNearAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_near_account_label", { id, label }); }
  async updateNearSyncCursor(id: string, cursor: string): Promise<void> { return this.invoke("update_near_sync_cursor", { id, cursor }); }
  async syncNear(account: NearAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<NearSyncResult> {
    const { syncNearAccount } = await import("./near/sync.js");
    return syncNearAccount(this, account, onProgress, signal);
  }

  // Algorand
  async listAlgorandAccounts(): Promise<AlgorandAccount[]> { return this.invoke("list_algorand_accounts"); }
  async addAlgorandAccount(account: Omit<AlgorandAccount, "last_sync" | "next_token">): Promise<void> { return this.invoke("add_algorand_account", { account }); }
  async removeAlgorandAccount(id: string): Promise<void> { return this.invoke("remove_algorand_account", { id }); }
  async updateAlgorandAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_algorand_account_label", { id, label }); }
  async updateAlgorandSyncCursor(id: string, token: string): Promise<void> { return this.invoke("update_algorand_sync_cursor", { id, token }); }
  async syncAlgorand(account: AlgorandAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<AlgorandSyncResult> {
    const { syncAlgorandAccount } = await import("./algorand/sync.js");
    return syncAlgorandAccount(this, account, onProgress, signal);
  }

  // Kaspa
  async listKaspaAccounts(): Promise<KaspaAccount[]> { return this.invoke("list_kaspa_accounts"); }
  async addKaspaAccount(account: Omit<KaspaAccount, "last_sync" | "last_cursor">): Promise<void> { return this.invoke("add_kaspa_account", { account }); }
  async removeKaspaAccount(id: string): Promise<void> { return this.invoke("remove_kaspa_account", { id }); }
  async updateKaspaAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_kaspa_account_label", { id, label }); }
  async updateKaspaSyncCursor(id: string, cursor: string): Promise<void> { return this.invoke("update_kaspa_sync_cursor", { id, cursor }); }
  async syncKaspa(account: KaspaAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<KaspaSyncResult> {
    const { syncKaspaAccount } = await import("./kaspa/sync.js");
    return syncKaspaAccount(this, account, onProgress, signal);
  }

  // Zcash
  async listZcashAccounts(): Promise<ZcashAccount[]> { return this.invoke("list_zcash_accounts"); }
  async addZcashAccount(account: Omit<ZcashAccount, "last_sync" | "last_cursor">): Promise<void> { return this.invoke("add_zcash_account", { account }); }
  async removeZcashAccount(id: string): Promise<void> { return this.invoke("remove_zcash_account", { id }); }
  async updateZcashAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_zcash_account_label", { id, label }); }
  async updateZcashSyncCursor(id: string, cursor: string): Promise<void> { return this.invoke("update_zcash_sync_cursor", { id, cursor }); }
  async syncZcash(account: ZcashAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<ZcashSyncResult> {
    const { syncZcashAccount } = await import("./zcash/sync.js");
    return syncZcashAccount(this, account, onProgress, signal);
  }

  // Stacks
  async listStacksAccounts(): Promise<StacksAccount[]> { return this.invoke("list_stacks_accounts"); }
  async addStacksAccount(account: Omit<StacksAccount, "last_sync" | "last_offset">): Promise<void> { return this.invoke("add_stacks_account", { account }); }
  async removeStacksAccount(id: string): Promise<void> { return this.invoke("remove_stacks_account", { id }); }
  async updateStacksAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_stacks_account_label", { id, label }); }
  async updateStacksSyncOffset(id: string, offset: number): Promise<void> { return this.invoke("update_stacks_sync_offset", { id, offset }); }
  async syncStacks(account: StacksAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<StacksSyncResult> {
    const { syncStacksAccount } = await import("./stacks/sync.js");
    return syncStacksAccount(this, account, onProgress, signal);
  }

  // Cardano
  async listCardanoAccounts(): Promise<CardanoAccount[]> { return this.invoke("list_cardano_accounts"); }
  async addCardanoAccount(account: Omit<CardanoAccount, "last_sync" | "last_page">): Promise<void> { return this.invoke("add_cardano_account", { account }); }
  async removeCardanoAccount(id: string): Promise<void> { return this.invoke("remove_cardano_account", { id }); }
  async updateCardanoAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_cardano_account_label", { id, label }); }
  async updateCardanoSyncPage(id: string, page: number): Promise<void> { return this.invoke("update_cardano_sync_page", { id, page }); }
  async syncCardano(account: CardanoAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<CardanoSyncResult> {
    const { syncCardanoAccount } = await import("./cardano/sync.js");
    const { loadSettings } = await import("./data/settings.svelte.js");
    return syncCardanoAccount(this, account, loadSettings(), onProgress, signal);
  }

  // Monero
  async listMoneroAccounts(): Promise<MoneroAccount[]> { return this.invoke("list_monero_accounts"); }
  async addMoneroAccount(account: Omit<MoneroAccount, "last_sync" | "last_sync_height">): Promise<void> { return this.invoke("add_monero_account", { account }); }
  async removeMoneroAccount(id: string): Promise<void> { return this.invoke("remove_monero_account", { id }); }
  async updateMoneroAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_monero_account_label", { id, label }); }
  async updateMoneroSyncHeight(id: string, height: number): Promise<void> { return this.invoke("update_monero_sync_height", { id, height }); }
  async syncMonero(account: MoneroAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<MoneroSyncResult> {
    const { syncMoneroAccount } = await import("./monero/sync.js");
    const { loadSettings } = await import("./data/settings.svelte.js");
    return syncMoneroAccount(this, account, loadSettings(), onProgress, signal);
  }

  // Bitshares
  async listBitsharesAccounts(): Promise<BitsharesAccount[]> { return this.invoke("list_bitshares_accounts"); }
  async addBitsharesAccount(account: Omit<BitsharesAccount, "last_sync" | "last_operation_id">): Promise<void> { return this.invoke("add_bitshares_account", { account }); }
  async removeBitsharesAccount(id: string): Promise<void> { return this.invoke("remove_bitshares_account", { id }); }
  async updateBitsharesAccountLabel(id: string, label: string): Promise<void> { return this.invoke("update_bitshares_account_label", { id, label }); }
  async updateBitsharesAccountObjectId(id: string, objectId: string): Promise<void> { return this.invoke("update_bitshares_account_object_id", { id, objectId }); }
  async updateBitsharesSyncCursor(id: string, operationId: string): Promise<void> { return this.invoke("update_bitshares_sync_cursor", { id, operationId }); }
  async syncBitshares(account: BitsharesAccount, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<BitsharesSyncResult> {
    const { syncBitsharesAccount } = await import("./bitshares/sync.js");
    return syncBitsharesAccount(this, account, onProgress, signal);
  }

  // Exchange accounts (CEX)
  async listExchangeAccounts(): Promise<ExchangeAccount[]> {
    return this.invoke("list_exchange_accounts");
  }
  async addExchangeAccount(account: ExchangeAccount): Promise<void> {
    return this.invoke("add_exchange_account", { account });
  }
  async updateExchangeAccount(id: string, updates: Partial<ExchangeAccount>): Promise<void> {
    return this.invoke("update_exchange_account", { id, updates });
  }
  async removeExchangeAccount(id: string): Promise<void> {
    return this.invoke("remove_exchange_account", { id });
  }

  // Currency origins
  // Crypto asset info
  async listCryptoAssetInfo(): Promise<Map<string, string>> { return this.invoke("list_crypto_asset_info"); }
  async setCryptoAssetCoingeckoId(code: string, geckoId: string): Promise<void> { return this.invoke("set_crypto_asset_coingecko_id", { code, geckoId }); }

  async getCurrencyOrigins(): Promise<CurrencyOrigin[]> {
    return this.invoke("get_currency_origins");
  }

  // Currency rate source management
  async getCurrencyRateSources(): Promise<CurrencyRateSource[]> {
    return this.invoke("get_currency_rate_sources");
  }
  async setCurrencyRateSource(currency: string, rateSource: string | null, setBy: string, _rateSourceId?: string): Promise<boolean> {
    // Tauri backend doesn't store rate_source_id (frontend-only field)
    await this.invoke("set_currency_rate_source", { currency, rateSource: rateSource ?? "", setBy });
    return true;
  }
  async clearAutoRateSources(): Promise<void> {
    return this.invoke("clear_auto_rate_sources");
  }
  async clearNonUserRateSources(): Promise<void> {
    return this.invoke("clear_non_user_rate_sources");
  }

  // Currency token addresses
  async setCurrencyTokenAddress(currency: string, chain: string, contractAddress: string): Promise<void> {
    return this.invoke("set_currency_token_address", { currency, chain, contractAddress });
  }
  async getCurrencyTokenAddresses(): Promise<Array<{ currency: string; chain: string; contract_address: string }>> {
    return this.invoke("get_currency_token_addresses");
  }
  async getCurrencyTokenAddress(currency: string): Promise<{ chain: string; contract_address: string } | null> {
    return this.invoke("get_currency_token_address", { currency });
  }

  // Currency management
  async setCurrencyName(code: string, name: string): Promise<void> {
    return this.invoke("set_currency_name", { code, name });
  }
  async setCurrencyHidden(code: string, isHidden: boolean): Promise<void> {
    return this.invoke("set_currency_hidden", { code, isHidden });
  }
  async listHiddenCurrencies(): Promise<string[]> {
    return this.invoke("list_hidden_currencies");
  }

  // Balance assertions
  async createBalanceAssertion(assertion: BalanceAssertion): Promise<void> {
    return this.invoke("create_balance_assertion", { assertion });
  }
  async listBalanceAssertions(accountId?: string): Promise<BalanceAssertion[]> {
    return this.invoke("list_balance_assertions", { accountId: accountId ?? null });
  }
  async checkBalanceAssertions(): Promise<BalanceAssertionResult[]> {
    const assertions: BalanceAssertion[] = await this.invoke("check_balance_assertions");
    return assertions.map(a => ({
      assertion: a,
      actual_balance: a.actual_balance ?? "0",
      is_passing: a.is_passing,
      difference: "0", // Computed client-side if needed
    }));
  }

  // Integrity checks
  async countOrphanedLineItems(): Promise<number> {
    return this.invoke("count_orphaned_line_items");
  }
  async countDuplicateSources(): Promise<number> {
    return this.invoke("count_duplicate_sources");
  }

  // Account rename / merge
  async renameAccountPrefix(oldPrefix: string, newPrefix: string): Promise<{ renamed: number; skipped: number }> {
    return this.invoke("rename_account_prefix", { oldPrefix, newPrefix });
  }
  async mergeAccounts(sourceId: string, targetId: string): Promise<{ lineItems: number; lots: number; assertions: number; reconciliations: number; metadata: number }> {
    return this.invoke("merge_accounts", { sourceId, targetId });
  }

  // French tax reports
  async saveFrenchTaxReport(taxYear: number, report: FrenchTaxReport, checklist?: Record<string, boolean>): Promise<void> {
    return this.invoke("save_french_tax_report", {
      taxYear,
      reportJson: JSON.stringify({ report, checklist: checklist ?? {} }),
      finalAcquisitionCost: report.finalAcquisitionCost,
    });
  }
  async getFrenchTaxReport(taxYear: number): Promise<PersistedFrenchTaxReport | null> {
    const result = await this.invoke<[string, string, string] | null>("get_french_tax_report", { taxYear });
    if (!result) return null;
    const [generatedAt, finalAcquisitionCost, reportJson] = result;
    const parsed = JSON.parse(reportJson);
    // Backward compat: old format stored bare FrenchTaxReport (has taxYear field)
    if (parsed.taxYear !== undefined) {
      return { generatedAt, finalAcquisitionCost, report: parsed, checklist: {} };
    }
    return { generatedAt, finalAcquisitionCost, report: parsed.report, checklist: parsed.checklist ?? {} };
  }
  async listFrenchTaxReportYears(): Promise<number[]> {
    return this.invoke("list_french_tax_report_years");
  }
  async deleteFrenchTaxReport(taxYear: number): Promise<void> {
    return this.invoke("delete_french_tax_report", { taxYear });
  }

  // Database repair
  async repairDatabase(): Promise<string[]> {
    return this.invoke("repair_database", {});
  }

  // Data management
  async clearExchangeRates(): Promise<void> {
    return this.invoke("clear_exchange_rates");
  }
  async clearLedgerData(): Promise<void> {
    return this.invoke("clear_ledger_data");
  }
  async clearAllData(): Promise<void> {
    return this.invoke("clear_all_data");
  }

  // Custom plugins (not implemented in Tauri backend — browser-only feature)
  async listCustomPlugins(): Promise<CustomPluginRecord[]> { return []; }
  async saveCustomPlugin(_plugin: CustomPluginRecord): Promise<void> { /* noop */ }
  async deleteCustomPlugin(_id: string): Promise<void> { /* noop */ }
  async setCustomPluginEnabled(_id: string, _enabled: boolean): Promise<void> { /* noop */ }
}

// Store backend on globalThis so it survives Vite HMR module replacement.
// Without this, each HMR cycle creates a new WASM instance (~16MB) without
// freeing the old one, eventually causing WebAssembly OOM.
const _g = globalThis as unknown as {
  __dledger_backend?: Backend;
  __dledger_initPromise?: Promise<Backend>;
};

export async function initBackend(): Promise<Backend> {
  if (_g.__dledger_backend) return _g.__dledger_backend;
  if (_g.__dledger_initPromise) return _g.__dledger_initPromise;
  _g.__dledger_initPromise = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((window as any).__TAURI_INTERNALS__) {
      _g.__dledger_backend = new TauriBackend();
    } else {
      const { SqlJsBackend } = await import("./sql-js-backend.js");
      _g.__dledger_backend = await SqlJsBackend.create();
    }
    return _g.__dledger_backend;
  })();
  return _g.__dledger_initPromise;
}

export function getBackend(): Backend {
  if (!_g.__dledger_backend) {
    throw new Error("Backend not initialized. Await initBackend() first.");
  }
  return _g.__dledger_backend;
}

export function disposeBackend(): void {
  const backend = _g.__dledger_backend;
  if (backend?.close) backend.close();
  _g.__dledger_backend = undefined;
  _g.__dledger_initPromise = undefined;
}
