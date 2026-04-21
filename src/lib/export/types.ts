// dledger portable export format types.

export const EXPORT_FORMAT = "dledger-export";
export const EXPORT_VERSION = 2;

export interface ExportHeader {
	format: typeof EXPORT_FORMAT;
	version: number;
	encrypted: boolean;
	encryption?: EncryptionParams;
	createdAt: string;
	appVersion: string;
}

export interface EncryptionParams {
	algorithm: "AES-256-GCM";
	kdf: "PBKDF2";
	kdfHash: "SHA-256";
	iterations: number;
	saltBase64: string;
	ivBase64: string;
}

export interface ExportManifest {
	exportVersion: number;
	schemaVersion: number;
	exportedAt: string;
	appVersion: string;
	entities: Record<string, number>;
}

/** Fine-grained selection of what to include in an export bundle. */
export interface ExportSelection {
	// Core ledger data
	accounts: boolean;
	journal: boolean;
	currencies: boolean;
	exchangeRates: boolean;
	budgets: boolean;
	reconciliations: boolean;
	sources: boolean;
	// Optional
	rawTransactions: boolean;
	plugins: boolean;
	apiKeys: boolean;
	settings: boolean;
	// ML classification layer (master toggle + sub-toggles)
	mlClassification: boolean;
	mlRules: boolean;
	mlExamples: boolean;
	mlSettings: boolean;
}

/** Fine-grained selection of what to apply on import. Mirrors ExportSelection. */
export interface ImportSelection {
	accounts: boolean;
	journal: boolean;
	currencies: boolean;
	exchangeRates: boolean;
	budgets: boolean;
	reconciliations: boolean;
	sources: boolean;
	rawTransactions: boolean;
	plugins: boolean;
	apiKeys: boolean;
	settings: boolean;
	mlClassification: boolean;
	mlRules: boolean;
	mlExamples: boolean;
	mlSettings: boolean;
}

export function defaultExportSelection(): ExportSelection {
	return {
		accounts: true,
		journal: true,
		currencies: true,
		exchangeRates: true,
		budgets: true,
		reconciliations: true,
		sources: true,
		rawTransactions: true,
		plugins: true,
		apiKeys: false,
		settings: true,
		mlClassification: true,
		mlRules: true,
		mlExamples: true,
		mlSettings: true,
	};
}

export function defaultImportSelection(): ImportSelection {
	return {
		accounts: true,
		journal: true,
		currencies: true,
		exchangeRates: true,
		budgets: true,
		reconciliations: true,
		sources: true,
		rawTransactions: true,
		plugins: true,
		apiKeys: true,
		settings: true,
		mlClassification: true,
		mlRules: true,
		mlExamples: true,
		mlSettings: true,
	};
}

export interface ExportOptions {
	passphrase?: string;
	selection?: ExportSelection;
}

export type ImportMode = "replace" | "merge-skip";

export interface ImportOptions {
	passphrase?: string;
	mode?: ImportMode;
	selection?: ImportSelection;
}

export interface ImportProgress {
	phase: "decrypting" | "extracting" | "validating" | "importing";
	current: number;
	total: number;
	entity?: string;
}

export interface ImportResult {
	accounts_imported: number;
	entries_imported: number;
	currencies_imported: number;
	rates_imported: number;
	plugins_imported: number;
	ml_references_imported: number;
	skipped: number;
	warnings: string[];
}

/** Payload written to `ml-reference.json` inside a .dledger bundle. */
export interface MlReferencePayload {
	version: 1;
	examplesByAccount: Array<{ account: string; descriptions: string[] }>;
	tagExamples: Array<{ description: string; tags: string[] }>;
	storedReferences: Array<{
		id: string;
		description: string;
		account_path: string;
		tags: string[] | null;
		source: "imported" | "user";
		created_at: string;
	}>;
}
