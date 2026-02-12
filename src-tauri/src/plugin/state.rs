use std::sync::Arc;

use wasmtime::component::ResourceTable;
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

use super::capabilities::GrantedCapabilities;
use super::rate_limiter::RateLimiter;
use super::storage::PluginKvStorage;
use dledger_core::LedgerEngine;

/// Per-plugin store data held in the Wasmtime Store.
pub struct PluginState {
    pub plugin_id: String,
    pub plugin_name: String,
    pub capabilities: GrantedCapabilities,
    pub engine: Arc<LedgerEngine>,
    pub kv_storage: Arc<PluginKvStorage>,
    pub rate_limiter: Arc<RateLimiter>,
    pub http_client: reqwest::Client,
    pub wasi_ctx: WasiCtx,
    pub resource_table: ResourceTable,
}

impl PluginState {
    pub fn new(
        plugin_id: String,
        plugin_name: String,
        capabilities: GrantedCapabilities,
        engine: Arc<LedgerEngine>,
        kv_storage: Arc<PluginKvStorage>,
        http_client: reqwest::Client,
    ) -> Self {
        let rate_limiter = Arc::new(RateLimiter::new(capabilities.rate_limit));
        let wasi_ctx = WasiCtxBuilder::new().build();
        Self {
            plugin_id,
            plugin_name,
            capabilities,
            engine,
            kv_storage,
            rate_limiter,
            http_client,
            wasi_ctx,
            resource_table: ResourceTable::new(),
        }
    }
}

impl WasiView for PluginState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi_ctx,
            table: &mut self.resource_table,
        }
    }
}
