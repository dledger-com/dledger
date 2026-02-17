use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use wasmtime::component::{Component, Linker};
use wasmtime::{Config, Engine, Store};

use dledger_core::LedgerEngine;

use super::capabilities::GrantedCapabilities;
use super::host_impl::{Source, handler_bindings::Handler};
use super::manifest::PluginManifest;
use super::state::PluginState;
use super::storage::PluginKvStorage;

/// Information about a discovered plugin.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub kind: String,
    pub capabilities: PluginCapabilitySummary,
    pub enabled: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PluginCapabilitySummary {
    pub ledger_read: bool,
    pub ledger_write: bool,
    pub http: bool,
    pub allowed_domains: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ConfigFieldInfo {
    pub key: String,
    pub label: String,
    pub field_type: String,
    pub required: bool,
    pub default_value: String,
    pub description: String,
    pub options: String,
}

/// Manages plugin discovery, loading, and execution.
pub struct PluginManager {
    wasm_engine: Engine,
    plugins_dir: PathBuf,
    kv_storage: Arc<PluginKvStorage>,
    ledger_engine: Arc<LedgerEngine>,
    http_client: reqwest::Client,
    manifests: HashMap<String, PluginManifest>,
    components: HashMap<String, Component>,
    configs: HashMap<String, Vec<(String, String)>>,
}

impl PluginManager {
    pub fn new(
        plugins_dir: PathBuf,
        kv_db_path: &str,
        ledger_engine: Arc<LedgerEngine>,
    ) -> Result<Self, String> {
        let mut config = Config::new();
        config.wasm_component_model(true);
        config.consume_fuel(true);

        let wasm_engine =
            Engine::new(&config).map_err(|e| format!("Failed to create Wasmtime engine: {e}"))?;

        let kv_storage = Arc::new(PluginKvStorage::new(kv_db_path)?);

        Ok(Self {
            wasm_engine,
            plugins_dir,
            kv_storage,
            ledger_engine,
            http_client: reqwest::Client::new(),
            manifests: HashMap::new(),
            components: HashMap::new(),
            configs: HashMap::new(),
        })
    }

    /// Discover plugins in the plugins directory.
    pub fn discover(&mut self) -> Result<Vec<PluginInfo>, String> {
        self.manifests.clear();
        self.components.clear();

        if !self.plugins_dir.exists() {
            std::fs::create_dir_all(&self.plugins_dir)
                .map_err(|e| format!("Failed to create plugins dir: {e}"))?;
            return Ok(vec![]);
        }

        let entries = std::fs::read_dir(&self.plugins_dir)
            .map_err(|e| format!("Failed to read plugins dir: {e}"))?;

        let mut infos = Vec::new();

        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };

            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let manifest_path = path.join("plugin.toml");
            let wasm_path = path.join("plugin.wasm");

            if !manifest_path.exists() || !wasm_path.exists() {
                continue;
            }

            let manifest = match PluginManifest::from_file(&manifest_path) {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!("Failed to load plugin at {}: {e}", path.display());
                    continue;
                }
            };

            let component = match Component::from_file(&self.wasm_engine, &wasm_path) {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!("Failed to compile plugin at {}: {e}", path.display());
                    continue;
                }
            };

            let plugin_id = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string();

            let info = PluginInfo {
                id: plugin_id.clone(),
                name: manifest.plugin.name.clone(),
                version: manifest.plugin.version.clone(),
                description: manifest.plugin.description.clone(),
                author: manifest.plugin.author.clone(),
                kind: manifest.plugin.kind.clone(),
                capabilities: PluginCapabilitySummary {
                    ledger_read: manifest.capabilities.ledger_read,
                    ledger_write: manifest.capabilities.ledger_write,
                    http: manifest.capabilities.http,
                    allowed_domains: manifest.allowed_domains(),
                },
                enabled: true,
            };

            self.manifests.insert(plugin_id.clone(), manifest);
            self.components.insert(plugin_id, component);
            infos.push(info);
        }

        Ok(infos)
    }

    /// List all discovered plugins.
    pub fn list_plugins(&self) -> Vec<PluginInfo> {
        self.manifests
            .iter()
            .map(|(id, manifest)| PluginInfo {
                id: id.clone(),
                name: manifest.plugin.name.clone(),
                version: manifest.plugin.version.clone(),
                description: manifest.plugin.description.clone(),
                author: manifest.plugin.author.clone(),
                kind: manifest.plugin.kind.clone(),
                capabilities: PluginCapabilitySummary {
                    ledger_read: manifest.capabilities.ledger_read,
                    ledger_write: manifest.capabilities.ledger_write,
                    http: manifest.capabilities.http,
                    allowed_domains: manifest.allowed_domains(),
                },
                enabled: true,
            })
            .collect()
    }

    /// Get the config schema from a plugin.
    pub fn get_config_schema(&self, plugin_id: &str) -> Result<Vec<ConfigFieldInfo>, String> {
        let manifest = self
            .manifests
            .get(plugin_id)
            .ok_or_else(|| format!("Plugin '{plugin_id}' not found"))?;

        let component = self
            .components
            .get(plugin_id)
            .ok_or_else(|| format!("Plugin '{plugin_id}' component not loaded"))?;

        let caps = GrantedCapabilities::from_declaration(&manifest.capabilities);
        let mut store = self.create_store(plugin_id, &manifest.plugin.name, &caps);

        match manifest.plugin.kind.as_str() {
            "source" => {
                let mut linker = Linker::new(&self.wasm_engine);
                self.add_source_imports(&mut linker)
                    .map_err(|e| format!("Failed to link: {e}"))?;

                let instance = Source::instantiate(&mut store, component, &linker)
                    .map_err(|e| format!("Failed to instantiate: {e}"))?;

                let fields = instance
                    .dledger_plugin_source_ops()
                    .call_config_schema(&mut store)
                    .map_err(|e| format!("Failed to get config schema: {e}"))?;

                Ok(fields
                    .into_iter()
                    .map(|f| ConfigFieldInfo {
                        key: f.key,
                        label: f.label,
                        field_type: f.field_type,
                        required: f.required,
                        default_value: f.default_value,
                        description: f.description,
                        options: f.options,
                    })
                    .collect())
            }
            "handler" => {
                let mut linker = Linker::new(&self.wasm_engine);
                self.add_handler_imports(&mut linker)
                    .map_err(|e| format!("Failed to link: {e}"))?;

                let instance = Handler::instantiate(&mut store, component, &linker)
                    .map_err(|e| format!("Failed to instantiate: {e}"))?;

                let fields = instance
                    .dledger_plugin_handler_ops()
                    .call_config_schema(&mut store)
                    .map_err(|e| format!("Failed to get config schema: {e}"))?;

                Ok(fields
                    .into_iter()
                    .map(|f| ConfigFieldInfo {
                        key: f.key,
                        label: f.label,
                        field_type: f.field_type,
                        required: f.required,
                        default_value: f.default_value,
                        description: f.description,
                        options: f.options,
                    })
                    .collect())
            }
            other => Err(format!("Unknown plugin kind: {other}")),
        }
    }

    /// Configure a plugin with user-provided key-value pairs.
    pub fn configure_plugin(
        &mut self,
        plugin_id: &str,
        config: Vec<(String, String)>,
    ) -> Result<(), String> {
        let manifest = self
            .manifests
            .get(plugin_id)
            .ok_or_else(|| format!("Plugin '{plugin_id}' not found"))?
            .clone();
        let component = self
            .components
            .get(plugin_id)
            .ok_or_else(|| format!("Plugin '{plugin_id}' component not loaded"))?;

        let caps = GrantedCapabilities::from_declaration(&manifest.capabilities);
        let mut store = self.create_store(plugin_id, &manifest.plugin.name, &caps);

        match manifest.plugin.kind.as_str() {
            "source" => {
                let mut linker = Linker::new(&self.wasm_engine);
                self.add_source_imports(&mut linker)
                    .map_err(|e| format!("Failed to link: {e}"))?;

                let instance = Source::instantiate(&mut store, component, &linker)
                    .map_err(|e| format!("Failed to instantiate: {e}"))?;

                instance
                    .dledger_plugin_source_ops()
                    .call_configure(&mut store, &config)
                    .map_err(|e| format!("Failed to call configure: {e}"))?
                    .map_err(|e| format!("Plugin configuration error: {e}"))?;
            }
            "handler" => {
                let mut linker = Linker::new(&self.wasm_engine);
                self.add_handler_imports(&mut linker)
                    .map_err(|e| format!("Failed to link: {e}"))?;

                let instance = Handler::instantiate(&mut store, component, &linker)
                    .map_err(|e| format!("Failed to instantiate: {e}"))?;

                instance
                    .dledger_plugin_handler_ops()
                    .call_configure(&mut store, &config)
                    .map_err(|e| format!("Failed to call configure: {e}"))?
                    .map_err(|e| format!("Plugin configuration error: {e}"))?;
            }
            other => return Err(format!("Unknown plugin kind: {other}")),
        }

        self.configs.insert(plugin_id.to_string(), config);
        Ok(())
    }

    /// Run a sync operation on a source plugin.
    pub fn sync_source(
        &self,
        plugin_id: &str,
    ) -> Result<super::host_impl::dledger::plugin::types::SyncResult, String> {
        let manifest = self
            .manifests
            .get(plugin_id)
            .ok_or_else(|| format!("Plugin '{plugin_id}' not found"))?;

        if manifest.plugin.kind != "source" {
            return Err(format!("Plugin '{plugin_id}' is not a source plugin"));
        }

        let component = self
            .components
            .get(plugin_id)
            .ok_or_else(|| format!("Plugin '{plugin_id}' component not loaded"))?;

        let caps = GrantedCapabilities::from_declaration(&manifest.capabilities);
        let mut store = self.create_store(plugin_id, &manifest.plugin.name, &caps);

        let mut linker = Linker::new(&self.wasm_engine);
        self.add_source_imports(&mut linker)
            .map_err(|e| format!("Failed to link: {e}"))?;

        let instance = Source::instantiate(&mut store, component, &linker)
            .map_err(|e| format!("Failed to instantiate: {e}"))?;

        // Restore config
        if let Some(config) = self.configs.get(plugin_id) {
            instance
                .dledger_plugin_source_ops()
                .call_configure(&mut store, config)
                .map_err(|e| format!("Failed to configure: {e}"))?
                .map_err(|e| format!("Config error: {e}"))?;
        }

        // Load previous sync state from KV storage
        let prev_cursor = self
            .kv_storage
            .get(plugin_id, "__sync_cursor__")
            .unwrap_or(None)
            .unwrap_or_default();

        let sync_state = super::host_impl::dledger::plugin::types::SyncState {
            cursor: prev_cursor,
        };

        let result = instance
            .dledger_plugin_source_ops()
            .call_sync(&mut store, &sync_state)
            .map_err(|e| format!("Sync call failed: {e}"))?
            .map_err(|e| format!("Sync error: {e}"))?;

        // Persist new sync state
        if !result.new_state.cursor.is_empty() {
            self.kv_storage
                .set(plugin_id, "__sync_cursor__", &result.new_state.cursor)
                .map_err(|e| format!("Failed to save sync state: {e}"))?;
        }

        Ok(result)
    }

    /// Run a handler's process function.
    pub fn run_handler(&self, plugin_id: &str, params: &str) -> Result<String, String> {
        let manifest = self
            .manifests
            .get(plugin_id)
            .ok_or_else(|| format!("Plugin '{plugin_id}' not found"))?;

        if manifest.plugin.kind != "handler" {
            return Err(format!("Plugin '{plugin_id}' is not a handler plugin"));
        }

        let component = self
            .components
            .get(plugin_id)
            .ok_or_else(|| format!("Plugin '{plugin_id}' component not loaded"))?;

        let caps = GrantedCapabilities::from_declaration(&manifest.capabilities);
        let mut store = self.create_store(plugin_id, &manifest.plugin.name, &caps);

        let mut linker = Linker::new(&self.wasm_engine);
        self.add_handler_imports(&mut linker)
            .map_err(|e| format!("Failed to link: {e}"))?;

        let instance = Handler::instantiate(&mut store, component, &linker)
            .map_err(|e| format!("Failed to instantiate: {e}"))?;

        if let Some(config) = self.configs.get(plugin_id) {
            instance
                .dledger_plugin_handler_ops()
                .call_configure(&mut store, config)
                .map_err(|e| format!("Failed to configure: {e}"))?
                .map_err(|e| format!("Config error: {e}"))?;
        }

        instance
            .dledger_plugin_handler_ops()
            .call_process(&mut store, params)
            .map_err(|e| format!("Process call failed: {e}"))?
            .map_err(|e| format!("Process error: {e}"))
    }

    /// Generate a report from a handler plugin.
    pub fn generate_report(
        &self,
        plugin_id: &str,
        format: &str,
        params: &str,
    ) -> Result<Vec<u8>, String> {
        let manifest = self
            .manifests
            .get(plugin_id)
            .ok_or_else(|| format!("Plugin '{plugin_id}' not found"))?;

        if manifest.plugin.kind != "handler" {
            return Err(format!("Plugin '{plugin_id}' is not a handler plugin"));
        }

        let component = self
            .components
            .get(plugin_id)
            .ok_or_else(|| format!("Plugin '{plugin_id}' component not loaded"))?;

        let caps = GrantedCapabilities::from_declaration(&manifest.capabilities);
        let mut store = self.create_store(plugin_id, &manifest.plugin.name, &caps);

        let mut linker = Linker::new(&self.wasm_engine);
        self.add_handler_imports(&mut linker)
            .map_err(|e| format!("Failed to link: {e}"))?;

        let instance = Handler::instantiate(&mut store, component, &linker)
            .map_err(|e| format!("Failed to instantiate: {e}"))?;

        if let Some(config) = self.configs.get(plugin_id) {
            instance
                .dledger_plugin_handler_ops()
                .call_configure(&mut store, config)
                .map_err(|e| format!("Failed to configure: {e}"))?
                .map_err(|e| format!("Config error: {e}"))?;
        }

        instance
            .dledger_plugin_handler_ops()
            .call_generate_report(&mut store, format, params)
            .map_err(|e| format!("Report generation failed: {e}"))?
            .map_err(|e| format!("Report error: {e}"))
    }

    // ---- Private helpers ----

    fn create_store(
        &self,
        plugin_id: &str,
        plugin_name: &str,
        caps: &GrantedCapabilities,
    ) -> Store<PluginState> {
        let state = PluginState::new(
            plugin_id.to_string(),
            plugin_name.to_string(),
            caps.clone(),
            self.ledger_engine.clone(),
            self.kv_storage.clone(),
            self.http_client.clone(),
        );
        let mut store = Store::new(&self.wasm_engine, state);
        store.set_fuel(caps.max_fuel).ok();
        store
    }

    fn add_source_imports(
        &self,
        linker: &mut Linker<PluginState>,
    ) -> wasmtime::Result<()> {
        wasmtime_wasi::p2::add_to_linker_sync(linker)?;
        Source::add_to_linker::<_, wasmtime::component::HasSelf<PluginState>>(linker, |state| state)
    }

    fn add_handler_imports(
        &self,
        linker: &mut Linker<PluginState>,
    ) -> wasmtime::Result<()> {
        wasmtime_wasi::p2::add_to_linker_sync(linker)?;
        Handler::add_to_linker::<_, wasmtime::component::HasSelf<PluginState>>(linker, |state| state)
    }
}
