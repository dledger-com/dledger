use std::io::Write;

use chrono::NaiveDate;
use clap::Parser;

use dsample::cli::{Cli, Format, Scenario};
use dsample::formatters::beancount::BeancountFormatter;
use dsample::formatters::hledger::HledgerFormatter;
use dsample::formatters::kraken_csv::KrakenCsvFormatter;
use dsample::formatters::ledger::LedgerFormatter;
use dsample::formatters::Formatter;
use dsample::generators::crypto::CryptoGenerator;
use dsample::generators::mixed::MixedGenerator;
use dsample::generators::personal::PersonalGenerator;
use dsample::generators::tax::TaxGenerator;
use dsample::generators::ScenarioGenerator;

fn main() {
    let cli = Cli::parse();

    let count = cli.entries.unwrap_or_else(|| cli.size.entry_count());

    let end = chrono::Local::now().date_naive();
    let start = cli
        .start_date
        .as_ref()
        .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
        .unwrap_or_else(|| {
            end - chrono::Duration::days(cli.years as i64 * 365)
        });

    let mut rng = <rand::rngs::StdRng as rand::SeedableRng>::seed_from_u64(cli.seed);

    let generator: Box<dyn ScenarioGenerator> = match cli.scenario {
        Scenario::Personal => Box::new(PersonalGenerator),
        Scenario::Crypto => Box::new(CryptoGenerator),
        Scenario::Mixed => Box::new(MixedGenerator),
        Scenario::Tax => Box::new(TaxGenerator),
    };

    let data = generator.generate(&mut rng, count, start, end, cli.with_prices);

    let formatter: Box<dyn Formatter> = match cli.format {
        Format::Ledger => Box::new(LedgerFormatter),
        Format::Beancount => Box::new(BeancountFormatter),
        Format::Hledger => Box::new(HledgerFormatter),
        Format::KrakenCsv => Box::new(KrakenCsvFormatter),
    };

    let output = formatter.format(&data, cli.seed);

    if let Some(path) = &cli.output {
        std::fs::write(path, &output).expect("Failed to write output file");
        eprintln!("Wrote {} entries to {}", data.entries.len(), path);
    } else {
        std::io::stdout()
            .write_all(output.as_bytes())
            .expect("Failed to write to stdout");
    }
}
