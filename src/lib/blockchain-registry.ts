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
}

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

export const BLOCKCHAIN_CHAINS: BlockchainConfig[] = [
	// Algorand
	{
		id: "algorand", name: "Algorand", symbol: "ALGO",
		addressRegex: /^[A-Z2-7]{58}$/,
		addressPlaceholder: "ALGO...", addressSlicePrefix: 8, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listAlgorandAccounts", backendAdd: "addAlgorandAccount", backendRemove: "removeAlgorandAccount",
		backendUpdateLabel: "updateAlgorandAccountLabel", backendSync: "syncAlgorand", syncTaskPrefix: "algorand-sync",
		detectInput: detectAlgorandInputType, deriveAddresses: deriveAlgorandAddresses,
	},
	// Aptos
	{
		id: "aptos", name: "Aptos", symbol: "APT",
		addressRegex: /^0x[a-fA-F0-9]{64}$/,
		addressPlaceholder: "0x...", addressSlicePrefix: 6, addressSliceSuffix: 4, caseSensitive: false,
		backendList: "listAptosAccounts", backendAdd: "addAptosAccount", backendRemove: "removeAptosAccount",
		backendUpdateLabel: "updateAptosAccountLabel", backendSync: "syncAptos", syncTaskPrefix: "aptos-sync",
		detectInput: detectAptosInputType, deriveAddresses: deriveAptosAddresses,
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
	},
	// Bittensor
	{
		id: "bittensor", name: "Bittensor", symbol: "TAO",
		addressRegex: /^5[A-HJ-NP-Za-km-z1-9]{47}$/,
		addressPlaceholder: "5...", addressSlicePrefix: 8, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listBittensorAccounts", backendAdd: "addBittensorAccount", backendRemove: "removeBittensorAccount",
		backendUpdateLabel: "updateBittensorAccountLabel", backendSync: "syncBittensor", syncTaskPrefix: "bittensor-sync",
		detectInput: detectBittensorInputType, deriveAddresses: deriveBittensorAddresses,
	},
	// Cardano
	{
		id: "cardano", name: "Cardano", symbol: "ADA",
		addressRegex: /^addr1[0-9a-z]{53,}$/,
		addressPlaceholder: "addr1...", addressSlicePrefix: 10, addressSliceSuffix: 4, caseSensitive: false,
		backendList: "listCardanoAccounts", backendAdd: "addCardanoAccount", backendRemove: "removeCardanoAccount",
		backendUpdateLabel: "updateCardanoAccountLabel", backendSync: "syncCardano", syncTaskPrefix: "cardano-sync",
		detectInput: detectCardanoInputType, deriveAddresses: deriveCardanoAddresses,
	},
	// Cosmos
	{
		id: "cosmos", name: "Cosmos", symbol: "ATOM",
		addressRegex: /^cosmos1[02-9ac-hj-np-z]{38}$/,
		addressPlaceholder: "cosmos1...", addressSlicePrefix: 12, addressSliceSuffix: 4, caseSensitive: false,
		backendList: "listCosmosAccounts", backendAdd: "addCosmosAccount", backendRemove: "removeCosmosAccount",
		backendUpdateLabel: "updateCosmosAccountLabel", backendSync: "syncCosmos", syncTaskPrefix: "cosmos-sync",
		detectInput: detectCosmosInputType, deriveAddresses: deriveCosmosAddresses,
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
	},
	// Hedera
	{
		id: "hedera", name: "Hedera", symbol: "HBAR",
		addressRegex: /^0\.0\.\d+$/,
		addressPlaceholder: "0.0...", addressSlicePrefix: 10, addressSliceSuffix: 0, caseSensitive: false,
		backendList: "listHederaAccounts", backendAdd: "addHederaAccount", backendRemove: "removeHederaAccount",
		backendUpdateLabel: "updateHederaAccountLabel", backendSync: "syncHedera", syncTaskPrefix: "hedera-sync",
		detectInput: detectHederaInputType, deriveAddresses: null, // addresses not derivable from seed
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
	},
	// Kaspa
	{
		id: "kaspa", name: "Kaspa", symbol: "KAS",
		addressRegex: /^kaspa:[a-z0-9]{61,63}$/,
		addressPlaceholder: "kaspa:...", addressSlicePrefix: 12, addressSliceSuffix: 4, caseSensitive: false,
		backendList: "listKaspaAccounts", backendAdd: "addKaspaAccount", backendRemove: "removeKaspaAccount",
		backendUpdateLabel: "updateKaspaAccountLabel", backendSync: "syncKaspa", syncTaskPrefix: "kaspa-sync",
		detectInput: detectKaspaInputType, deriveAddresses: deriveKaspaAddresses,
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
	},
	// Monero
	{
		id: "xmr", name: "Monero", symbol: "XMR",
		addressRegex: /^4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/,
		addressPlaceholder: "4...", addressSlicePrefix: 8, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listMoneroAccounts", backendAdd: "addMoneroAccount", backendRemove: "removeMoneroAccount",
		backendUpdateLabel: "updateMoneroAccountLabel", backendSync: "syncMonero", syncTaskPrefix: "xmr-sync",
		detectInput: detectMoneroInputType, deriveAddresses: (m, c, p, s) => deriveMoneroAddresses(m, c, p, s),
	},
	// NEAR
	{
		id: "near", name: "NEAR", symbol: "NEAR",
		addressRegex: /^([a-z0-9._-]+\.near|[0-9a-f]{64})$/,
		addressPlaceholder: "name.near", addressSlicePrefix: 12, addressSliceSuffix: 4, caseSensitive: false,
		backendList: "listNearAccounts", backendAdd: "addNearAccount", backendRemove: "removeNearAccount",
		backendUpdateLabel: "updateNearAccountLabel", backendSync: "syncNear", syncTaskPrefix: "near-sync",
		detectInput: detectNearInputType, deriveAddresses: deriveNearAddresses,
	},
	// Polkadot
	{
		id: "polkadot", name: "Polkadot", symbol: "DOT",
		addressRegex: /^1[1-9A-HJ-NP-Za-km-z]{45,47}$/,
		addressPlaceholder: "1...", addressSlicePrefix: 8, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listPolkadotAccounts", backendAdd: "addPolkadotAccount", backendRemove: "removePolkadotAccount",
		backendUpdateLabel: "updatePolkadotAccountLabel", backendSync: "syncPolkadot", syncTaskPrefix: "polkadot-sync",
		detectInput: detectPolkadotInputType, deriveAddresses: derivePolkadotAddresses,
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
	},
	// Stacks
	{
		id: "stacks", name: "Stacks", symbol: "STX",
		addressRegex: /^SP[0-9A-Z]{28,38}$/,
		addressPlaceholder: "SP...", addressSlicePrefix: 8, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listStacksAccounts", backendAdd: "addStacksAccount", backendRemove: "removeStacksAccount",
		backendUpdateLabel: "updateStacksAccountLabel", backendSync: "syncStacks", syncTaskPrefix: "stacks-sync",
		detectInput: detectStacksInputType, deriveAddresses: deriveStacksAddresses,
	},
	// Stellar
	{
		id: "stellar", name: "Stellar", symbol: "XLM",
		addressRegex: /^G[A-Z2-7]{55}$/,
		addressPlaceholder: "G...", addressSlicePrefix: 8, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listStellarAccounts", backendAdd: "addStellarAccount", backendRemove: "removeStellarAccount",
		backendUpdateLabel: "updateStellarAccountLabel", backendSync: "syncStellar", syncTaskPrefix: "stellar-sync",
		detectInput: detectStellarInputType, deriveAddresses: deriveStellarAddresses,
	},
	// Sui
	{
		id: "sui", name: "Sui", symbol: "SUI",
		addressRegex: /^0x[a-fA-F0-9]{64}$/,
		addressPlaceholder: "0x...", addressSlicePrefix: 6, addressSliceSuffix: 4, caseSensitive: false,
		backendList: "listSuiAccounts", backendAdd: "addSuiAccount", backendRemove: "removeSuiAccount",
		backendUpdateLabel: "updateSuiAccountLabel", backendSync: "syncSui", syncTaskPrefix: "sui-sync",
		detectInput: detectSuiInputType, deriveAddresses: deriveSuiAddresses,
	},
	// Tezos
	{
		id: "tezos", name: "Tezos", symbol: "XTZ",
		addressRegex: /^(tz[1-4]|KT1)[1-9A-HJ-NP-Za-km-z]{33}$/,
		addressPlaceholder: "tz1...", addressSlicePrefix: 8, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listTezosAccounts", backendAdd: "addTezosAccount", backendRemove: "removeTezosAccount",
		backendUpdateLabel: "updateTezosAccountLabel", backendSync: "syncTezos", syncTaskPrefix: "tezos-sync",
		detectInput: detectTezosInputType, deriveAddresses: deriveTezosAddresses,
	},
	// TON
	{
		id: "ton", name: "TON", symbol: "TON",
		addressRegex: /^([UE]Q[A-Za-z0-9_\-/+]{44,46}=?=?|-?[0-9]+:[0-9a-fA-F]{64})$/,
		addressPlaceholder: "EQ... or UQ...", addressSlicePrefix: 8, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listTonAccounts", backendAdd: "addTonAccount", backendRemove: "removeTonAccount",
		backendUpdateLabel: "updateTonAccountLabel", backendSync: "syncTon", syncTaskPrefix: "ton-sync",
		detectInput: detectTonInputType, deriveAddresses: deriveTonAddresses,
	},
	// TRON
	{
		id: "tron", name: "TRON", symbol: "TRX",
		addressRegex: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
		addressPlaceholder: "T...", addressSlicePrefix: 6, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listTronAccounts", backendAdd: "addTronAccount", backendRemove: "removeTronAccount",
		backendUpdateLabel: "updateTronAccountLabel", backendSync: "syncTron", syncTaskPrefix: "tron-sync",
		detectInput: detectTronInputType, deriveAddresses: deriveTronAddresses,
	},
	// XRP
	{
		id: "xrp", name: "XRP Ledger", symbol: "XRP",
		addressRegex: /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/,
		addressPlaceholder: "r...", addressSlicePrefix: 6, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listXrpAccounts", backendAdd: "addXrpAccount", backendRemove: "removeXrpAccount",
		backendUpdateLabel: "updateXrpAccountLabel", backendSync: "syncXrp", syncTaskPrefix: "xrp-sync",
		detectInput: detectXrpInputType, deriveAddresses: deriveXrpAddresses,
	},
	// Zcash
	{
		id: "zcash", name: "Zcash", symbol: "ZEC",
		addressRegex: /^t[13][a-km-zA-HJ-NP-Z1-9]{33}$/,
		addressPlaceholder: "t1...", addressSlicePrefix: 6, addressSliceSuffix: 4, caseSensitive: true,
		backendList: "listZcashAccounts", backendAdd: "addZcashAccount", backendRemove: "removeZcashAccount",
		backendUpdateLabel: "updateZcashAccountLabel", backendSync: "syncZcash", syncTaskPrefix: "zcash-sync",
		detectInput: detectZcashInputType, deriveAddresses: deriveZcashAddresses,
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
