use wasmtime::component::bindgen;

use super::state::PluginState;

// Generate bindings from our WIT definitions for the "source" world.
// This generates all host interfaces (types, ledger-read, ledger-write, http-client,
// plugin-storage, logging) plus the source-ops and metadata exports.
bindgen!({
    world: "source",
    path: "../wit",
});

// Generate bindings for the "handler" world, reusing the shared interfaces
// from the source world bindings to avoid conflicting trait implementations.
pub mod handler_bindings {
    wasmtime::component::bindgen!({
        world: "handler",
        path: "../wit",
        with: {
            "dledger:plugin/types": super::dledger::plugin::types,
            "dledger:plugin/ledger-read": super::dledger::plugin::ledger_read,
            "dledger:plugin/plugin-storage": super::dledger::plugin::plugin_storage,
            "dledger:plugin/logging": super::dledger::plugin::logging,
        },
    });
}

// Use type aliases for convenience
use dledger::plugin::types::*;

// ---- Implement host interfaces for PluginState ----
// Only need to implement once since handler_bindings reuses the same traits via `with`.

impl dledger::plugin::types::Host for PluginState {}

impl dledger::plugin::ledger_read::Host for PluginState {
    fn list_accounts(&mut self) -> Result<Vec<AccountInfo>, HostError> {
        if !self.capabilities.ledger_read {
            return Err(HostError::PermissionDenied);
        }
        self.engine
            .list_accounts()
            .map(|accounts| {
                accounts
                    .into_iter()
                    .map(|a| AccountInfo {
                        id: a.id.to_string(),
                        full_name: a.full_name,
                        account_type: format!("{:?}", a.account_type).to_lowercase(),
                        is_postable: a.is_postable,
                    })
                    .collect()
            })
            .map_err(|e| {
                tracing::error!(plugin = %self.plugin_name, "list_accounts failed: {e}");
                HostError::Internal
            })
    }

    fn get_account(&mut self, id: String) -> Result<Option<AccountInfo>, HostError> {
        if !self.capabilities.ledger_read {
            return Err(HostError::PermissionDenied);
        }
        let uuid = uuid::Uuid::parse_str(&id).map_err(|_| HostError::InvalidInput)?;
        self.engine
            .get_account(&uuid)
            .map(|opt| {
                opt.map(|a| AccountInfo {
                    id: a.id.to_string(),
                    full_name: a.full_name,
                    account_type: format!("{:?}", a.account_type).to_lowercase(),
                    is_postable: a.is_postable,
                })
            })
            .map_err(|e| {
                tracing::error!(plugin = %self.plugin_name, "get_account failed: {e}");
                HostError::Internal
            })
    }

    fn query_transactions(
        &mut self,
        params: QueryParams,
    ) -> Result<Vec<Transaction>, HostError> {
        if !self.capabilities.ledger_read {
            return Err(HostError::PermissionDenied);
        }

        let filter = dledger_core::models::TransactionFilter {
            account_id: if params.account_filter.is_empty() {
                None
            } else {
                uuid::Uuid::parse_str(&params.account_filter).ok()
            },
            from_date: chrono::NaiveDate::parse_from_str(&params.from_date, "%Y-%m-%d").ok(),
            to_date: chrono::NaiveDate::parse_from_str(&params.to_date, "%Y-%m-%d").ok(),
            status: None,
            source: None,
            limit: Some(params.limit),
            offset: Some(params.offset),
        };

        self.engine
            .query_journal_entries(&filter)
            .map(|entries| {
                entries
                    .into_iter()
                    .map(|(je, items)| Transaction {
                        date: je.date.format("%Y-%m-%d").to_string(),
                        description: je.description,
                        postings: items
                            .into_iter()
                            .map(|li| Posting {
                                account: li.account_id.to_string(),
                                amount: Money {
                                    amount: li.amount.to_string(),
                                    currency: li.currency,
                                },
                            })
                            .collect(),
                        metadata: vec![],
                    })
                    .collect()
            })
            .map_err(|e| {
                tracing::error!(plugin = %self.plugin_name, "query_transactions failed: {e}");
                HostError::Internal
            })
    }

    fn get_balance(
        &mut self,
        account_id: String,
        as_of: String,
    ) -> Result<Vec<CurrencyBalance>, HostError> {
        if !self.capabilities.ledger_read {
            return Err(HostError::PermissionDenied);
        }
        let uuid = uuid::Uuid::parse_str(&account_id).map_err(|_| HostError::InvalidInput)?;
        let date = chrono::NaiveDate::parse_from_str(&as_of, "%Y-%m-%d").ok();
        self.engine
            .get_account_balance(&uuid, date)
            .map(|balances| {
                balances
                    .into_iter()
                    .map(|b| CurrencyBalance {
                        currency: b.currency,
                        amount: b.amount.to_string(),
                    })
                    .collect()
            })
            .map_err(|e| {
                tracing::error!(plugin = %self.plugin_name, "get_balance failed: {e}");
                HostError::Internal
            })
    }

