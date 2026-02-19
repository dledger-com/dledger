import Decimal from "decimal.js-light";
import type { Backend } from "$lib/backend.js";

export interface IntegrityIssue {
  severity: "error" | "warning";
  category: string;
  message: string;
  entityType?: string;
  entityId?: string;
}

export async function runIntegrityChecks(backend: Backend): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = [];

  // 1. Trial balance — debits = credits per currency
  try {
    const today = new Date().toISOString().slice(0, 10);
    const tb = await backend.trialBalance(today);

    for (const debit of tb.total_debits) {
      const credit = tb.total_credits.find((c) => c.currency === debit.currency);
      if (!credit) {
        issues.push({
          severity: "error",
          category: "Trial Balance",
          message: `No credits found for currency ${debit.currency} (debits: ${debit.amount})`,
        });
        continue;
      }
      const diff = new Decimal(debit.amount).minus(new Decimal(credit.amount));
      if (!diff.isZero()) {
        issues.push({
          severity: "error",
          category: "Trial Balance",
          message: `Trial balance does not balance for ${debit.currency}: debits ${debit.amount}, credits ${credit.amount}, difference ${diff.toString()}`,
        });
      }
    }

    // Check for credits without corresponding debits
    for (const credit of tb.total_credits) {
      if (!tb.total_debits.find((d) => d.currency === credit.currency)) {
        issues.push({
          severity: "error",
          category: "Trial Balance",
          message: `No debits found for currency ${credit.currency} (credits: ${credit.amount})`,
        });
      }
    }
  } catch (e) {
    issues.push({
      severity: "error",
      category: "Trial Balance",
      message: `Failed to compute trial balance: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 2. Orphaned line items
  try {
    const orphanCount = await backend.countOrphanedLineItems();
    if (orphanCount > 0) {
      issues.push({
        severity: "error",
        category: "Orphaned Data",
        message: `${orphanCount} line item(s) reference nonexistent journal entries or accounts`,
      });
    }
  } catch (e) {
    issues.push({
      severity: "warning",
      category: "Orphaned Data",
      message: `Could not check for orphaned line items: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 3. Balance assertion re-check
  try {
    const results = await backend.checkBalanceAssertions();
    for (const result of results) {
      if (!result.is_passing) {
        issues.push({
          severity: "error",
          category: "Balance Assertion",
          message: `Assertion failed for account ${result.assertion.account_id} on ${result.assertion.date}: expected ${result.assertion.expected_balance} ${result.assertion.currency}, actual ${result.actual_balance} (diff: ${result.difference})`,
          entityType: "account",
          entityId: result.assertion.account_id,
        });
      }
    }
  } catch (e) {
    issues.push({
      severity: "warning",
      category: "Balance Assertion",
      message: `Could not check balance assertions: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 4. Duplicate sources
  try {
    const dupCount = await backend.countDuplicateSources();
    if (dupCount > 0) {
      issues.push({
        severity: "warning",
        category: "Duplicate Sources",
        message: `${dupCount} etherscan source(s) have duplicate journal entries`,
      });
    }
  } catch (e) {
    issues.push({
      severity: "warning",
      category: "Duplicate Sources",
      message: `Could not check for duplicate sources: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 5. Voided entry consistency
  try {
    const allEntries = await backend.queryJournalEntries({});
    const allEntryIds = new Set(allEntries.map(([e]) => e.id));
    for (const [entry] of allEntries) {
      if (entry.status === "voided" && entry.voided_by) {
        if (!allEntryIds.has(entry.voided_by)) {
          issues.push({
            severity: "error",
            category: "Void Consistency",
            message: `Voided entry "${entry.description}" (${entry.id}) references missing reversal ${entry.voided_by}`,
            entityType: "journal_entry",
            entityId: entry.id,
          });
        }
      }
    }
  } catch (e) {
    issues.push({
      severity: "warning",
      category: "Void Consistency",
      message: `Could not check voided entries: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  return issues;
}
