use rust_decimal::Decimal;
use uuid::Uuid;

use crate::models::*;
use crate::storage::{Storage, StorageError};

/// Errors specific to lot operations.
#[derive(Debug, thiserror::Error)]
pub enum LotError {
    #[error("insufficient lots for disposal: need {needed}, available {available} {currency} in account {account_id}")]
    InsufficientLots {
        account_id: Uuid,
        currency: String,
        needed: Decimal,
        available: Decimal,
    },

    #[error("lot {lot_id} not found")]
    LotNotFound { lot_id: Uuid },

    #[error("lot {lot_id} has insufficient remaining: need {needed}, have {remaining}")]
    LotInsufficient {
        lot_id: Uuid,
        needed: Decimal,
        remaining: Decimal,
    },

    #[error("no base currency defined")]
    NoBaseCurrency,

    #[error("no exchange rate found for {from}/{to} on {date}")]
    NoExchangeRate {
        from: String,
        to: String,
        date: String,
    },

    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
}

pub type LotResult<T> = Result<T, LotError>;

/// Create a new lot for an acquisition (debit to a non-base-currency asset account).
///
/// Returns the created Lot.
pub fn create_acquisition_lot(
    storage: &dyn Storage,
    account_id: Uuid,
    currency: &str,
    quantity: Decimal,
    cost_basis_per_unit: Decimal,
    cost_basis_currency: &str,
    journal_entry_id: Uuid,
    acquired_date: chrono::NaiveDate,
) -> LotResult<Lot> {
    let lot = Lot {
        id: Uuid::now_v7(),
        account_id,
        currency: currency.to_string(),
        acquired_date,
        original_quantity: quantity,
        remaining_quantity: quantity,
        cost_basis_per_unit,
        cost_basis_currency: cost_basis_currency.to_string(),
        journal_entry_id,
        is_closed: false,
    };
    storage.insert_lot(&lot)?;
    Ok(lot)
}

/// Dispose of lots using FIFO ordering.
///
/// Consumes open lots (oldest first) for the given account+currency until the
/// requested quantity is fulfilled. Creates LotDisposal records and updates
/// lot remaining quantities.
///
/// Returns the list of disposals created.
pub fn dispose_lots_fifo(
    storage: &dyn Storage,
    account_id: Uuid,
    currency: &str,
    quantity: Decimal,
    proceeds_per_unit: Decimal,
    proceeds_currency: &str,
    journal_entry_id: Uuid,
    disposal_date: chrono::NaiveDate,
) -> LotResult<Vec<LotDisposal>> {
    let open_lots = storage.get_open_lots_fifo(&account_id, currency)?;

    // Check total available
    let available: Decimal = open_lots.iter().map(|l| l.remaining_quantity).sum();
    if available < quantity {
        return Err(LotError::InsufficientLots {
            account_id,
            currency: currency.to_string(),
            needed: quantity,
            available,
        });
    }

    let mut remaining_to_dispose = quantity;
    let mut disposals = Vec::new();

    for lot in &open_lots {
        if remaining_to_dispose.is_zero() {
            break;
        }

        let dispose_from_this_lot = remaining_to_dispose.min(lot.remaining_quantity);
        let new_remaining = lot.remaining_quantity - dispose_from_this_lot;
        let is_closed = new_remaining.is_zero();

        // Calculate realized gain/loss for this partial disposal
        let cost = dispose_from_this_lot * lot.cost_basis_per_unit;
        let proceeds = dispose_from_this_lot * proceeds_per_unit;
        let realized_gain_loss = proceeds - cost;

        let disposal = LotDisposal {
            id: Uuid::now_v7(),
            lot_id: lot.id,
            journal_entry_id,
            quantity: dispose_from_this_lot,
            proceeds_per_unit,
            proceeds_currency: proceeds_currency.to_string(),
            realized_gain_loss,
            disposal_date,
        };

        storage.update_lot_remaining(&lot.id, new_remaining, is_closed)?;
        storage.insert_lot_disposal(&disposal)?;

        disposals.push(disposal);
        remaining_to_dispose -= dispose_from_this_lot;
    }

    Ok(disposals)
}

/// Dispose of a specific lot by ID.
pub fn dispose_specific_lot(
    storage: &dyn Storage,
    lot_id: Uuid,
    quantity: Decimal,
    proceeds_per_unit: Decimal,
    proceeds_currency: &str,
    journal_entry_id: Uuid,
    disposal_date: chrono::NaiveDate,
) -> LotResult<LotDisposal> {
    let lot = storage
        .get_lot(&lot_id)?
        .ok_or(LotError::LotNotFound { lot_id })?;

    if lot.remaining_quantity < quantity {
        return Err(LotError::LotInsufficient {
            lot_id,
            needed: quantity,
            remaining: lot.remaining_quantity,
        });
    }

    let new_remaining = lot.remaining_quantity - quantity;
    let is_closed = new_remaining.is_zero();

    let cost = quantity * lot.cost_basis_per_unit;
    let proceeds = quantity * proceeds_per_unit;
    let realized_gain_loss = proceeds - cost;

    let disposal = LotDisposal {
        id: Uuid::now_v7(),
        lot_id,
        journal_entry_id,
        quantity,
        proceeds_per_unit,
        proceeds_currency: proceeds_currency.to_string(),
        realized_gain_loss,
        disposal_date,
    };

    storage.update_lot_remaining(&lot_id, new_remaining, is_closed)?;
    storage.insert_lot_disposal(&disposal)?;

    Ok(disposal)
}
