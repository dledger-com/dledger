import { describe, it, expect } from "vitest";
import { isSuspenseAccount, isFeeAccount } from "./suspense.js";

describe("isSuspenseAccount", () => {
	it("matches Expenses:Uncategorized", () => {
		expect(isSuspenseAccount("Expenses:Uncategorized")).toBe(true);
	});

	it("matches Income:Uncategorized", () => {
		expect(isSuspenseAccount("Income:Uncategorized")).toBe(true);
	});

	it("matches Assets:Bank:Import", () => {
		expect(isSuspenseAccount("Assets:Bank:Import")).toBe(true);
	});

	it("matches Assets:Import", () => {
		expect(isSuspenseAccount("Assets:Import")).toBe(true);
	});

	it("matches Equity:External", () => {
		expect(isSuspenseAccount("Equity:External")).toBe(true);
	});

	it("matches exchange external accounts", () => {
		expect(isSuspenseAccount("Equity:Crypto:Exchange:Kraken:External")).toBe(true);
	});

	it("matches wallet external accounts", () => {
		expect(isSuspenseAccount("Equity:Crypto:Wallet:Ethereum:External:0xabc")).toBe(true);
	});

	it("does NOT match Equity:Trading:*", () => {
		expect(isSuspenseAccount("Equity:Trading:BTC")).toBe(false);
		expect(isSuspenseAccount("Equity:Trading:ETH")).toBe(false);
	});

	it("does NOT match Equity:Opening", () => {
		expect(isSuspenseAccount("Equity:Opening")).toBe(false);
	});

	it("does NOT match regular asset accounts", () => {
		expect(isSuspenseAccount("Assets:Bank:N26")).toBe(false);
		expect(isSuspenseAccount("Assets:Crypto:Exchange:Kraken")).toBe(false);
	});

	it("does NOT match regular expense accounts", () => {
		expect(isSuspenseAccount("Expenses:Food")).toBe(false);
		expect(isSuspenseAccount("Expenses:Crypto:Fees:Trading:Kraken")).toBe(false);
	});

	it("does NOT match regular income accounts", () => {
		expect(isSuspenseAccount("Income:Salary")).toBe(false);
	});
});

describe("isFeeAccount", () => {
	it("matches configured fee prefixes", () => {
		expect(isFeeAccount("Expenses:Crypto:Fees:Trading:Kraken")).toBe(true);
		expect(isFeeAccount("Expenses:Bank:Fees:N26")).toBe(true);
		expect(isFeeAccount("Expenses:Crypto:Fees:Ethereum")).toBe(true);
	});

	it("matches generic :Fees: pattern", () => {
		expect(isFeeAccount("Expenses:Transfer:Fees:Wire")).toBe(true);
	});

	it("matches accounts ending with :Fees", () => {
		expect(isFeeAccount("Expenses:Bank:Fees")).toBe(true);
	});

	it("does NOT match regular expense accounts", () => {
		expect(isFeeAccount("Expenses:Food")).toBe(false);
		expect(isFeeAccount("Expenses:Uncategorized")).toBe(false);
	});
});
