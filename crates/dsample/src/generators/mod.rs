pub mod personal;
pub mod crypto;
pub mod mixed;
pub mod tax;

use chrono::NaiveDate;
use rand::rngs::StdRng;
use rust_decimal::Decimal;

use crate::model::{Entry, EntryStatus, Posting, SampleData};

/// Trait for scenario generators.
pub trait ScenarioGenerator {
    fn generate(
        &self,
        rng: &mut StdRng,
        count: usize,
        start: NaiveDate,
        end: NaiveDate,
        with_prices: bool,
    ) -> SampleData;
}

// ── Entry builder helpers ──

/// Two-leg same-currency transfer.
pub fn simple_entry(
    date: NaiveDate,
    desc: &str,
    from: &str,
    to: &str,
    amount: Decimal,
    currency: &str,
) -> Entry {
    let postings = vec![
        Posting { account: to.to_string(), amount, currency: currency.to_string() },
        Posting { account: from.to_string(), amount: -amount, currency: currency.to_string() },
    ];
    debug_assert!(check_balance(&postings), "simple_entry imbalanced: {desc}");
    Entry {
        date,
        status: EntryStatus::Confirmed,
        description: desc.to_string(),
        postings,
    }
}

/// Four-leg multi-currency trade via Equity:Trading.
#[allow(clippy::too_many_arguments)]
pub fn trade_entry(
    date: NaiveDate,
    desc: &str,
    buy_acct: &str,
    sell_acct: &str,
    buy_amt: Decimal,
    buy_ccy: &str,
    sell_amt: Decimal,
    sell_ccy: &str,
) -> Entry {
    let equity = crate::accounts::EQUITY_TRADING;
    let postings = vec![
        Posting { account: buy_acct.to_string(), amount: buy_amt, currency: buy_ccy.to_string() },
        Posting { account: equity.to_string(), amount: -buy_amt, currency: buy_ccy.to_string() },
        Posting { account: equity.to_string(), amount: sell_amt, currency: sell_ccy.to_string() },
        Posting { account: sell_acct.to_string(), amount: -sell_amt, currency: sell_ccy.to_string() },
    ];
    debug_assert!(check_balance(&postings), "trade_entry imbalanced: {desc}");
    Entry {
        date,
        status: EntryStatus::Confirmed,
        description: desc.to_string(),
        postings,
    }
}

/// Two-leg fee deduction.
pub fn fee_entry(
    date: NaiveDate,
    desc: &str,
    fee_acct: &str,
    asset_acct: &str,
    amount: Decimal,
    currency: &str,
) -> Entry {
    let postings = vec![
        Posting { account: fee_acct.to_string(), amount, currency: currency.to_string() },
        Posting { account: asset_acct.to_string(), amount: -amount, currency: currency.to_string() },
    ];
    debug_assert!(check_balance(&postings), "fee_entry imbalanced: {desc}");
    Entry {
        date,
        status: EntryStatus::Confirmed,
        description: desc.to_string(),
        postings,
    }
}

/// Verify that all postings sum to zero per currency.
pub fn check_balance(postings: &[Posting]) -> bool {
    use std::collections::HashMap;
    let mut sums: HashMap<&str, Decimal> = HashMap::new();
    for p in postings {
        *sums.entry(p.currency.as_str()).or_insert(Decimal::ZERO) += p.amount;
    }
    sums.values().all(|s| s.is_zero())
}
