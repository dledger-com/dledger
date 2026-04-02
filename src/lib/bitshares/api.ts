// Bitshares raw WebSocket JSON-RPC client
// Connects to Graphene-based nodes, queries account history and asset metadata.

import type { BitsharesOperationEntry, BitsharesAssetInfo } from "./types.js";

const NODES = [
  "wss://node.xbts.io/ws",
  "wss://api.bts.mobi/ws",
  "wss://dex.iobanker.com/ws",
  "wss://api.bitshares.ws/ws",
];
const CONNECT_TIMEOUT = 10_000;
const CALL_TIMEOUT = 30_000;

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Lightweight Bitshares WebSocket JSON-RPC client.
 * Connect once per sync session, make calls, then disconnect.
 */
export class BitsharesClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private historyApiId = -1;
  private dbApiId = -1;
  private assetCache = new Map<string, BitsharesAssetInfo>();

  /** Connect to a Bitshares node, trying multiple nodes in order. */
  async connect(nodeUrl?: string): Promise<void> {
    const nodesToTry = nodeUrl ? [nodeUrl] : NODES;
    let lastError: Error | null = null;

    for (const url of nodesToTry) {
      try {
        await this.connectToNode(url);
        // Login (required before accessing API namespaces)
        await this.rpcCall(1, "login", ["", ""]);
        // Get API namespace IDs
        this.dbApiId = (await this.rpcCall(1, "database", [])) as number;
        this.historyApiId = (await this.rpcCall(1, "history", [])) as number;
        return;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        // Close failed connection before trying next
        if (this.ws) { this.ws.close(); this.ws = null; }
      }
    }

    throw lastError ?? new Error("Failed to connect to any Bitshares node");
  }

  private connectToNode(nodeUrl: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`WebSocket connection timeout (${nodeUrl})`));
      }, CONNECT_TIMEOUT);

      const ws = new WebSocket(nodeUrl);
      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`WebSocket connection failed (${nodeUrl})`));
      };
      ws.onmessage = (event) => {
        this.handleMessage(event.data as string);
      };
      ws.onclose = () => {
        for (const [id, call] of this.pending) {
          clearTimeout(call.timer);
          call.reject(new Error("WebSocket closed"));
          this.pending.delete(id);
        }
        this.ws = null;
      };
    });
  }

  /** Disconnect from the node. */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.assetCache.clear();
  }

  /** Send a JSON-RPC call and wait for the response. */
  private rpcCall(apiId: number, method: string, params: unknown[]): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("WebSocket not connected"));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC call timeout: ${method}`));
      }, CALL_TIMEOUT);

      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ id, method: "call", params: [apiId, method, params] }));
    });
  }

  /** Handle incoming WebSocket messages. */
  private handleMessage(data: string): void {
    let msg: { id?: number; result?: unknown; error?: { message: string } };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.id === undefined) return;

    const call = this.pending.get(msg.id);
    if (!call) return;
    this.pending.delete(msg.id);
    clearTimeout(call.timer);

    if (msg.error) {
      call.reject(new Error(`Bitshares RPC error: ${msg.error.message}`));
    } else {
      call.resolve(msg.result);
    }
  }

  // ── Public query methods ──

  /** Resolve an account name to its full account object. Returns null if not found. */
  async getAccountByName(name: string): Promise<{ id: string; name: string } | null> {
    const result = await this.rpcCall(this.dbApiId, "get_account_by_name", [name]);
    if (!result) return null;
    const account = result as { id: string; name: string };
    return { id: account.id, name: account.name };
  }

  /**
   * Fetch account operation history (paginated, newest first).
   * @param accountId - Graphene object ID (e.g., "1.2.849826")
   * @param stop - Oldest operation to retrieve ("1.11.0" = no lower bound)
   * @param limit - Max operations per request (max 100)
   * @param start - Most recent operation ("1.11.0" = latest)
   */
  async getAccountHistory(
    accountId: string,
    stop: string = "1.11.0",
    limit: number = 100,
    start: string = "1.11.0",
  ): Promise<BitsharesOperationEntry[]> {
    const result = await this.rpcCall(this.historyApiId, "get_account_history", [
      accountId, stop, limit, start,
    ]);
    return (result ?? []) as BitsharesOperationEntry[];
  }

  /**
   * Resolve asset IDs to symbol and precision. Results are cached per session.
   * @param assetIds - Array of Graphene asset IDs (e.g., ["1.3.0", "1.3.121"])
   */
  async getAssets(assetIds: string[]): Promise<Map<string, BitsharesAssetInfo>> {
    const uncached = assetIds.filter((id) => !this.assetCache.has(id));
    if (uncached.length > 0) {
      const result = (await this.rpcCall(this.dbApiId, "get_assets", [uncached])) as Array<{
        id: string;
        symbol: string;
        precision: number;
      } | null>;
      for (const asset of result) {
        if (asset) {
          this.assetCache.set(asset.id, {
            id: asset.id,
            symbol: asset.symbol,
            precision: asset.precision,
          });
        }
      }
    }

    const out = new Map<string, BitsharesAssetInfo>();
    for (const id of assetIds) {
      const cached = this.assetCache.get(id);
      if (cached) out.set(id, cached);
    }
    return out;
  }

  /**
   * Resolve a single asset ID. Returns cached if available.
   */
  async getAsset(assetId: string): Promise<BitsharesAssetInfo | null> {
    const map = await this.getAssets([assetId]);
    return map.get(assetId) ?? null;
  }

  /**
   * Get block header to extract timestamp.
   * @param blockNum - Block number
   */
  async getBlockHeader(blockNum: number): Promise<{ timestamp: string } | null> {
    const result = await this.rpcCall(this.dbApiId, "get_block_header", [blockNum]);
    if (!result) return null;
    return result as { timestamp: string };
  }
}