    fn get_balance_with_children(
        &mut self,
        account_id: String,
        as_of: String,
    ) -> Result<Vec<CurrencyBalance>, HostError> {
        if !self.capabilities.ledger_read {
            return Err(HostError::PermissionDenied);
        }
        let uuid = uuid::Uuid::parse_str(&account_id).map_err(|_| HostError::InvalidInput)?;
        let date = chrono::NaiveDate::parse_from_str(&as_of, "%Y-%m-%d").ok();
        self.engine
            .get_account_balance_with_children(&uuid, date)
            .map(|balances| {
                balances
                    .into_iter()
                    .map(|b| CurrencyBalance {
                        currency: b.currency,
                        amount: b.amount.to_string(),
                    })
                    .collect()
            })
            .map_err(|e| {
                tracing::error!(plugin = %self.plugin_name, "get_balance_with_children failed: {e}");
                HostError::Internal
            })
    }

    fn get_exchange_rate(
        &mut self,
        from_currency: String,
        to_currency: String,
        date: String,
    ) -> Result<Option<String>, HostError> {
        if !self.capabilities.ledger_read {
            return Err(HostError::PermissionDenied);
        }
        let date = chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d")
            .map_err(|_| HostError::InvalidInput)?;
        self.engine
            .get_exchange_rate(&from_currency, &to_currency, date)
            .map(|opt| opt.map(|r| r.to_string()))
            .map_err(|e| {
                tracing::error!(plugin = %self.plugin_name, "get_exchange_rate failed: {e}");
                HostError::Internal
            })
    }
}

impl dledger::plugin::ledger_write::Host for PluginState {
    fn submit_transactions(
        &mut self,
        transactions: Vec<Transaction>,
    ) -> Result<u32, HostError> {
        if !self.capabilities.ledger_write {
            return Err(HostError::PermissionDenied);
        }

        let mut count = 0u32;
        for tx in transactions {
            let entry_id = uuid::Uuid::now_v7();
            let date = match chrono::NaiveDate::parse_from_str(&tx.date, "%Y-%m-%d") {
                Ok(d) => d,
                Err(_) => continue,
            };

            let entry = dledger_core::models::JournalEntry {
                id: entry_id,
                date,
                description: tx.description,
                status: dledger_core::models::JournalEntryStatus::Pending,
                source: format!("plugin:{}", self.plugin_name),
                voided_by: None,
                created_at: chrono::Utc::now().date_naive(),
            };

            let items: Vec<dledger_core::models::LineItem> = tx
                .postings
                .into_iter()
                .map(|p| {
                    let account_id =
                        uuid::Uuid::parse_str(&p.account).unwrap_or_else(|_| uuid::Uuid::nil());
                    let amount = p
                        .amount
                        .amount
                        .parse::<rust_decimal::Decimal>()
                        .unwrap_or_default();
                    dledger_core::models::LineItem {
                        id: uuid::Uuid::now_v7(),
                        journal_entry_id: entry_id,
                        account_id,
                        currency: p.amount.currency,
                        amount,
                        lot_id: None,
                    }
                })
                .collect();

            match self.engine.post_journal_entry(&entry, &items) {
                Ok(()) => count += 1,
                Err(e) => {
                    tracing::warn!(
                        plugin = %self.plugin_name,
                        "Failed to post transaction: {e}"
                    );
                }
            }
        }

        Ok(count)
    }

    fn submit_prices(&mut self, prices: Vec<PricePoint>) -> Result<u32, HostError> {
        if !self.capabilities.ledger_write {
            return Err(HostError::PermissionDenied);
        }

        let mut count = 0u32;
        for pp in prices {
            let date = match chrono::NaiveDate::parse_from_str(&pp.date, "%Y-%m-%d") {
                Ok(d) => d,
                Err(_) => continue,
            };
            let rate = match pp.rate.parse::<rust_decimal::Decimal>() {
                Ok(r) => r,
                Err(_) => continue,
            };
            let er = dledger_core::models::ExchangeRate {
                id: uuid::Uuid::now_v7(),
                from_currency: pp.from_currency,
                to_currency: pp.to_currency,
                rate,
                date,
                source: pp.source,
            };
            match self.engine.record_exchange_rate(&er) {
                Ok(()) => count += 1,
                Err(e) => {
                    tracing::warn!(
                        plugin = %self.plugin_name,
                        "Failed to record price: {e}"
                    );
                }
            }
        }

        Ok(count)
    }

