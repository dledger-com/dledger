import Decimal from "decimal.js-light";
import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import { renderDescription, tradeDescription, perpTradeDescription, fundingDescription, type DescriptionData } from "$lib/types/description-data.js";
import { colIdx } from "./shared.js";
import { defiAssets, defiIncome, defiExpense, EQUITY_TRADING } from "$lib/accounts/paths.js";

const TRADE_HEADERS = ["time", "coin", "dir", "px", "sz", "ntl"];
const FUNDING_HEADERS = ["time", "coin", "sz", "side", "payment", "rate"];

const HL = "Hyperliquid";

type Variant = "trade" | "funding";

function detectVariant(headers: string[]): Variant | null {
	const lower = headers.map((h) => h.trim().toLowerCase());
	if (TRADE_HEADERS.every((h) => lower.includes(h))) return "trade";
	if (FUNDING_HEADERS.every((h) => lower.includes(h))) return "funding";
	return null;
}

/**
 * Parse date from either HL UI format (DD/MM/YYYY HH:MM:SS)
 * or HypeDexer format (YYYY-MM-DD HH:MM:SS.ffffff).
 */
function parseHlDate(raw: string): string | null {
	const s = raw.trim();
	// YYYY-MM-DD (ISO prefix)
	const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
	// DD/MM/YYYY
	const dmy = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
	if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
	return null;
}

/**
 * Parse coin field: "DEPIN/USDC" → { base: "DEPIN", quote: "USDC" }
 * or "@130" → { base: "@130", quote: "USDC" }
 */
function parseCoin(coin: string): { base: string; quote: string } {
	const trimmed = coin.trim();
	if (trimmed.includes("/")) {
		const [base, quote] = trimmed.split("/");
		return { base: base.trim(), quote: (quote ?? "USDC").trim() };
	}
	// @index format or plain perp coin — quote is always USDC on Hyperliquid
	return { base: trimmed, quote: "USDC" };
}

function parseNum(raw: string | undefined): number {
	if (!raw || raw.trim() === "") return 0;
	return parseFloat(raw) || 0;
}

function parseDec(raw: string | undefined): Decimal {
	if (!raw || raw.trim() === "") return new Decimal(0);
	try { return new Decimal(raw.trim()); } catch { return new Decimal(0); }
}

export const hyperliquidPreset: CsvPreset = {
	id: "hyperliquid",
	name: "Hyperliquid",
	description: "Hyperliquid trade history or funding history (HL UI or HypeDexer export).",
	suggestedMainAccount: defiAssets(HL, "USDC"),

	detect(headers: string[]): number {
		return detectVariant(headers) ? 90 : 0;
	},

	getDefaultMapping(): Partial<CsvImportOptions> {
		return { dateColumn: "time" };
	},

	transform(headers: string[], rows: string[][]): CsvRecord[] | null {
		const variant = detectVariant(headers);
		if (!variant) return null;
		return variant === "trade" ? transformTrades(headers, rows) : transformFunding(headers, rows);
	},
};

