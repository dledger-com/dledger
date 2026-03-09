use chrono::{Datelike, NaiveDate};
use rand::rngs::StdRng;
use rand::Rng;

use crate::accounts;
use crate::currencies;
use crate::distributions::{self, to_decimal, triangular, pick, weighted_index, random_tags, random_links, ActivityProfile, TAG_POOL, LINK_PREFIXES};
use crate::model::{SampleData, Entry};
use super::{ScenarioGenerator, simple_entry};

pub struct PersonalGenerator;

impl ScenarioGenerator for PersonalGenerator {
    fn generate(
        &self,
        rng: &mut StdRng,
        count: usize,
        start: NaiveDate,
        end: NaiveDate,
        _with_prices: bool,
    ) -> SampleData {
        let mut entries: Vec<Entry> = Vec::with_capacity(count + 1);

        // Opening balance
        entries.push(simple_entry(
            start,
            "Opening balance",
            accounts::EQUITY_OPENING,
            accounts::BANK_CHECKING,
            to_decimal(10000.0, 2),
            "EUR",
        ));

        // Activity profile for temporal variation (peaks and valleys)
        let profile = ActivityProfile::new(rng, start, end);

        // Weights: salary=1, rent=1, groceries=15, restaurants=10, transport=8,
        //          subscriptions=2, shopping=5, utilities=1, health=2, entertainment=3
        let weights = [1.0, 1.0, 15.0, 10.0, 8.0, 2.0, 5.0, 1.0, 2.0, 3.0];

        // Pick a fixed salary amount and rent amount for consistency
        let salary_amount = rng.gen_range(3000.0..6000.0);
        let rent_amount = rng.gen_range(800.0..1500.0);

        for _ in 0..count {
            let kind = weighted_index(rng, &weights);
            let entry = match kind {
                0 => {
                    // Salary — monthly on the 28th
                    let date = monthly_date(rng, start, end, 28);
                    simple_entry(
                        date,
                        "Salary",
                        accounts::INCOME_SALARY,
                        accounts::BANK_CHECKING,
                        to_decimal(salary_amount, 2),
                        "EUR",
                    )
                }
                1 => {
                    // Rent — monthly on the 1st
                    let date = monthly_date(rng, start, end, 1);
                    simple_entry(
                        date,
                        "Rent payment",
                        accounts::BANK_CHECKING,
                        accounts::EXPENSES_RENT,
                        to_decimal(rent_amount, 2),
                        "EUR",
                    )
                }
                2 => {
                    // Groceries
                    let amount = triangular(rng, 15.0, 200.0, 50.0);
                    let desc = pick(rng, distributions::GROCERY_STORES);
                    simple_entry(
                        profile.pick_date(rng),
                        desc,
                        accounts::BANK_CHECKING,
                        accounts::EXPENSES_GROCERIES,
                        to_decimal(amount, 2),
                        "EUR",
                    )
                }
                3 => {
                    // Restaurants
                    let amount = triangular(rng, 12.0, 120.0, 30.0);
                    let desc = pick(rng, distributions::RESTAURANTS);
                    simple_entry(
                        profile.pick_date(rng),
                        desc,
                        accounts::BANK_CHECKING,
                        accounts::EXPENSES_RESTAURANTS,
                        to_decimal(amount, 2),
                        "EUR",
                    )
                }
                4 => {
                    // Transport
                    let amount = triangular(rng, 1.5, 80.0, 15.0);
                    let desc = pick(rng, distributions::TRANSPORT);
                    simple_entry(
                        profile.pick_date(rng),
                        desc,
                        accounts::BANK_CHECKING,
                        accounts::EXPENSES_TRANSPORT,
                        to_decimal(amount, 2),
                        "EUR",
                    )
                }
                5 => {
                    // Subscriptions
                    let amount = triangular(rng, 5.0, 50.0, 12.0);
                    let desc = pick(rng, distributions::SUBSCRIPTIONS);
                    simple_entry(
                        profile.pick_date(rng),
                        desc,
                        accounts::BANK_CHECKING,
                        accounts::EXPENSES_SUBSCRIPTIONS,
                        to_decimal(amount, 2),
                        "EUR",
                    )
                }
                6 => {
                    // Shopping
                    let amount = triangular(rng, 10.0, 500.0, 60.0);
                    let desc = pick(rng, distributions::SHOPPING);
                    simple_entry(
                        profile.pick_date(rng),
                        desc,
                        accounts::BANK_CHECKING,
                        accounts::EXPENSES_SHOPPING,
                        to_decimal(amount, 2),
                        "EUR",
                    )
                }
                7 => {
                    // Utilities — monthly
                    let amount = triangular(rng, 30.0, 200.0, 80.0);
                    let desc = pick(rng, distributions::UTILITIES);
                    let date = monthly_date(rng, start, end, 15);
                    simple_entry(
                        date,
                        desc,
                        accounts::BANK_CHECKING,
                        accounts::EXPENSES_UTILITIES,
                        to_decimal(amount, 2),
                        "EUR",
                    )
                }
                8 => {
                    // Health
                    let amount = triangular(rng, 15.0, 300.0, 50.0);
                    let desc = pick(rng, distributions::HEALTH);
                    simple_entry(
                        profile.pick_date(rng),
                        desc,
                        accounts::BANK_CHECKING,
                        accounts::EXPENSES_HEALTH,
                        to_decimal(amount, 2),
                        "EUR",
                    )
                }
                _ => {
                    // Entertainment
                    let amount = triangular(rng, 8.0, 100.0, 25.0);
                    let desc = pick(rng, distributions::ENTERTAINMENT);
                    simple_entry(
                        profile.pick_date(rng),
                        desc,
                        accounts::BANK_CHECKING,
                        accounts::EXPENSES_ENTERTAINMENT,
                        to_decimal(amount, 2),
                        "EUR",
                    )
                }
            };
            // Assign context-appropriate tags for specific types, random for others
            let mut entry = entry;
            match kind {
                0 => entry.tags = vec!["salary".to_string()],
                1 => entry.tags = vec!["rent".to_string(), "recurring".to_string()],
                5 => {
                    entry.tags = vec!["subscription".to_string(), "recurring".to_string()];
                }
                7 => entry.tags = vec!["utilities".to_string(), "recurring".to_string()],
                _ => entry.tags = random_tags(rng, TAG_POOL),
            }
            entry.links = random_links(rng, LINK_PREFIXES);
            entries.push(entry);
        }

        entries.sort_by(|a, b| a.date.cmp(&b.date));

        SampleData {
            commodities: currencies::fiat_currencies(),
            entries,
            prices: Vec::new(),
        }
    }
}