    fn ensure_account(
        &mut self,
        full_name: String,
        account_type: String,
    ) -> Result<String, HostError> {
        if !self.capabilities.ledger_write {
            return Err(HostError::PermissionDenied);
        }

        let accounts = self.engine.list_accounts().map_err(|e| {
            tracing::error!(plugin = %self.plugin_name, "list_accounts failed: {e}");
            HostError::Internal
        })?;

        if let Some(existing) = accounts.iter().find(|a| a.full_name == full_name) {
            return Ok(existing.id.to_string());
        }

        let acct_type = match account_type.as_str() {
            "asset" => dledger_core::models::AccountType::Asset,
            "liability" => dledger_core::models::AccountType::Liability,
            "equity" => dledger_core::models::AccountType::Equity,
            "revenue" => dledger_core::models::AccountType::Revenue,
            "expense" => dledger_core::models::AccountType::Expense,
            _ => return Err(HostError::InvalidInput),
        };

        let name = full_name.rsplit(':').next().unwrap_or(&full_name).to_string();

        let account = dledger_core::models::Account {
            id: uuid::Uuid::now_v7(),
            parent_id: None,
            account_type: acct_type,
            name,
            full_name: full_name.clone(),
            allowed_currencies: vec![],
            is_postable: true,
            is_archived: false,
            created_at: chrono::Utc::now().date_naive(),
        };

        self.engine.create_account(&account).map_err(|e| {
            tracing::error!(plugin = %self.plugin_name, "create account '{full_name}': {e}");
            HostError::Internal
        })?;

        Ok(account.id.to_string())
    }
}

impl dledger::plugin::http_client::Host for PluginState {
    fn send(&mut self, request: HttpRequest) -> Result<HttpResponse, HostError> {
        if !self.capabilities.http {
            return Err(HostError::PermissionDenied);
        }

        if !self.capabilities.is_domain_allowed(&request.url) {
            tracing::warn!(plugin = %self.plugin_name, url = %request.url, "Domain not in allowlist");
            return Err(HostError::DomainNotAllowed);
        }

        if !self.rate_limiter.try_acquire() {
            return Err(HostError::RateLimited);
        }

        let method = match request.method.to_uppercase().as_str() {
            "GET" => reqwest::Method::GET,
            "POST" => reqwest::Method::POST,
            "PUT" => reqwest::Method::PUT,
            "DELETE" => reqwest::Method::DELETE,
            "PATCH" => reqwest::Method::PATCH,
            "HEAD" => reqwest::Method::HEAD,
            _ => return Err(HostError::InvalidInput),
        };

        let url = reqwest::Url::parse(&request.url).map_err(|_| HostError::InvalidInput)?;

        let mut req_builder = self.http_client.request(method, url);
        for (key, value) in &request.headers {
            req_builder = req_builder.header(key.as_str(), value.as_str());
        }
        if !request.body.is_empty() {
            req_builder = req_builder.body(request.body);
        }

        let rt = tokio::runtime::Handle::try_current();
        let response = match &rt {
            Ok(handle) => tokio::task::block_in_place(|| handle.block_on(req_builder.send())),
            Err(_) => {
                let rt = tokio::runtime::Runtime::new().map_err(|_| HostError::Internal)?;
                rt.block_on(req_builder.send())
            }
        };

        let resp = response.map_err(|e| {
            tracing::error!(plugin = %self.plugin_name, "HTTP request failed: {e}");
            HostError::NetworkError
        })?;

        let status = resp.status().as_u16();
        let headers: Vec<(String, String)> = resp
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();

        let body_bytes = match &rt {
            Ok(handle) => tokio::task::block_in_place(|| handle.block_on(resp.bytes())),
            Err(_) => {
                let rt = tokio::runtime::Runtime::new().map_err(|_| HostError::Internal)?;
                rt.block_on(resp.bytes())
            }
        };

        let body = body_bytes.map_err(|e| {
            tracing::error!(plugin = %self.plugin_name, "HTTP body read failed: {e}");
            HostError::NetworkError
        })?;

        Ok(HttpResponse {
            status,
            headers,
            body: body.to_vec(),
        })
    }
}

impl dledger::plugin::plugin_storage::Host for PluginState {
    fn get(&mut self, key: String) -> Result<Option<String>, HostError> {
        self.kv_storage.get(&self.plugin_id, &key).map_err(|e| {
            tracing::error!(plugin = %self.plugin_name, "KV get failed: {e}");
            HostError::Internal
        })
    }

    fn set(&mut self, key: String, value: String) -> Result<(), HostError> {
        self.kv_storage.set(&self.plugin_id, &key, &value).map_err(|e| {
            tracing::error!(plugin = %self.plugin_name, "KV set failed: {e}");
            HostError::Internal
        })
    }

    fn delete(&mut self, key: String) -> Result<(), HostError> {
        self.kv_storage.delete(&self.plugin_id, &key).map_err(|e| {
            tracing::error!(plugin = %self.plugin_name, "KV delete failed: {e}");
            HostError::Internal
        })
    }

    fn list_keys(&mut self) -> Result<Vec<String>, HostError> {
        self.kv_storage.list_keys(&self.plugin_id).map_err(|e| {
            tracing::error!(plugin = %self.plugin_name, "KV list_keys failed: {e}");
            HostError::Internal
        })
    }
}

impl dledger::plugin::logging::Host for PluginState {
    fn debug(&mut self, message: String) {
        tracing::debug!(plugin = %self.plugin_name, "{message}");
    }

    fn info(&mut self, message: String) {
        tracing::info!(plugin = %self.plugin_name, "{message}");
    }

    fn warn(&mut self, message: String) {
        tracing::warn!(plugin = %self.plugin_name, "{message}");
    }

    fn error(&mut self, message: String) {
        tracing::error!(plugin = %self.plugin_name, "{message}");
    }
}