function transformTrades(headers: string[], rows: string[][]): CsvRecord[] {
	const timeIdx = colIdx(headers, "time");
	const coinIdx = colIdx(headers, "coin");
	const dirIdx = colIdx(headers, "dir");
	const pxIdx = colIdx(headers, "px");
	const szIdx = colIdx(headers, "sz");
	const ntlIdx = colIdx(headers, "ntl");
	const feeIdx = colIdx(headers, "fee");
	const closedPnlIdx = colIdx(headers, "closedPnl");
	const hashIdx = colIdx(headers, "hash");

	if ([timeIdx, coinIdx, dirIdx, pxIdx, szIdx].some((i) => i === -1)) return [];

	const records: CsvRecord[] = [];

	for (const row of rows) {
		if (row.length <= 1 && (row[0] ?? "") === "") continue;

		const date = parseHlDate(row[timeIdx] ?? "");
		if (!date) continue;

		const { base, quote } = parseCoin(row[coinIdx] ?? "");
		const dir = (row[dirIdx] ?? "").trim();
		const isBuy = dir.toLowerCase() === "buy";
		const sz = parseDec(row[szIdx]);
		const fee = parseDec(row[feeIdx]);
		const closedPnl = parseDec(row[closedPnlIdx]);
		const hash = hashIdx >= 0 ? (row[hashIdx] ?? "").trim() : "";

		if (sz.isZero() && parseNum(row[ntlIdx]) === 0) continue;

		const isSpot = base.startsWith("@") || (row[coinIdx] ?? "").includes("/");
		// Compute quote amount from sz * px (Decimal precision, matching online sync)
		const quoteAmt = parseDec(row[szIdx]).times(parseDec(row[pxIdx]));

		const lines: CsvRecord["lines"] = [];

		if (isSpot) {
			// Spot trade: actual asset exchange (matching online sync line structure)
			const spotAccount = defiAssets(HL, `Spot:${base}`);
			const usdcAccount = defiAssets(HL, "USDC");

			if (isBuy) {
				lines.push(
					{ account: spotAccount, currency: base, amount: sz.toFixed() },
					{ account: usdcAccount, currency: "USDC", amount: quoteAmt.neg().toFixed() },
				);
			} else {
				lines.push(
					{ account: spotAccount, currency: base, amount: sz.neg().toFixed() },
					{ account: usdcAccount, currency: "USDC", amount: quoteAmt.toFixed() },
				);
			}

			// Equity:Trading balance (use Equity:Trading:{base} to match online sync)
			const equityAmt = isBuy ? quoteAmt.toFixed() : quoteAmt.neg().toFixed();
			lines.push({ account: `${EQUITY_TRADING}:${base}`, currency: "USDC", amount: equityAmt });
			const baseEquity = isBuy ? sz.neg().toFixed() : sz.toFixed();
			lines.push({ account: `${EQUITY_TRADING}:${base}`, currency: base, amount: baseEquity });
		} else {
			// Perp trade: only realized PnL
			if (!closedPnl.isZero()) {
				const usdcAccount = defiAssets(HL, "USDC");
				if (closedPnl.gt(0)) {
					lines.push(
						{ account: usdcAccount, currency: "USDC", amount: closedPnl.toFixed() },
						{ account: defiIncome(HL, "Trading"), currency: "USDC", amount: closedPnl.neg().toFixed() },
					);
				} else {
					lines.push(
						{ account: defiExpense(HL, "Trading"), currency: "USDC", amount: closedPnl.abs().toFixed() },
						{ account: usdcAccount, currency: "USDC", amount: closedPnl.toFixed() },
					);
				}
			}
		}

		// Fee
		if (fee.gt(0)) {
			lines.push(
				{ account: defiExpense(HL, "Fees"), currency: "USDC", amount: fee.toFixed() },
				{ account: defiAssets(HL, "USDC"), currency: "USDC", amount: fee.neg().toFixed() },
			);
		}

		// Skip if no lines (perp open with no PnL and no fee)
		if (lines.length === 0) continue;

		const descData: DescriptionData = isSpot
			? tradeDescription("Hyperliquid", isBuy ? "USDC" : base, isBuy ? base : "USDC")
			: perpTradeDescription("Hyperliquid", base, dir.toLowerCase().includes("long") ? "long" : "short");

		const sourceKey = hash
			? `fill:${hash}`
			: `csv:${row[timeIdx]}:${row[coinIdx]}:${row[szIdx]}`;

		records.push({
			date,
			description: renderDescription(descData),
			descriptionData: descData,
			lines,
			sourceKey,
		});
	}

	return records;
}

function transformFunding(headers: string[], rows: string[][]): CsvRecord[] {
	const timeIdx = colIdx(headers, "time");
	const coinIdx = colIdx(headers, "coin");
	const paymentIdx = colIdx(headers, "payment");

	if ([timeIdx, coinIdx, paymentIdx].some((i) => i === -1)) return [];

	const records: CsvRecord[] = [];

	for (const row of rows) {
		if (row.length <= 1 && (row[0] ?? "") === "") continue;

		const date = parseHlDate(row[timeIdx] ?? "");
		if (!date) continue;

		const coin = (row[coinIdx] ?? "").trim();
		const payment = parseDec(row[paymentIdx]);
		if (payment.isZero()) continue;

		const lines: CsvRecord["lines"] = [];
		const usdcAccount = defiAssets(HL, "USDC");

		if (payment.gt(0)) {
			lines.push(
				{ account: usdcAccount, currency: "USDC", amount: payment.toFixed() },
				{ account: defiIncome(HL, "Funding"), currency: "USDC", amount: payment.neg().toFixed() },
			);
		} else {
			lines.push(
				{ account: defiExpense(HL, "Funding"), currency: "USDC", amount: payment.abs().toFixed() },
				{ account: usdcAccount, currency: "USDC", amount: payment.toFixed() },
			);
		}

		const descData: DescriptionData = fundingDescription("Hyperliquid", coin);

		records.push({
			date,
			description: renderDescription(descData),
			descriptionData: descData,
			lines,
			sourceKey: `funding:csv:${row[timeIdx]}:${coin}`,
		});
	}

	return records;
}
