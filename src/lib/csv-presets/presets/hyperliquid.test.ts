import { describe, it, expect } from "vitest";
import { hyperliquidPreset } from "./hyperliquid.js";

describe("hyperliquidPreset", () => {
	describe("detect", () => {
		it("detects HL UI trade headers", () => {
			const headers = ["time", "coin", "dir", "px", "sz", "ntl", "fee", "closedPnl"];
			expect(hyperliquidPreset.detect(headers, [])).toBe(90);
		});

		it("detects HypeDexer trade headers", () => {
			const headers = ["time", "coin", "dir", "px", "sz", "ntl", "fee", "feeToken", "closedPnl", "hash"];
			expect(hyperliquidPreset.detect(headers, [])).toBe(90);
		});

		it("detects funding headers", () => {
			const headers = ["time", "coin", "sz", "side", "payment", "rate"];
			expect(hyperliquidPreset.detect(headers, [])).toBe(90);
		});

		it("rejects unrelated headers", () => {
			const headers = ["Date", "Type", "Amount", "Currency"];
			expect(hyperliquidPreset.detect(headers, [])).toBe(0);
		});
	});

	describe("transform — trades", () => {
		const hlUiHeaders = ["time", "coin", "dir", "px", "sz", "ntl", "fee", "closedPnl"];
		const hypeDexerHeaders = ["time", "coin", "dir", "px", "sz", "ntl", "fee", "feeToken", "closedPnl", "hash"];

		it("transforms HL UI spot buy (DD/MM/YYYY date)", () => {
			const rows = [
				["08/01/2025 00:07:26", "DEPIN/USDC", "Buy", "0.01221", "1579.92", "19.29", "0.55", "-0.006"],
			];
			const records = hyperliquidPreset.transform(hlUiHeaders, rows);
			expect(records).not.toBeNull();
			expect(records!.length).toBe(1);

			const r = records![0];
			expect(r.date).toBe("2025-01-08");
			expect(r.description).toContain("USDC → DEPIN");

			// Should have DEPIN and USDC currencies in lines
			const currencies = r.lines.map(l => l.currency);
			expect(currencies).toContain("DEPIN");
			expect(currencies).toContain("USDC");

			// DeFi paths
			expect(r.lines.some(l => l.account.includes("DeFi:Hyperliquid"))).toBe(true);
		});

		it("transforms HypeDexer @index spot buy (YYYY-MM-DD date)", () => {
			const rows = [
				["2025-01-25 01:01:34.630166", "@130", "Buy", "0.013376", "588758.08", "7875.22", "", "", "", ""],
			];
			const records = hyperliquidPreset.transform(hypeDexerHeaders, rows);
			expect(records).not.toBeNull();
			expect(records!.length).toBe(1);

			const r = records![0];
			expect(r.date).toBe("2025-01-25");
			// @130 used as currency
			expect(r.lines.some(l => l.currency === "@130")).toBe(true);
		});

		it("handles fee correctly", () => {
			const rows = [
				["08/01/2025 00:07:26", "DEPIN/USDC", "Buy", "0.01221", "1579.92", "19.29", "0.55", "0"],
			];
			const records = hyperliquidPreset.transform(hlUiHeaders, rows)!;
			expect(records.length).toBe(1);

			// Fee lines: expense debit + USDC credit
			const feeLines = records[0].lines.filter(l => l.account.includes("Fees"));
			expect(feeLines.length).toBe(1);
			expect(parseFloat(feeLines[0].amount)).toBeCloseTo(0.55);
		});

		it("handles spot sell", () => {
			const rows = [
				["08/01/2025 12:00:00", "DEPIN/USDC", "Sell", "0.015", "10000", "150", "0.5", "0"],
			];
			const records = hyperliquidPreset.transform(hlUiHeaders, rows)!;
			expect(records.length).toBe(1);
			expect(records[0].description).toContain("DEPIN → USDC");

			// DEPIN should be negative (sold)
			const depinLine = records[0].lines.find(l => l.currency === "DEPIN" && l.account.includes("Spot"));
			expect(depinLine).toBeDefined();
			expect(parseFloat(depinLine!.amount)).toBeLessThan(0);
		});

		it("handles perp trade with closedPnl", () => {
			const rows = [
				["2025-01-25 10:00:00", "BTC", "Close Long", "50000", "0.1", "5000", "1.5", "", "500", "0xabc"],
			];
			const records = hyperliquidPreset.transform(hypeDexerHeaders, rows)!;
			expect(records.length).toBe(1);

			// Should have PnL income + fee
			const incomeLines = records[0].lines.filter(l => l.account.includes("Income"));
			expect(incomeLines.length).toBe(1);
		});

		it("skips perp open with no PnL and no fee", () => {
			const rows = [
				["2025-01-25 10:00:00", "BTC", "Open Long", "50000", "0.1", "5000", "", "", "0", "0xdef"],
			];
			const records = hyperliquidPreset.transform(hypeDexerHeaders, rows)!;
			expect(records.length).toBe(0);
		});

		it("sets sourceKey from hash when available", () => {
			const rows = [
				["2025-01-25 01:01:34", "@130", "Buy", "0.013", "1000", "13", "0.1", "", "", "0xhash123"],
			];
			const records = hyperliquidPreset.transform(hypeDexerHeaders, rows)!;
			expect(records[0].sourceKey).toBe("fill:0xhash123");
		});

		it("sets sourceKey from row data when no hash", () => {
			const rows = [
				["08/01/2025 00:07:26", "DEPIN/USDC", "Buy", "0.01", "100", "1", "0", "0"],
			];
			const records = hyperliquidPreset.transform(hlUiHeaders, rows)!;
			expect(records[0].sourceKey).toContain("csv:");
			expect(records[0].sourceKey).not.toContain("hyperliquid:");
		});

		it("skips empty rows", () => {
			const rows = [[""]];
			const records = hyperliquidPreset.transform(hlUiHeaders, rows)!;
			expect(records.length).toBe(0);
		});
	});

	describe("transform — funding", () => {
		const headers = ["time", "coin", "sz", "side", "payment", "rate"];

		it("transforms positive funding (received)", () => {
			const rows = [
				["2025-01-25 01:00:00", "BTC", "0.5", "long", "0.05", "0.0001"],
			];
			const records = hyperliquidPreset.transform(headers, rows)!;
			expect(records.length).toBe(1);
			expect(records[0].description).toContain("Funding");
			expect(records[0].description).toContain("BTC");

			const incomeLines = records[0].lines.filter(l => l.account.includes("Income"));
			expect(incomeLines.length).toBe(1);
		});

		it("transforms negative funding (paid)", () => {
			const rows = [
				["2025-01-25 01:00:00", "ETH", "5", "short", "-0.50", "-0.0002"],
			];
			const records = hyperliquidPreset.transform(headers, rows)!;
			expect(records.length).toBe(1);

			const expenseLines = records[0].lines.filter(l => l.account.includes("Expenses"));
			expect(expenseLines.length).toBe(1);
			expect(parseFloat(expenseLines[0].amount)).toBeGreaterThan(0);
		});

		it("skips zero payment", () => {
			const rows = [
				["2025-01-25 01:00:00", "BTC", "0.5", "long", "0", "0"],
			];
			const records = hyperliquidPreset.transform(headers, rows)!;
			expect(records.length).toBe(0);
		});
	});
});
