use std::collections::HashMap;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::models::*;
use crate::storage::{Storage, StorageError};

#[derive(Debug, thiserror::Error)]
pub enum ReportError {
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
}

pub type ReportResult<T> = Result<T, ReportError>;

/// A line in the trial balance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrialBalanceLine {
    pub account_id: Uuid,
    pub account_name: String,
    pub account_type: AccountType,
    pub balances: Vec<CurrencyBalance>,
}

/// Trial balance report.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrialBalance {
    pub as_of: NaiveDate,
    pub lines: Vec<TrialBalanceLine>,
    pub total_debits: Vec<CurrencyBalance>,
    pub total_credits: Vec<CurrencyBalance>,
}

/// A section in an income statement or balance sheet.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportSection {
    pub title: String,
    pub account_type: AccountType,
    pub lines: Vec<TrialBalanceLine>,
    pub totals: Vec<CurrencyBalance>,
}

/// Income statement (Revenue - Expenses) for a period.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IncomeStatement {
    pub from_date: NaiveDate,
    pub to_date: NaiveDate,
    pub revenue: ReportSection,
    pub expenses: ReportSection,
    pub net_income: Vec<CurrencyBalance>,
}

/// Balance sheet (Assets = Liabilities + Equity) at a point in time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BalanceSheet {
    pub as_of: NaiveDate,
    pub assets: ReportSection,
    pub liabilities: ReportSection,
    pub equity: ReportSection,
}

/// Gain/loss report line.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GainLossLine {
    pub lot_id: Uuid,
    pub currency: String,
    pub acquired_date: NaiveDate,
    pub disposed_date: NaiveDate,
    pub quantity: Decimal,
    pub cost_basis: Decimal,
    pub proceeds: Decimal,
    pub gain_loss: Decimal,
}

/// Gain/loss report for a period.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GainLossReport {
    pub from_date: NaiveDate,
    pub to_date: NaiveDate,
    pub lines: Vec<GainLossLine>,
    pub total_gain_loss: Decimal,
}

/// Generate a trial balance as of a given date.
pub fn trial_balance(
    storage: &dyn Storage,
    as_of: NaiveDate,
) -> ReportResult<TrialBalance> {
    let accounts = storage.list_accounts()?;
    let mut lines = Vec::new();
    let mut debit_totals: HashMap<String, Decimal> = HashMap::new();
    let mut credit_totals: HashMap<String, Decimal> = HashMap::new();

    for account in &accounts {
        if !account.is_postable {
            continue;
        }
        let balances =
            storage.sum_line_items(&[account.id], Some(as_of))?;
        if balances.is_empty() {
            continue;
        }

        for bal in &balances {
            if bal.amount > Decimal::ZERO {
                *debit_totals.entry(bal.currency.clone()).or_default() += bal.amount;
            } else if bal.amount < Decimal::ZERO {
                *credit_totals.entry(bal.currency.clone()).or_default() += bal.amount.abs();
            }
        }

        lines.push(TrialBalanceLine {
            account_id: account.id,
            account_name: account.full_name.clone(),
            account_type: account.account_type,
            balances,
        });
    }

    Ok(TrialBalance {
        as_of,
        lines,
        total_debits: debit_totals
            .into_iter()
            .map(|(currency, amount)| CurrencyBalance { currency, amount })
            .collect(),
        total_credits: credit_totals
            .into_iter()
            .map(|(currency, amount)| CurrencyBalance { currency, amount })
            .collect(),
    })
}

/// Generate an income statement for a period.
pub fn income_statement(
    storage: &dyn Storage,
    from_date: NaiveDate,
    to_date: NaiveDate,
) -> ReportResult<IncomeStatement> {
    let accounts = storage.list_accounts()?;

    let mut revenue_lines = Vec::new();
    let mut expense_lines = Vec::new();
    let mut revenue_totals: HashMap<String, Decimal> = HashMap::new();
    let mut expense_totals: HashMap<String, Decimal> = HashMap::new();

    for account in &accounts {
        if !account.is_postable {
            continue;
        }
        match account.account_type {
            AccountType::Revenue | AccountType::Expense => {}
            _ => continue,
        }

        // Income statement needs the difference between period start and end
        let balance_at_end = storage.sum_line_items(&[account.id], Some(to_date))?;
        let balance_at_start = storage.sum_line_items(&[account.id], Some(from_date))?;

        let period_balances = subtract_balances(&balance_at_end, &balance_at_start);
        if period_balances.is_empty() {
            continue;
        }

        let line = TrialBalanceLine {
            account_id: account.id,
            account_name: account.full_name.clone(),
            account_type: account.account_type,
            balances: period_balances.clone(),
        };

        match account.account_type {
            AccountType::Revenue => {
                for bal in &period_balances {
                    *revenue_totals.entry(bal.currency.clone()).or_default() += bal.amount;
                }
                revenue_lines.push(line);
            }
            AccountType::Expense => {
                for bal in &period_balances {
                    *expense_totals.entry(bal.currency.clone()).or_default() += bal.amount;
                }
                expense_lines.push(line);
            }
            _ => unreachable!(),
        }
    }

    // Net income = Revenue credits (negative) + Expense debits (positive)
    // Since revenue is negative (credits) and expenses positive (debits),
    // net income = -(revenue + expenses)
    let mut net_income_map: HashMap<String, Decimal> = HashMap::new();
    for (currency, amount) in &revenue_totals {
        *net_income_map.entry(currency.clone()).or_default() -= amount; // revenue is negative, negate to get positive income
    }
    for (currency, amount) in &expense_totals {
        *net_income_map.entry(currency.clone()).or_default() -= amount;
    }

    Ok(IncomeStatement {
        from_date,
        to_date,
        revenue: ReportSection {
            title: "Revenue".to_string(),
            account_type: AccountType::Revenue,
            lines: revenue_lines,
            totals: map_to_balances(revenue_totals),
        },
        expenses: ReportSection {
            title: "Expenses".to_string(),
            account_type: AccountType::Expense,
            lines: expense_lines,
            totals: map_to_balances(expense_totals),
        },
        net_income: map_to_balances(net_income_map),
    })
}

