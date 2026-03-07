use chrono::NaiveDate;
use rust_decimal::Decimal;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntryStatus {
    Confirmed,
    Pending,
}

#[derive(Debug, Clone)]
pub struct Posting {
    pub account: String,
    pub amount: Decimal,
    pub currency: String,
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub date: NaiveDate,
    pub status: EntryStatus,
    pub description: String,
    pub postings: Vec<Posting>,
    pub tags: Vec<String>,
    pub links: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct PriceDirective {
    pub date: NaiveDate,
    pub commodity: String,
    pub price: Decimal,
    pub target_currency: String,
}

#[derive(Debug, Clone)]
pub struct Commodity {
    pub code: String,
    pub decimal_places: u8,
}

#[derive(Debug, Clone, Default)]
pub struct SampleData {
    pub commodities: Vec<Commodity>,
    pub entries: Vec<Entry>,
    pub prices: Vec<PriceDirective>,
}

impl SampleData {
    pub fn merge(&mut self, other: SampleData) {
        self.commodities.extend(other.commodities);
        self.entries.extend(other.entries);
        self.prices.extend(other.prices);
        // Dedup commodities by code
        self.commodities.sort_by(|a, b| a.code.cmp(&b.code));
        self.commodities.dedup_by(|a, b| a.code == b.code);
    }

    pub fn sort_by_date(&mut self) {
        self.entries.sort_by(|a, b| a.date.cmp(&b.date));
        self.prices.sort_by(|a, b| a.date.cmp(&b.date));
    }
}
