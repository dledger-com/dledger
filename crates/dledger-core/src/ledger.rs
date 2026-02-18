use chrono::NaiveDate;
use rust_decimal::Decimal;
use uuid::Uuid;

use crate::lots;
use crate::models::*;
use crate::reports;
use crate::storage::{Storage, StorageError};
use crate::validation;

/// Errors from the ledger engine.
#[derive(Debug, thiserror::Error)]
pub enum LedgerError {
    #[error("validation error: {0}")]
    Validation(#[from] validation::ValidationError),

    #[error("lot error: {0}")]
    Lot(#[from] lots::LotError),

    #[error("report error: {0}")]
    Report(#[from] reports::ReportError),

    #[error("storage error: {0}")]
    Storage(#[from] StorageError),

    #[error("journal entry {id} not found")]
    EntryNotFound { id: Uuid },

    #[error("journal entry {id} is already voided")]
    AlreadyVoided { id: Uuid },

    #[error("account {id} not found")]
    AccountNotFound { id: Uuid },
}

pub type LedgerResult<T> = Result<T, LedgerError>;

/// The core ledger engine. Orchestrates all business logic against a Storage backend.
pub struct LedgerEngine {
    storage: Box<dyn Storage>,
}

impl LedgerEngine {
    pub fn new(storage: Box<dyn Storage>) -> Self {
        Self { storage }
    }

    pub fn storage(&self) -> &dyn Storage {
        &*self.storage
    }

    // --- Currency operations ---

    pub fn create_currency(&self, currency: &Currency) -> LedgerResult<()> {
        self.storage.create_currency(currency)?;
        self.audit("create", "currency", Uuid::nil(), &currency.code)?;
        Ok(())
    }

    pub fn list_currencies(&self) -> LedgerResult<Vec<Currency>> {
        Ok(self.storage.list_currencies()?)
    }

    pub fn get_currency(&self, code: &str) -> LedgerResult<Option<Currency>> {
        Ok(self.storage.get_currency(code)?)
    }

    // --- Account operations ---

    pub fn create_account(&self, account: &Account) -> LedgerResult<()> {
        self.storage.create_account(account)?;
        self.audit("create", "account", account.id, &account.full_name)?;
        Ok(())
    }

    pub fn get_account(&self, id: &Uuid) -> LedgerResult<Option<Account>> {
        Ok(self.storage.get_account(id)?)
    }

    pub fn list_accounts(&self) -> LedgerResult<Vec<Account>> {
        Ok(self.storage.list_accounts()?)
    }

    pub fn archive_account(&self, id: &Uuid) -> LedgerResult<()> {
        let account = self.storage.get_account(id)?
            .ok_or(LedgerError::AccountNotFound { id: *id })?;
        self.storage.update_account_archived(id, true)?;
        self.audit("archive", "account", *id, &account.full_name)?;
        Ok(())
    }

    // --- Journal entry operations ---

    /// Post a new journal entry with line items.
    ///
    /// Validates balancing, account existence, and currency validity.
    /// For multi-currency entries involving non-base currency asset accounts,
    /// lot creation/disposal must be handled separately via the lot methods.
    pub fn post_journal_entry(
        &self,
        entry: &JournalEntry,
        items: &[LineItem],
    ) -> LedgerResult<()> {
        // Validate
        validation::validate_journal_entry(items, &*self.storage)?;

        // Insert atomically
        self.storage.insert_journal_entry(entry, items)?;

        self.audit("post", "journal_entry", entry.id, &entry.description)?;
        Ok(())
    }

    /// Post a journal entry and automatically handle lot creation/disposal.
    ///
    /// For each debit to a non-base-currency asset account, creates a lot.
    /// For each credit from a non-base-currency asset account, disposes lots (FIFO).
    ///
    /// `cost_basis_per_unit` and `proceeds_per_unit` are in the base currency.
    pub fn post_journal_entry_with_lots(
        &self,
        entry: &JournalEntry,
        items: &[LineItem],
        cost_info: &LotCostInfo,
    ) -> LedgerResult<()> {
        // Validate
        validation::validate_journal_entry(items, &*self.storage)?;

        // Insert the journal entry
        self.storage.insert_journal_entry(entry, items)?;

        // Find the base currency
        let base_currency = self.storage.list_currencies()?
            .into_iter()
            .find(|c| c.is_base)
            .map(|c| c.code);

        if let Some(base_code) = &base_currency {
            for item in items {
                // Skip base currency items (no lot tracking needed)
                if item.currency == *base_code {
                    continue;
                }

                let account = self.storage.get_account(&item.account_id)?;
                let is_asset = account
                    .as_ref()
                    .map(|a| a.account_type == AccountType::Asset)
                    .unwrap_or(false);

                if !is_asset {
                    continue;
                }

                if item.amount > Decimal::ZERO {
                    // Debit to non-base asset = acquisition
                    let cost_per_unit = cost_info.cost_basis_per_unit
                        .unwrap_or(Decimal::ZERO);

                    lots::create_acquisition_lot(
                        &*self.storage,
                        item.account_id,
                        &item.currency,
                        item.amount,
                        cost_per_unit,
                        base_code,
                        entry.id,
                        entry.date,
                    )?;
                } else if item.amount < Decimal::ZERO {
                    // Credit from non-base asset = disposal
                    let quantity = item.amount.abs();
                    let proceeds_per_unit = cost_info.proceeds_per_unit
                        .unwrap_or(Decimal::ZERO);

                    lots::dispose_lots_fifo(
                        &*self.storage,
                        item.account_id,
                        &item.currency,
                        quantity,
                        proceeds_per_unit,
                        base_code,
                        entry.id,
                        entry.date,
                    )?;
                }
            }
        }

        self.audit("post_with_lots", "journal_entry", entry.id, &entry.description)?;
        Ok(())
    }

    /// Void a journal entry by creating a reversing entry.
    pub fn void_journal_entry(&self, id: &Uuid) -> LedgerResult<JournalEntry> {
        let (original, items) = self.storage.get_journal_entry(id)?
            .ok_or(LedgerError::EntryNotFound { id: *id })?;

        if original.status == JournalEntryStatus::Voided {
            return Err(LedgerError::AlreadyVoided { id: *id });
        }

        // Create reversing entry
        let reversal_id = Uuid::now_v7();
        let today = chrono::Utc::now().date_naive();
        let reversal = JournalEntry {
            id: reversal_id,
            date: today,
            description: format!("Reversal of: {}", original.description),
            status: JournalEntryStatus::Confirmed,
            source: "system:void".to_string(),
            voided_by: None,
            created_at: today,
        };

        // Reverse all line items (negate amounts)
        let reversal_items: Vec<LineItem> = items
            .iter()
            .map(|item| LineItem {
                id: Uuid::now_v7(),
                journal_entry_id: reversal_id,
                account_id: item.account_id,
                currency: item.currency.clone(),
                amount: -item.amount,
                lot_id: None,
            })
            .collect();

        self.storage.insert_journal_entry(&reversal, &reversal_items)?;
        self.storage.update_journal_entry_status(
            id,
            JournalEntryStatus::Voided,
            Some(reversal_id),
        )?;

        self.audit("void", "journal_entry", *id, &format!("reversed by {}", reversal_id))?;
        Ok(reversal)
    }

    pub fn get_journal_entry(
        &self,
        id: &Uuid,
    ) -> LedgerResult<Option<(JournalEntry, Vec<LineItem>)>> {
        Ok(self.storage.get_journal_entry(id)?)
    }

    pub fn query_journal_entries(
        &self,
        filter: &TransactionFilter,
    ) -> LedgerResult<Vec<(JournalEntry, Vec<LineItem>)>> {
        Ok(self.storage.query_journal_entries(filter)?)
    }

    // --- Balance operations ---

    pub fn get_account_balance(
        &self,
        account_id: &Uuid,
        as_of: Option<NaiveDate>,
    ) -> LedgerResult<Vec<CurrencyBalance>> {
        Ok(self.storage.sum_line_items(&[*account_id], as_of)?)
    }

    pub fn get_account_balance_with_children(
        &self,
        account_id: &Uuid,
        as_of: Option<NaiveDate>,
    ) -> LedgerResult<Vec<CurrencyBalance>> {
        let subtree = self.storage.get_account_subtree_ids(account_id)?;
        if subtree.is_empty() {
            return Ok(vec![]);
        }
        Ok(self.storage.sum_line_items(&subtree, as_of)?)
    }

    // --- Exchange rates ---

    pub fn record_exchange_rate(&self, rate: &ExchangeRate) -> LedgerResult<()> {
        self.storage.insert_exchange_rate(rate)?;
        Ok(())
    }

    pub fn get_exchange_rate(
        &self,
        from: &str,
        to: &str,
        date: NaiveDate,
    ) -> LedgerResult<Option<Decimal>> {
        Ok(self.storage.get_exchange_rate(from, to, date)?)
    }

    pub fn list_exchange_rates(
        &self,
        from: Option<&str>,
        to: Option<&str>,
    ) -> LedgerResult<Vec<ExchangeRate>> {
        Ok(self.storage.list_exchange_rates(from, to)?)
    }

    // --- Reports ---

    pub fn trial_balance(&self, as_of: NaiveDate) -> LedgerResult<reports::TrialBalance> {
        Ok(reports::trial_balance(&*self.storage, as_of)?)
    }

    pub fn income_statement(
        &self,
        from_date: NaiveDate,
        to_date: NaiveDate,
    ) -> LedgerResult<reports::IncomeStatement> {
        Ok(reports::income_statement(&*self.storage, from_date, to_date)?)
    }

    pub fn balance_sheet(&self, as_of: NaiveDate) -> LedgerResult<reports::BalanceSheet> {
        Ok(reports::balance_sheet(&*self.storage, as_of)?)
    }

    pub fn gain_loss_report(
        &self,
        from_date: NaiveDate,
        to_date: NaiveDate,
    ) -> LedgerResult<reports::GainLossReport> {
        Ok(reports::gain_loss_report(&*self.storage, from_date, to_date)?)
    }

    // --- Balance assertions ---

    pub fn check_balance_assertion(
        &self,
        assertion: &BalanceAssertion,
    ) -> LedgerResult<bool> {
        let balances = self.storage.sum_line_items(
            &[assertion.account_id],
            Some(assertion.date),
        )?;

        let actual = balances
            .iter()
            .find(|b| b.currency == assertion.currency)
            .map(|b| b.amount)
            .unwrap_or_default();

        let is_passing = actual == assertion.expected_balance;

        self.storage.insert_balance_assertion(assertion)?;
        self.storage.update_balance_assertion_result(
            &assertion.id,
            is_passing,
            actual,
        )?;

        Ok(is_passing)
    }

    // --- Metadata ---

    pub fn add_metadata(
        &self,
        journal_entry_id: &Uuid,
        key: &str,
        value: &str,
    ) -> LedgerResult<()> {
        self.storage.insert_metadata(journal_entry_id, key, value)?;
        Ok(())
    }

    pub fn get_metadata(&self, journal_entry_id: &Uuid) -> LedgerResult<Vec<Metadata>> {
        Ok(self.storage.get_metadata(journal_entry_id)?)
    }

    // --- Currency origins ---

    pub fn get_currency_origins(&self) -> LedgerResult<Vec<CurrencyOrigin>> {
        Ok(self.storage.get_currency_origins()?)
    }

    // --- Data management ---

    pub fn clear_exchange_rates(&self) -> LedgerResult<()> {
        self.storage.clear_exchange_rates()?;
        self.audit("clear", "exchange_rate", Uuid::nil(), "cleared all exchange rates")?;
        Ok(())
    }

    pub fn clear_ledger_data(&self) -> LedgerResult<()> {
        // Skip auditing since audit_log itself gets cleared
        self.storage.clear_ledger_data()?;
        Ok(())
    }

    pub fn clear_all_data(&self) -> LedgerResult<()> {
        // Skip auditing since audit_log itself gets cleared
        self.storage.clear_all_data()?;
        Ok(())
    }

    // --- Internal helpers ---

    fn audit(&self, action: &str, entity_type: &str, entity_id: Uuid, details: &str) -> LedgerResult<()> {
        let entry = AuditLogEntry {
            id: Uuid::now_v7(),
            timestamp: chrono::Utc::now().date_naive(),
            action: action.to_string(),
            entity_type: entity_type.to_string(),
            entity_id,
            details: details.to_string(),
        };
        self.storage.insert_audit_log(&entry)?;
        Ok(())
    }
}

/// Cost/proceeds information for automatic lot tracking.
pub struct LotCostInfo {
    /// Cost basis per unit in base currency (for acquisitions)
    pub cost_basis_per_unit: Option<Decimal>,
    /// Proceeds per unit in base currency (for disposals)
    pub proceeds_per_unit: Option<Decimal>,
}