/// Generate a balance sheet as of a given date.
pub fn balance_sheet(
    storage: &dyn Storage,
    as_of: NaiveDate,
) -> ReportResult<BalanceSheet> {
    let accounts = storage.list_accounts()?;

    let mut asset_lines = Vec::new();
    let mut liability_lines = Vec::new();
    let mut equity_lines = Vec::new();
    let mut asset_totals: HashMap<String, Decimal> = HashMap::new();
    let mut liability_totals: HashMap<String, Decimal> = HashMap::new();
    let mut equity_totals: HashMap<String, Decimal> = HashMap::new();

    for account in &accounts {
        if !account.is_postable {
            continue;
        }
        let totals_map = match account.account_type {
            AccountType::Asset => &mut asset_totals,
            AccountType::Liability => &mut liability_totals,
            AccountType::Equity => &mut equity_totals,
            _ => continue, // Skip Revenue/Expense for balance sheet
        };

        let balances = storage.sum_line_items(&[account.id], Some(as_of))?;
        if balances.is_empty() {
            continue;
        }

        for bal in &balances {
            *totals_map.entry(bal.currency.clone()).or_default() += bal.amount;
        }

        let line = TrialBalanceLine {
            account_id: account.id,
            account_name: account.full_name.clone(),
            account_type: account.account_type,
            balances,
        };

        match account.account_type {
            AccountType::Asset => asset_lines.push(line),
            AccountType::Liability => liability_lines.push(line),
            AccountType::Equity => equity_lines.push(line),
            _ => {}
        }
    }

    Ok(BalanceSheet {
        as_of,
        assets: ReportSection {
            title: "Assets".to_string(),
            account_type: AccountType::Asset,
            lines: asset_lines,
            totals: map_to_balances(asset_totals),
        },
        liabilities: ReportSection {
            title: "Liabilities".to_string(),
            account_type: AccountType::Liability,
            lines: liability_lines,
            totals: map_to_balances(liability_totals),
        },
        equity: ReportSection {
            title: "Equity".to_string(),
            account_type: AccountType::Equity,
            lines: equity_lines,
            totals: map_to_balances(equity_totals),
        },
    })
}

/// Generate a gain/loss report from lot disposals in a period.
pub fn gain_loss_report(
    storage: &dyn Storage,
    from_date: NaiveDate,
    to_date: NaiveDate,
) -> ReportResult<GainLossReport> {
    let disposals = storage.get_lot_disposals_for_period(from_date, to_date)?;
    let mut lines = Vec::new();
    let mut total_gain_loss = Decimal::ZERO;

    for disposal in &disposals {
        let lot = storage.get_lot(&disposal.lot_id)?;
        let (currency, acquired_date) = match lot {
            Some(l) => (l.currency, l.acquired_date),
            None => continue,
        };

        let cost_basis = disposal.quantity * storage.get_lot(&disposal.lot_id)?
            .map(|l| l.cost_basis_per_unit)
            .unwrap_or_default();
        let proceeds = disposal.quantity * disposal.proceeds_per_unit;

        lines.push(GainLossLine {
            lot_id: disposal.lot_id,
            currency,
            acquired_date,
            disposed_date: disposal.disposal_date,
            quantity: disposal.quantity,
            cost_basis,
            proceeds,
            gain_loss: disposal.realized_gain_loss,
        });

        total_gain_loss += disposal.realized_gain_loss;
    }

    Ok(GainLossReport {
        from_date,
        to_date,
        lines,
        total_gain_loss,
    })
}

// --- Helper functions ---

fn subtract_balances(end: &[CurrencyBalance], start: &[CurrencyBalance]) -> Vec<CurrencyBalance> {
    let start_map: HashMap<&str, Decimal> = start
        .iter()
        .map(|b| (b.currency.as_str(), b.amount))
        .collect();

    let mut result: HashMap<String, Decimal> = HashMap::new();

    for bal in end {
        let start_amount = start_map.get(bal.currency.as_str()).copied().unwrap_or_default();
        let diff = bal.amount - start_amount;
        if !diff.is_zero() {
            result.insert(bal.currency.clone(), diff);
        }
    }

    // Handle currencies that exist in start but not in end
    for bal in start {
        if !result.contains_key(&bal.currency) && !end.iter().any(|e| e.currency == bal.currency) {
            let diff = -bal.amount;
            if !diff.is_zero() {
                result.insert(bal.currency.clone(), diff);
            }
        }
    }

    map_to_balances(result)
}

fn map_to_balances(map: HashMap<String, Decimal>) -> Vec<CurrencyBalance> {
    map.into_iter()
        .map(|(currency, amount)| CurrencyBalance { currency, amount })
        .collect()
}
