pub mod ledger;
pub mod beancount;
pub mod hledger;
pub mod kraken_csv;

use crate::model::SampleData;

pub trait Formatter {
    fn format(&self, data: &SampleData, seed: u64) -> String;
}
