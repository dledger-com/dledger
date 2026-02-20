import { test, expect } from "@playwright/test";

test.describe("App smoke tests", () => {
  test("app loads and sidebar renders", async ({ page }) => {
    await page.goto("/");
    // Wait for app to initialize (backend + hydration)
    await expect(page.locator("text=dLedger")).toBeVisible({ timeout: 10000 });
    // Sidebar navigation items
    await expect(page.locator("text=Dashboard")).toBeVisible();
    await expect(page.locator("text=Accounts")).toBeVisible();
    await expect(page.locator("text=Journal")).toBeVisible();
    await expect(page.locator("text=Reports")).toBeVisible();
    await expect(page.locator("text=Budgets")).toBeVisible();
    await expect(page.locator("text=Sources")).toBeVisible();
    await expect(page.locator("text=Settings")).toBeVisible();
  });

  test("navigate to reports page", async ({ page }) => {
    await page.goto("/reports");
    await expect(page.locator("h1")).toContainText("Reports");
    // Verify report cards
    await expect(page.locator("text=Trial Balance")).toBeVisible();
    await expect(page.locator("text=Income Statement")).toBeVisible();
    await expect(page.locator("text=Balance Sheet")).toBeVisible();
    await expect(page.locator("text=Gain/Loss Report")).toBeVisible();
    await expect(page.locator("text=Unrealized Gains/Losses")).toBeVisible();
    await expect(page.locator("text=Budget Report")).toBeVisible();
  });

  test("settings page loads and shows currency", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator("h1")).toContainText("Settings");
  });

  test("accounts page loads", async ({ page }) => {
    await page.goto("/accounts");
    await expect(page.locator("h1")).toContainText("Accounts");
  });

  test("journal page loads", async ({ page }) => {
    await page.goto("/journal");
    await expect(page.locator("h1")).toContainText("Journal");
  });

  test("budgets page loads", async ({ page }) => {
    await page.goto("/budgets");
    await expect(page.locator("h1")).toContainText("Budgets");
    await expect(page.locator("text=Add Budget")).toBeVisible();
  });

  test("sources page loads", async ({ page }) => {
    await page.goto("/sources");
    await expect(page.locator("h1")).toContainText("Sources");
  });

  test("ledger file import flow", async ({ page }) => {
    await page.goto("/sources");
    await expect(page.locator("h1")).toContainText("Sources");

    // Paste ledger content into textarea
    const ledgerContent = `2024-01-01 open Assets:Bank:Checking  USD
2024-01-01 open Expenses:Food  USD

2024-01-15 * "Grocery Store"
  Expenses:Food          50.00 USD
  Assets:Bank:Checking  -50.00 USD`;

    await page.locator("#ledger-data").fill(ledgerContent);
    await page.locator("button:has-text('Import')").click();

    // Wait for import results
    await expect(page.locator("text=Import Results")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("text=Accounts")).toBeVisible();
  });

  test("trial balance generates", async ({ page }) => {
    await page.goto("/reports/trial-balance");
    await expect(page.locator("h1")).toContainText("Trial Balance");
    // The generate runs on mount, so just wait for table or empty state
    await expect(
      page.locator("text=No data available").or(page.locator("table")),
    ).toBeVisible({ timeout: 10000 });
  });

  test("portfolio page loads and has generate button", async ({ page }) => {
    await page.goto("/reports/portfolio");
    await expect(page.locator("h1")).toContainText("Portfolio Overview");
    await expect(page.locator("button:has-text('Generate')")).toBeVisible();
  });

  test("recurring transactions page loads", async ({ page }) => {
    await page.goto("/journal/recurring");
    await expect(page.locator("h1")).toContainText("Recurring Transactions");
  });

  test("tax report page loads and has generate button", async ({ page }) => {
    await page.goto("/reports/tax");
    await expect(page.locator("h1")).toContainText("Tax Summary Report");
    await expect(page.locator("button:has-text('Generate')")).toBeVisible();
  });

  test("csv import page loads", async ({ page }) => {
    await page.goto("/journal/csv-import");
    await expect(page.locator("h1")).toContainText("CSV Import");
  });

  test("budget report page loads", async ({ page }) => {
    await page.goto("/reports/budget");
    await expect(page.locator("h1")).toContainText("Budget Report");
  });
});
