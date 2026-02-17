import type { Extension, ConfigField } from "$lib/types/index.js";
import { getBackend } from "$lib/backend.js";

export class ExtensionStore {
  extensions = $state<Extension[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);

  readonly enabled = $derived(this.extensions.filter((e) => e.enabled));

  readonly byId = $derived(
    new Map(this.extensions.map((e) => [e.id, e])),
  );

  readonly sources = $derived(this.extensions.filter((e) => e.kind === "source"));
  readonly handlers = $derived(this.extensions.filter((e) => e.kind === "handler"));

  async load() {
    this.loading = true;
    this.error = null;
    try {
      this.extensions = await getBackend().listPlugins();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.extensions = [];
    } finally {
      this.loading = false;
    }
  }

  async getConfigSchema(id: string): Promise<ConfigField[]> {
    return getBackend().getPluginConfigSchema(id);
  }

  async configure(id: string, config: [string, string][]): Promise<void> {
    try {
      await getBackend().configurePlugin(id, config);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  async sync(id: string): Promise<string> {
    try {
      return await getBackend().syncPlugin(id);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  async resetAndSync(id: string): Promise<string> {
    try {
      await getBackend().resetPluginSync(id);
      return await getBackend().syncPlugin(id);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  async runHandler(id: string, params: string): Promise<string> {
    try {
      return await getBackend().runHandler(id, params);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  async generateReport(id: string, format: string, params: string): Promise<number[]> {
    try {
      return await getBackend().generateReport(id, format, params);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }
}
