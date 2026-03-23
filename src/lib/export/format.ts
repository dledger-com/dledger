// dledger export file format: [4-byte LE header length] [header JSON] [payload]

import type { ExportHeader } from "./types.js";

/**
 * Serialize an export header + payload into the .dledger binary format.
 */
export function serializeExport(header: ExportHeader, payload: Uint8Array): Uint8Array {
	const headerJson = new TextEncoder().encode(JSON.stringify(header));
	const result = new Uint8Array(4 + headerJson.length + payload.length);
	const view = new DataView(result.buffer);
	view.setUint32(0, headerJson.length, true); // little-endian
	result.set(headerJson, 4);
	result.set(payload, 4 + headerJson.length);
	return result;
}

/**
 * Deserialize a .dledger file into header + payload.
 */
export function deserializeExport(data: Uint8Array): { header: ExportHeader; payload: Uint8Array } {
	if (data.length < 8) throw new Error("Invalid export file: too short");

	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const headerLen = view.getUint32(0, true);

	if (4 + headerLen > data.length) throw new Error("Invalid export file: header length exceeds file size");

	const headerJson = new TextDecoder().decode(data.slice(4, 4 + headerLen));
	let header: ExportHeader;
	try {
		header = JSON.parse(headerJson);
	} catch {
		throw new Error("Invalid export file: malformed header JSON");
	}

	if (header.format !== "dledger-export") {
		throw new Error(`Unsupported format: ${header.format}`);
	}

	const payload = data.slice(4 + headerLen);
	return { header, payload };
}

/**
 * Check if a Uint8Array looks like a .dledger export file.
 */
export function isDledgerExport(data: Uint8Array): boolean {
	if (data.length < 30) return false;
	try {
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		const headerLen = view.getUint32(0, true);
		if (headerLen > 10000 || 4 + headerLen > data.length) return false;
		const headerJson = new TextDecoder().decode(data.slice(4, 4 + headerLen));
		const parsed = JSON.parse(headerJson);
		return parsed.format === "dledger-export";
	} catch {
		return false;
	}
}
