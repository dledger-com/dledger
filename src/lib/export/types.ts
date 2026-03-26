// dledger portable export format types.

export const EXPORT_FORMAT = "dledger-export";
export const EXPORT_VERSION = 1;

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

export interface ExportOptions {
	passphrase?: string;
	includeRawTransactions?: boolean;
	includeSettings?: boolean;
	includeApiKeys?: boolean;
	includePlugins?: boolean;
}

export type ImportMode = "replace" | "merge-skip";

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
	skipped: number;
	warnings: string[];
}
