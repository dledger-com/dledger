/**
 * Central registry of all supported blockchain chains.
 * Each chain's config drives the generic add-form, table row, and sync UI.
 * To add a new chain: add a config entry here + backend methods + chain-specific files.
 */

export interface InputDetection {
	input_type: "address" | "seed" | "unknown";
	is_private: boolean;
	valid: boolean;
	word_count: number | null;
	description: string;
}

export interface DerivedAddress {
	index: number;
	address: string;
}

export interface BlockchainConfig {
	id: string;
	name: string;
	symbol: string;
	addressRegex: RegExp;
	addressPlaceholder: string;
	addressSlicePrefix: number; // chars to show at start of truncated address
	addressSliceSuffix: number; // chars to show at end
	caseSensitive: boolean;

	// Backend method names (called via dynamic dispatch)
	backendList: string;
	backendAdd: string;
	backendRemove: string;
	backendUpdateLabel: string;
	backendSync: string;

	// Task queue key prefix
	syncTaskPrefix: string;

	// Derivation (null = not supported)
	detectInput: ((input: string) => InputDetection) | null;
	deriveAddresses: ((mnemonic: string, count: number, passphrase?: string, startIndex?: number) => DerivedAddress[]) | null;

	// Activity checking (undefined = not supported for this chain)
	checkActivity?: (address: string, signal?: AbortSignal, apiKey?: string) => Promise<boolean | null>;

	// Generic blockchain_account table (true = uses generic CRUD methods instead of per-chain dynamic dispatch)
	generic?: boolean;

	// Sync function for generic chains (lazy-imported, called directly by Sources page)
	syncFn?: (backend: import("./backend.js").Backend, account: import("./backend.js").GenericBlockchainAccount, settings: import("./data/settings.svelte.js").AppSettings, onProgress?: (msg: string) => void, signal?: AbortSignal) => Promise<any>;

	// Default extra fields for new accounts (e.g., Solana network)
	defaultExtra?: Record<string, string>;
}

import { getActivityChecker } from "./blockchain-activity.js";

// Import detection functions synchronously since they're lightweight
// The derive functions are heavier but only called after seed phrase detection
import { detectSuiInputType, deriveSuiAddresses } from "./sui/derive-js.js";
import { detectAptosInputType, deriveAptosAddresses } from "./aptos/derive-js.js";
import { detectTonInputType, deriveTonAddresses } from "./ton/derive-js.js";
import { detectTezosInputType, deriveTezosAddresses } from "./tezos/derive-js.js";
import { detectCosmosInputType, deriveCosmosAddresses } from "./cosmos/derive-js.js";
import { detectPolkadotInputType, derivePolkadotAddresses } from "./polkadot/derive-js.js";
import { detectSolInputType, deriveSolAddresses } from "./solana/derive-js.js";
import { detectEvmInputType, deriveEvmAddressesFromSeed } from "./evm/derive.js";
import { detectBtcForkInputType, deriveBtcForkAddresses } from "./btc-fork/derive-js.js";
import { BTC_FORK_CHAINS } from "./btc-fork/types.js";
import { detectXrpInputType, deriveXrpAddresses } from "./xrp/derive-js.js";
import { detectTronInputType, deriveTronAddresses } from "./tron/derive-js.js";
import { detectStellarInputType, deriveStellarAddresses } from "./stellar/derive-js.js";
import { detectBittensorInputType, deriveBittensorAddresses } from "./bittensor/derive-js.js";
import { detectHederaInputType } from "./hedera/derive-js.js";
import { detectNearInputType, deriveNearAddresses } from "./near/derive-js.js";
import { detectAlgorandInputType, deriveAlgorandAddresses } from "./algorand/derive-js.js";
import { detectKaspaInputType, deriveKaspaAddresses } from "./kaspa/derive-js.js";
import { detectZcashInputType, deriveZcashAddresses } from "./zcash/derive-js.js";
import { detectStacksInputType, deriveStacksAddresses } from "./stacks/derive-js.js";
import { detectCardanoInputType, deriveCardanoAddresses } from "./cardano/derive-js.js";
import { detectMoneroInputType, deriveMoneroAddresses } from "./monero/derive-js.js";
import { detectBitsharesInputType } from "./bitshares/derive-js.js";

