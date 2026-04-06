use std::collections::HashMap;

use rust_decimal::Decimal;
use uuid::Uuid;

use crate::models::*;
use crate::storage::Storage;

/// Errors from validation.
#[derive(Debug, thiserror::Error)]
pub enum ValidationError {
    #[error("journal entry has no line items")]
    EmptyEntry,

    #[error("journal entry does not balance for currency {currency}: sum is {sum}")]
    Unbalanced { currency: String, sum: Decimal },

    #[error("account {account_id} does not exist")]
    AccountNotFound { account_id: Uuid },

    #[error("account {account_id} is not postable")]
    AccountNotPostable { account_id: Uuid },

    #[error("account {account_id} is archived")]
    AccountArchived { account_id: Uuid },

    #[error("account {account_id} does not allow currency {currency}")]
    CurrencyNotAllowed { account_id: Uuid, currency: String },

    #[error("currency {code} does not exist")]
    CurrencyNotFound { code: String },

    #[error("line item amount cannot be zero")]
    ZeroAmount,

    #[error("duplicate line item ID {id}")]
    DuplicateLineItemId { id: Uuid },

    #[error("storage error: {0}")]
    Storage(#[from] crate::storage::StorageError),
}

pub type ValidationResult<T> = Result<T, ValidationError>;

/// Validate that a set of line items balances per currency (SUM = 0 for each currency).
pub fn validate_balancing(items: &[LineItem]) -> ValidationResult<()> {
    if items.is_empty() {
        return Err(ValidationError::EmptyEntry);
    }

    let mut sums: HashMap<&str, Decimal> = HashMap::new();
    for item in items {
        if item.amount.is_zero() {
            return Err(ValidationError::ZeroAmount);
        }
        *sums.entry(&item.currency).or_default() += item.amount;
    }

    for (currency, sum) in &sums {
        if !sum.is_zero() {
            return Err(ValidationError::Unbalanced {
                currency: currency.to_string(),
                sum: *sum,
            });
        }
    }

    Ok(())
}

/// Validate that all accounts referenced in line items exist, are postable, and accept
/// the given currencies.
pub fn validate_accounts(
    items: &[LineItem],
    storage: &dyn Storage,
) -> ValidationResult<()> {
    // Deduplicate account lookups
    let account_ids: Vec<Uuid> = items.iter().map(|i| i.account_id).collect::<std::collections::HashSet<_>>().into_iter().collect();

    for account_id in &account_ids {
        let account = storage
            .get_account(account_id)?
            .ok_or(ValidationError::AccountNotFound { account_id: *account_id })?;

        if !account.is_postable {
            return Err(ValidationError::AccountNotPostable { account_id: *account_id });
        }

        if account.is_archived {
            return Err(ValidationError::AccountArchived { account_id: *account_id });
        }

        // Check currency restrictions for this account
        if !account.allowed_currencies.is_empty() {
            for item in items.iter().filter(|i| i.account_id == *account_id) {
                if !account.allowed_currencies.contains(&item.currency) {
                    return Err(ValidationError::CurrencyNotAllowed {
                        account_id: *account_id,
                        currency: item.currency.clone(),
                    });
                }
            }
        }
    }

    Ok(())
}

/// Validate that all currencies referenced in line items exist.
pub fn validate_currencies(
    items: &[LineItem],
    storage: &dyn Storage,
) -> ValidationResult<()> {
    let currencies: std::collections::HashSet<&str> =
        items.iter().map(|i| i.currency.as_str()).collect();

    for code in currencies {
        if storage.get_currency(code)?.is_none() {
            return Err(ValidationError::CurrencyNotFound {
                code: code.to_string(),
            });
        }
    }

    Ok(())
}

/// Validate that all line item IDs are unique.
pub fn validate_unique_ids(items: &[LineItem]) -> ValidationResult<()> {
    let mut seen = std::collections::HashSet::new();
    for item in items {
        if !seen.insert(item.id) {
            return Err(ValidationError::DuplicateLineItemId { id: item.id });
        }
    }
    Ok(())
}

/// Run all validations for a new journal entry.
pub fn validate_journal_entry(
    items: &[LineItem],
    storage: &dyn Storage,
) -> ValidationResult<()> {
    validate_balancing(items)?;
    validate_unique_ids(items)?;
    validate_currencies(items, storage)?;
    validate_accounts(items, storage)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn make_item(currency: &str, amount: Decimal, account_id: Uuid) -> LineItem {
        LineItem {
            id: Uuid::now_v7(),
            journal_entry_id: Uuid::now_v7(),
            account_id,
            currency: currency.to_string(),
            currency_asset_type: String::new(),
            currency_param: String::new(),
            amount,
            lot_id: None,
        }
    }

    #[test]
    fn test_balanced_single_currency() {
        let acc1 = Uuid::now_v7();
        let acc2 = Uuid::now_v7();
        let items = vec![
            make_item("EUR", dec!(100.00), acc1),
            make_item("EUR", dec!(-100.00), acc2),
        ];
        assert!(validate_balancing(&items).is_ok());
    }

    #[test]
    fn test_unbalanced_single_currency() {
        let acc1 = Uuid::now_v7();
        let acc2 = Uuid::now_v7();
        let items = vec![
            make_item("EUR", dec!(100.00), acc1),
            make_item("EUR", dec!(-50.00), acc2),
        ];
        let err = validate_balancing(&items).unwrap_err();
        assert!(matches!(err, ValidationError::Unbalanced { .. }));
    }

    #[test]
    fn test_balanced_multi_currency() {
        let acc1 = Uuid::now_v7();
        let acc2 = Uuid::now_v7();
        let items = vec![
            make_item("EUR", dec!(100.00), acc1),
            make_item("EUR", dec!(-100.00), acc2),
            make_item("BTC", dec!(0.005), acc1),
            make_item("BTC", dec!(-0.005), acc2),
        ];
        assert!(validate_balancing(&items).is_ok());
    }

    #[test]
    fn test_empty_entry_rejected() {
        let items: Vec<LineItem> = vec![];
        let err = validate_balancing(&items).unwrap_err();
        assert!(matches!(err, ValidationError::EmptyEntry));
    }

    #[test]
    fn test_zero_amount_rejected() {
        let acc1 = Uuid::now_v7();
        let items = vec![make_item("EUR", dec!(0), acc1)];
        let err = validate_balancing(&items).unwrap_err();
        assert!(matches!(err, ValidationError::ZeroAmount));
    }

    #[test]
    fn test_duplicate_line_item_ids() {
        let id = Uuid::now_v7();
        let acc1 = Uuid::now_v7();
        let items = vec![
            LineItem {
                id,
                journal_entry_id: Uuid::now_v7(),
                account_id: acc1,
                currency: "EUR".to_string(),
                currency_asset_type: String::new(),
                currency_param: String::new(),
                amount: dec!(100),
                lot_id: None,
            },
            LineItem {
                id, // same ID
                journal_entry_id: Uuid::now_v7(),
                account_id: acc1,
                currency: "EUR".to_string(),
                currency_asset_type: String::new(),
                currency_param: String::new(),
                amount: dec!(-100),
                lot_id: None,
            },
        ];
        let err = validate_unique_ids(&items).unwrap_err();
        assert!(matches!(err, ValidationError::DuplicateLineItemId { .. }));
    }
}