/// Pick a random month within the date range and return the given day of that month,
/// clamped to stay within [start, end).
fn monthly_date(rng: &mut StdRng, start: NaiveDate, end: NaiveDate, day: u32) -> NaiveDate {
    let start_month = start.year() * 12 + start.month() as i32 - 1;
    let end_month = end.year() * 12 + end.month() as i32 - 1;
    if end_month <= start_month {
        return start;
    }
    let m = rng.gen_range(start_month..end_month);
    let year = m / 12;
    let month = (m % 12) as u32 + 1;
    let date = clamp_day(year, month, day);
    // Ensure we stay within [start, end)
    if date < start {
        start
    } else if date >= end {
        end - chrono::Duration::days(1)
    } else {
        date
    }
}

/// Create a date clamping day to the last valid day of the month.
fn clamp_day(year: i32, month: u32, day: u32) -> NaiveDate {
    // Try the requested day, fall back to last day of month
    NaiveDate::from_ymd_opt(year, month, day)
        .unwrap_or_else(|| {
            // Last day of month
            let last = last_day_of_month(year, month);
            NaiveDate::from_ymd_opt(year, month, last).unwrap()
        })
}

fn last_day_of_month(year: i32, month: u32) -> u32 {
    if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)
    }
    .unwrap()
    .pred_opt()
    .unwrap()
    .day()
}