export const BLOCKCHAIN_CHAINS: BlockchainConfig[] = [
	// Algorand
	{
		id: "algorand", name: "Algorand", symbol: "ALGO",
		addressRegex: /^[A-Z2-7]{58}$/,
		addressPlaceholder: "ALGO...", addressSlicePrefix: 8, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listAlgorandAccounts", backendAdd: "addAlgorandAccount", backendRemove: "removeAlgorandAccount",
		backendUpdateLabel: "updateAlgorandAccountLabel", backendSync: "syncAlgorand", syncTaskPrefix: "algorand-sync",
		detectInput: detectAlgorandInputType, deriveAddresses: deriveAlgorandAddresses,
		checkActivity: getActivityChecker("algorand") ?? undefined,
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncAlgorandAccount } = await import("./algorand/sync.js"); return syncAlgorandAccount(b, a, p, s); },
	},
	// Aptos
	{
		id: "aptos", name: "Aptos", symbol: "APT",
		addressRegex: /^0x[a-fA-F0-9]{64}$/,
		addressPlaceholder: "0x...", addressSlicePrefix: 6, addressSliceSuffix: 4, caseSensitive: false,
		backendList: "listAptosAccounts", backendAdd: "addAptosAccount", backendRemove: "removeAptosAccount",
		backendUpdateLabel: "updateAptosAccountLabel", backendSync: "syncAptos", syncTaskPrefix: "aptos-sync",
		detectInput: detectAptosInputType, deriveAddresses: deriveAptosAddresses,
		checkActivity: getActivityChecker("aptos") ?? undefined,
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncAptosAccount } = await import("./aptos/sync.js"); return syncAptosAccount(b, a, p, s); },
	},
	// Bitcoin Cash
	{
		id: "bch", name: "Bitcoin Cash", symbol: "BCH",
		addressRegex: /^(bitcoincash:)?[qp][a-z0-9]{41}$/,
		addressPlaceholder: "bitcoincash:q...", addressSlicePrefix: 16, addressSliceSuffix: 4, caseSensitive: false,
		backendList: "listBchAccounts", backendAdd: "addBchAccount", backendRemove: "removeBchAccount",
		backendUpdateLabel: "updateBchAccountLabel", backendSync: "syncBch", syncTaskPrefix: "bch-sync",
		detectInput: (input) => detectBtcForkInputType(BTC_FORK_CHAINS.bch, input),
		deriveAddresses: null, // CashAddr not supported from seed yet
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncBtcForkAccount } = await import("./btc-fork/sync.js"); const { BTC_FORK_CHAINS } = await import("./btc-fork/types.js"); return syncBtcForkAccount(b, a, BTC_FORK_CHAINS.bch, p, s); },
	},
	// Dash
	{
		id: "dash", name: "Dash", symbol: "DASH",
		addressRegex: /^X[1-9A-HJ-NP-Za-km-z]{33}$/,
		addressPlaceholder: "X...", addressSlicePrefix: 6, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listDashAccounts", backendAdd: "addDashAccount", backendRemove: "removeDashAccount",
		backendUpdateLabel: "updateDashAccountLabel", backendSync: "syncDash", syncTaskPrefix: "dash-sync",
		detectInput: (input) => detectBtcForkInputType(BTC_FORK_CHAINS.dash, input),
		deriveAddresses: (m, c, p, s) => deriveBtcForkAddresses(BTC_FORK_CHAINS.dash, m, c, p, s),
		checkActivity: getActivityChecker("dash") ?? undefined,
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncBtcForkAccount } = await import("./btc-fork/sync.js"); const { BTC_FORK_CHAINS } = await import("./btc-fork/types.js"); return syncBtcForkAccount(b, a, BTC_FORK_CHAINS.dash, p, s); },
	},
	// Bitcoin SV
	{
		id: "bsv", name: "Bitcoin SV", symbol: "BSV",
		addressRegex: /^1[1-9A-HJ-NP-Za-km-z]{25,33}$/,
		addressPlaceholder: "1...", addressSlicePrefix: 6, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listBsvAccounts", backendAdd: "addBsvAccount", backendRemove: "removeBsvAccount",
		backendUpdateLabel: "updateBsvAccountLabel", backendSync: "syncBsv", syncTaskPrefix: "bsv-sync",
		detectInput: (input) => detectBtcForkInputType(BTC_FORK_CHAINS.bsv, input),
		deriveAddresses: (m, c, p, s) => deriveBtcForkAddresses(BTC_FORK_CHAINS.bsv, m, c, p, s),
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncBtcForkAccount } = await import("./btc-fork/sync.js"); const { BTC_FORK_CHAINS } = await import("./btc-fork/types.js"); return syncBtcForkAccount(b, a, BTC_FORK_CHAINS.bsv, p, s); },
	},
	// eCash
	{
		id: "xec", name: "eCash", symbol: "XEC",
		addressRegex: /^(ecash:)?[qp][a-z0-9]{41}$/,
		addressPlaceholder: "ecash:q...", addressSlicePrefix: 12, addressSliceSuffix: 4, caseSensitive: false,
		backendList: "listXecAccounts", backendAdd: "addXecAccount", backendRemove: "removeXecAccount",
		backendUpdateLabel: "updateXecAccountLabel", backendSync: "syncXec", syncTaskPrefix: "xec-sync",
		detectInput: (input) => detectBtcForkInputType(BTC_FORK_CHAINS.xec, input),
		deriveAddresses: null, // CashAddr not supported from seed yet
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncBtcForkAccount } = await import("./btc-fork/sync.js"); const { BTC_FORK_CHAINS } = await import("./btc-fork/types.js"); return syncBtcForkAccount(b, a, BTC_FORK_CHAINS.xec, p, s); },
	},
	// Groestlcoin
	{
		id: "grs", name: "Groestlcoin", symbol: "GRS",
		addressRegex: /^(F[a-km-zA-HJ-NP-Z1-9]{33}|grs1[a-z0-9]{39,59})$/,
		addressPlaceholder: "grs1...", addressSlicePrefix: 8, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listGrsAccounts", backendAdd: "addGrsAccount", backendRemove: "removeGrsAccount",
		backendUpdateLabel: "updateGrsAccountLabel", backendSync: "syncGrs", syncTaskPrefix: "grs-sync",
		detectInput: (input) => detectBtcForkInputType(BTC_FORK_CHAINS.grs, input),
		deriveAddresses: null, // GRS uses Groestl hash, not SHA-256 — needs custom derivation
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncBtcForkAccount } = await import("./btc-fork/sync.js"); const { BTC_FORK_CHAINS } = await import("./btc-fork/types.js"); return syncBtcForkAccount(b, a, BTC_FORK_CHAINS.grs, p, s); },
	},
	// Bittensor
	{
		id: "bittensor", name: "Bittensor", symbol: "TAO",
		addressRegex: /^5[A-HJ-NP-Za-km-z1-9]{47}$/,
		addressPlaceholder: "5...", addressSlicePrefix: 8, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listBittensorAccounts", backendAdd: "addBittensorAccount", backendRemove: "removeBittensorAccount",
		backendUpdateLabel: "updateBittensorAccountLabel", backendSync: "syncBittensor", syncTaskPrefix: "bittensor-sync",
		detectInput: detectBittensorInputType, deriveAddresses: deriveBittensorAddresses,
		checkActivity: getActivityChecker("bittensor") ?? undefined,
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncBittensorAccount } = await import("./bittensor/sync.js"); return syncBittensorAccount(b, a, p, s); },
	},
	// Bitshares
	{
		id: "bitshares", name: "Bitshares", symbol: "BTS",
		addressRegex: /^[a-z][a-z0-9.-]{2,62}$/,
		addressPlaceholder: "Account name, e.g. myaccount", addressSlicePrefix: 16, addressSliceSuffix: 0, caseSensitive: false,
		backendList: "listBitsharesAccounts", backendAdd: "addBitsharesAccount", backendRemove: "removeBitsharesAccount",
		backendUpdateLabel: "updateBitsharesAccountLabel", backendSync: "syncBitshares", syncTaskPrefix: "bitshares-sync",
		detectInput: detectBitsharesInputType, deriveAddresses: null,
		checkActivity: getActivityChecker("bitshares") ?? undefined,
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncBitsharesAccount } = await import("./bitshares/sync.js"); return syncBitsharesAccount(b, a, p, s); },
	},
	// Cardano
	{
		id: "cardano", name: "Cardano", symbol: "ADA",
		addressRegex: /^addr1[0-9a-z]{53,}$/,
		addressPlaceholder: "addr1...", addressSlicePrefix: 10, addressSliceSuffix: 4, caseSensitive: false,
		backendList: "listCardanoAccounts", backendAdd: "addCardanoAccount", backendRemove: "removeCardanoAccount",
		backendUpdateLabel: "updateCardanoAccountLabel", backendSync: "syncCardano", syncTaskPrefix: "cardano-sync",
		detectInput: detectCardanoInputType, deriveAddresses: deriveCardanoAddresses,
		checkActivity: getActivityChecker("cardano") ?? undefined,
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncCardanoAccount } = await import("./cardano/sync.js"); return syncCardanoAccount(b, a, st, p, s); },
	},
	// Cosmos
	{
		id: "cosmos", name: "Cosmos", symbol: "ATOM",
		addressRegex: /^cosmos1[02-9ac-hj-np-z]{38}$/,
		addressPlaceholder: "cosmos1...", addressSlicePrefix: 12, addressSliceSuffix: 4, caseSensitive: false,
		backendList: "listCosmosAccounts", backendAdd: "addCosmosAccount", backendRemove: "removeCosmosAccount",
		backendUpdateLabel: "updateCosmosAccountLabel", backendSync: "syncCosmos", syncTaskPrefix: "cosmos-sync",
		detectInput: detectCosmosInputType, deriveAddresses: deriveCosmosAddresses,
		checkActivity: getActivityChecker("cosmos") ?? undefined,
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncCosmosAccount } = await import("./cosmos/sync.js"); return syncCosmosAccount(b, a, p, s); },
	},
	// Dogecoin
	{
		id: "doge", name: "Dogecoin", symbol: "DOGE",
		addressRegex: /^D[5-9A-HJ-NP-U][1-9A-HJ-NP-Za-km-z]{32}$/,
		addressPlaceholder: "D...", addressSlicePrefix: 6, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listDogeAccounts", backendAdd: "addDogeAccount", backendRemove: "removeDogeAccount",
		backendUpdateLabel: "updateDogeAccountLabel", backendSync: "syncDoge", syncTaskPrefix: "doge-sync",
		detectInput: (input) => detectBtcForkInputType(BTC_FORK_CHAINS.doge, input),
		deriveAddresses: (m, c, p, s) => deriveBtcForkAddresses(BTC_FORK_CHAINS.doge, m, c, p, s),
		checkActivity: getActivityChecker("doge") ?? undefined,
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncBtcForkAccount } = await import("./btc-fork/sync.js"); const { BTC_FORK_CHAINS } = await import("./btc-fork/types.js"); return syncBtcForkAccount(b, a, BTC_FORK_CHAINS.doge, p, s); },
	},
	// Hedera
	{
		id: "hedera", name: "Hedera", symbol: "HBAR",
		addressRegex: /^0\.0\.\d+$/,
		addressPlaceholder: "0.0...", addressSlicePrefix: 10, addressSliceSuffix: 0, caseSensitive: false,
		backendList: "listHederaAccounts", backendAdd: "addHederaAccount", backendRemove: "removeHederaAccount",
		backendUpdateLabel: "updateHederaAccountLabel", backendSync: "syncHedera", syncTaskPrefix: "hedera-sync",
		detectInput: detectHederaInputType, deriveAddresses: null, // addresses not derivable from seed
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncHederaAccount } = await import("./hedera/sync.js"); return syncHederaAccount(b, a, p, s); },
	},
	// Hyperliquid
	{
		id: "hl", name: "Hyperliquid", symbol: "HYPE",
		addressRegex: /^0x[a-fA-F0-9]{40}$/,
		addressPlaceholder: "0x...", addressSlicePrefix: 6, addressSliceSuffix: 4, caseSensitive: false,
		backendList: "listHyperliquidAccounts", backendAdd: "addHyperliquidAccount", backendRemove: "removeHyperliquidAccount",
		backendUpdateLabel: "updateHyperliquidAccountLabel", backendSync: "syncHyperliquid", syncTaskPrefix: "hl-sync",
		detectInput: (input) => {
			const det = detectEvmInputType(input);
			return { input_type: det.type === "address" ? "address" : det.type === "seed" ? "seed" : "unknown", is_private: det.isPrivate, valid: det.type !== "unknown", word_count: null, description: det.description };
		},
		deriveAddresses: (m, c, p, s) => deriveEvmAddressesFromSeed(m, c, p, s),
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncHyperliquidAccount } = await import("./hyperliquid/sync.js"); return syncHyperliquidAccount(b, a, p, s); },
	},
	// Kaspa
	{
		id: "kaspa", name: "Kaspa", symbol: "KAS",
		addressRegex: /^kaspa:[a-z0-9]{61,63}$/,
		addressPlaceholder: "kaspa:...", addressSlicePrefix: 12, addressSliceSuffix: 4, caseSensitive: false,
		backendList: "listKaspaAccounts", backendAdd: "addKaspaAccount", backendRemove: "removeKaspaAccount",
		backendUpdateLabel: "updateKaspaAccountLabel", backendSync: "syncKaspa", syncTaskPrefix: "kaspa-sync",
		detectInput: detectKaspaInputType, deriveAddresses: deriveKaspaAddresses,
		checkActivity: getActivityChecker("kaspa") ?? undefined,
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncKaspaAccount } = await import("./kaspa/sync.js"); return syncKaspaAccount(b, a, p, s); },
	},
	// Litecoin
	{
		id: "ltc", name: "Litecoin", symbol: "LTC",
		addressRegex: /^(L[a-km-zA-HJ-NP-Z1-9]{26,33}|M[a-km-zA-HJ-NP-Z1-9]{26,33}|ltc1[a-z0-9]{39,59})$/,
		addressPlaceholder: "L...", addressSlicePrefix: 6, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listLtcAccounts", backendAdd: "addLtcAccount", backendRemove: "removeLtcAccount",
		backendUpdateLabel: "updateLtcAccountLabel", backendSync: "syncLtc", syncTaskPrefix: "ltc-sync",
		detectInput: (input) => detectBtcForkInputType(BTC_FORK_CHAINS.ltc, input),
		deriveAddresses: (m, c, p, s) => deriveBtcForkAddresses(BTC_FORK_CHAINS.ltc, m, c, p, s),
		checkActivity: getActivityChecker("ltc") ?? undefined,
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncBtcForkAccount } = await import("./btc-fork/sync.js"); const { BTC_FORK_CHAINS } = await import("./btc-fork/types.js"); return syncBtcForkAccount(b, a, BTC_FORK_CHAINS.ltc, p, s); },
	},
	// Monero
	{
		id: "xmr", name: "Monero", symbol: "XMR",
		addressRegex: /^4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/,
		addressPlaceholder: "4...", addressSlicePrefix: 8, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listMoneroAccounts", backendAdd: "addMoneroAccount", backendRemove: "removeMoneroAccount",
		backendUpdateLabel: "updateMoneroAccountLabel", backendSync: "syncMonero", syncTaskPrefix: "xmr-sync",
		detectInput: detectMoneroInputType, deriveAddresses: (m, c, p, s) => deriveMoneroAddresses(m, c, p, s),
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncMoneroAccount } = await import("./monero/sync.js"); return syncMoneroAccount(b, a, st, p, s); },
	},
	// NEAR
	{
		id: "near", name: "NEAR", symbol: "NEAR",
		addressRegex: /^([a-z0-9._-]+\.near|[0-9a-f]{64})$/,
		addressPlaceholder: "name.near", addressSlicePrefix: 12, addressSliceSuffix: 4, caseSensitive: false,
		backendList: "listNearAccounts", backendAdd: "addNearAccount", backendRemove: "removeNearAccount",
		backendUpdateLabel: "updateNearAccountLabel", backendSync: "syncNear", syncTaskPrefix: "near-sync",
		detectInput: detectNearInputType, deriveAddresses: deriveNearAddresses,
		checkActivity: getActivityChecker("near") ?? undefined,
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncNearAccount } = await import("./near/sync.js"); return syncNearAccount(b, a, p, s); },
	},
	// Polkadot
	{
		id: "polkadot", name: "Polkadot", symbol: "DOT",
		addressRegex: /^1[1-9A-HJ-NP-Za-km-z]{45,47}$/,
		addressPlaceholder: "1...", addressSlicePrefix: 8, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listPolkadotAccounts", backendAdd: "addPolkadotAccount", backendRemove: "removePolkadotAccount",
		backendUpdateLabel: "updatePolkadotAccountLabel", backendSync: "syncPolkadot", syncTaskPrefix: "polkadot-sync",
		detectInput: detectPolkadotInputType, deriveAddresses: derivePolkadotAddresses,
		checkActivity: getActivityChecker("polkadot") ?? undefined,
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncPolkadotAccount } = await import("./polkadot/sync.js"); return syncPolkadotAccount(b, a, p, s); },
	},
	// Solana
	{
		id: "sol", name: "Solana", symbol: "SOL",
		addressRegex: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
		addressPlaceholder: "...", addressSlicePrefix: 8, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listSolanaAccounts", backendAdd: "addSolanaAccount", backendRemove: "removeSolanaAccount",
		backendUpdateLabel: "updateSolanaAccountLabel", backendSync: "syncSolana", syncTaskPrefix: "sol-sync",
		detectInput: (input) => {
			const d = detectSolInputType(input);
			return { input_type: d.input_type === "keypair" ? "unknown" as const : d.input_type, is_private: d.is_private, valid: d.valid, word_count: d.word_count, description: d.description };
		},
		deriveAddresses: deriveSolAddresses,
		checkActivity: getActivityChecker("sol") ?? undefined,
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncSolanaAccount } = await import("./solana/sync.js"); return syncSolanaAccount(b, a, st, p, s); },
		defaultExtra: { network: 'mainnet-beta' },
	},
	// Stacks
	{
		id: "stacks", name: "Stacks", symbol: "STX",
		addressRegex: /^SP[0-9A-Z]{28,38}$/,
		addressPlaceholder: "SP...", addressSlicePrefix: 8, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listStacksAccounts", backendAdd: "addStacksAccount", backendRemove: "removeStacksAccount",
		backendUpdateLabel: "updateStacksAccountLabel", backendSync: "syncStacks", syncTaskPrefix: "stacks-sync",
		detectInput: detectStacksInputType, deriveAddresses: deriveStacksAddresses,
		checkActivity: getActivityChecker("stacks") ?? undefined,
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncStacksAccount } = await import("./stacks/sync.js"); return syncStacksAccount(b, a, p, s); },
	},
	// Stellar
	{
		id: "stellar", name: "Stellar", symbol: "XLM",
		addressRegex: /^G[A-Z2-7]{55}$/,
		addressPlaceholder: "G...", addressSlicePrefix: 8, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listStellarAccounts", backendAdd: "addStellarAccount", backendRemove: "removeStellarAccount",
		backendUpdateLabel: "updateStellarAccountLabel", backendSync: "syncStellar", syncTaskPrefix: "stellar-sync",
		detectInput: detectStellarInputType, deriveAddresses: deriveStellarAddresses,
		checkActivity: getActivityChecker("stellar") ?? undefined,
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncStellarAccount } = await import("./stellar/sync.js"); return syncStellarAccount(b, a, p, s); },
	},
	// Sui
	{
		id: "sui", name: "Sui", symbol: "SUI",
		addressRegex: /^0x[a-fA-F0-9]{64}$/,
		addressPlaceholder: "0x...", addressSlicePrefix: 6, addressSliceSuffix: 4, caseSensitive: false,
		backendList: "listSuiAccounts", backendAdd: "addSuiAccount", backendRemove: "removeSuiAccount",
		backendUpdateLabel: "updateSuiAccountLabel", backendSync: "syncSui", syncTaskPrefix: "sui-sync",
		detectInput: detectSuiInputType, deriveAddresses: deriveSuiAddresses,
		checkActivity: getActivityChecker("sui") ?? undefined,
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncSuiAccount } = await import("./sui/sync.js"); return syncSuiAccount(b, a, p, s); },
	},
	// Tezos
	{
		id: "tezos", name: "Tezos", symbol: "XTZ",
		addressRegex: /^(tz[1-4]|KT1)[1-9A-HJ-NP-Za-km-z]{33}$/,
		addressPlaceholder: "tz1...", addressSlicePrefix: 8, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listTezosAccounts", backendAdd: "addTezosAccount", backendRemove: "removeTezosAccount",
		backendUpdateLabel: "updateTezosAccountLabel", backendSync: "syncTezos", syncTaskPrefix: "tezos-sync",
		detectInput: detectTezosInputType, deriveAddresses: deriveTezosAddresses,
		checkActivity: getActivityChecker("tezos") ?? undefined,
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncTezosAccount } = await import("./tezos/sync.js"); return syncTezosAccount(b, a, p, s); },
	},
	// TON
	{
		id: "ton", name: "TON", symbol: "TON",
		addressRegex: /^([UE]Q[A-Za-z0-9_\-/+]{44,46}=?=?|-?[0-9]+:[0-9a-fA-F]{64})$/,
		addressPlaceholder: "EQ... or UQ...", addressSlicePrefix: 8, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listTonAccounts", backendAdd: "addTonAccount", backendRemove: "removeTonAccount",
		backendUpdateLabel: "updateTonAccountLabel", backendSync: "syncTon", syncTaskPrefix: "ton-sync",
		detectInput: detectTonInputType, deriveAddresses: deriveTonAddresses,
		checkActivity: getActivityChecker("ton") ?? undefined,
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncTonAccount } = await import("./ton/sync.js"); return syncTonAccount(b, a, p, s); },
	},
	// TRON
	{
		id: "tron", name: "TRON", symbol: "TRX",
		addressRegex: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
		addressPlaceholder: "T...", addressSlicePrefix: 6, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listTronAccounts", backendAdd: "addTronAccount", backendRemove: "removeTronAccount",
		backendUpdateLabel: "updateTronAccountLabel", backendSync: "syncTron", syncTaskPrefix: "tron-sync",
		detectInput: detectTronInputType, deriveAddresses: deriveTronAddresses,
		checkActivity: getActivityChecker("tron") ?? undefined,
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncTronAccount } = await import("./tron/sync.js"); return syncTronAccount(b, a, p, s); },
	},
	// XRP
	{
		id: "xrp", name: "XRP Ledger", symbol: "XRP",
		addressRegex: /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/,
		addressPlaceholder: "r...", addressSlicePrefix: 6, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listXrpAccounts", backendAdd: "addXrpAccount", backendRemove: "removeXrpAccount",
		backendUpdateLabel: "updateXrpAccountLabel", backendSync: "syncXrp", syncTaskPrefix: "xrp-sync",
		detectInput: detectXrpInputType, deriveAddresses: deriveXrpAddresses,
		checkActivity: getActivityChecker("xrp") ?? undefined,
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncXrpAccount } = await import("./xrp/sync.js"); return syncXrpAccount(b, a, p, s); },
	},
	// Zcash
	{
		id: "zcash", name: "Zcash", symbol: "ZEC",
		addressRegex: /^t[13][a-km-zA-HJ-NP-Z1-9]{33}$/,
		addressPlaceholder: "t1...", addressSlicePrefix: 6, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listZcashAccounts", backendAdd: "addZcashAccount", backendRemove: "removeZcashAccount",
		backendUpdateLabel: "updateZcashAccountLabel", backendSync: "syncZcash", syncTaskPrefix: "zcash-sync",
		detectInput: detectZcashInputType, deriveAddresses: deriveZcashAddresses,
		checkActivity: getActivityChecker("zcash") ?? undefined,
		generic: true,
		syncFn: async (b, a, st, p, s) => { const { syncZcashAccount } = await import("./zcash/sync.js"); return syncZcashAccount(b, a, p, s); },
	},
];

/** Lookup config by chain ID */
export function getBlockchainConfig(id: string): BlockchainConfig | undefined {
	return BLOCKCHAIN_CHAINS.find(c => c.id === id);
}

/** Detect address format and return matching chain configs */
export function detectBlockchainAddress(input: string): BlockchainConfig[] {
	const trimmed = input.trim();
	return BLOCKCHAIN_CHAINS.filter(c => c.addressRegex.test(trimmed));
}
