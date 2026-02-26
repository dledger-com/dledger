/**
 * Main-thread API for ML-based transaction classification.
 *
 * Creates a Web Worker running Transformers.js, sends classification requests,
 * and returns results. Integrates with the app's TaskQueue for progress reporting.
 */

import type { TaskProgress } from "$lib/task-queue.svelte.js";

export interface ClassificationResult {
  description: string;
  account: string;
  confidence: number;
  method: "embedding" | "zero-shot";
}

interface PendingCallback {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

let idCounter = 0;

export class TransactionClassifier {
  private worker: Worker | null = null;
  private ready = false;
  private pendingCallbacks = new Map<string, PendingCallback>();

  private createWorker(): Worker {
    return new Worker(new URL("./classifier-worker.ts", import.meta.url), {
      type: "module",
    });
  }

  private sendMessage(type: string, payload: unknown): Promise<unknown> {
    if (!this.worker) throw new Error("Worker not initialized");

    const id = String(++idCounter);
    return new Promise((resolve, reject) => {
      this.pendingCallbacks.set(id, { resolve, reject });
      this.worker!.postMessage({ type, id, payload });
    });
  }

  /**
   * Initialize the classifier by loading ML models in the worker.
   * Downloads models from HuggingFace CDN on first use (cached thereafter).
   *
   * @param onProgress - Optional callback for progress updates (model download, loading)
   * @param loadZeroShot - Whether to also load the zero-shot model (default true)
   */
  async init(
    onProgress?: (p: TaskProgress) => void,
    loadZeroShot = true,
  ): Promise<void> {
    if (this.ready) return;

    this.worker = this.createWorker();
    this.worker.onmessage = (event) => {
      const { type, id, data, error, progress } = event.data;

      if (type === "progress" && onProgress) {
        onProgress(progress);
        return;
      }

      const pending = this.pendingCallbacks.get(id);
      if (!pending) return;

      this.pendingCallbacks.delete(id);
      if (type === "error") {
        pending.reject(new Error(error));
      } else {
        pending.resolve(data);
      }
    };

    this.worker.onerror = (event) => {
      // Reject all pending callbacks
      for (const [id, pending] of this.pendingCallbacks) {
        pending.reject(new Error(event.message || "Worker error"));
        this.pendingCallbacks.delete(id);
      }
    };

    await this.sendMessage("init", { loadZeroShot });
    this.ready = true;
  }

  /**
   * Classify a batch of transaction descriptions against a set of account names.
   *
   * @param descriptions - Transaction descriptions to classify
   * @param accounts - Full account paths (e.g., "Expenses:Groceries")
   * @param threshold - Minimum confidence (0-1) to accept a classification (default 0.5)
   * @param onProgress - Optional callback for progress updates
   * @returns Array of ClassificationResult, one per description
   */
  async classifyBatch(
    descriptions: string[],
    accounts: string[],
    threshold = 0.5,
    onProgress?: (p: TaskProgress) => void,
  ): Promise<ClassificationResult[]> {
    if (!this.ready || !this.worker) {
      throw new Error("Classifier not initialized — call init() first");
    }

    // Temporarily swap the progress handler for this batch
    const originalHandler = this.worker.onmessage;
    this.worker.onmessage = (event) => {
      const { type, id, data, error, progress } = event.data;

      if (type === "progress" && onProgress) {
        onProgress(progress);
        return;
      }

      const pending = this.pendingCallbacks.get(id);
      if (!pending) return;

      this.pendingCallbacks.delete(id);
      if (type === "error") {
        pending.reject(new Error(error));
      } else {
        pending.resolve(data);
      }
    };

    try {
      const results = (await this.sendMessage("classify-batch", {
        descriptions,
        accounts,
        threshold,
        zeroShotTopN: 5,
      })) as Array<{ account: string; confidence: number; method: "embedding" | "zero-shot" }>;

      return results.map((r, i) => ({
        description: descriptions[i],
        account: r.account,
        confidence: r.confidence,
        method: r.method,
      }));
    } finally {
      this.worker.onmessage = originalHandler;
    }
  }

  /** Release model resources and terminate the worker. */
  dispose(): void {
    if (this.worker) {
      try {
        this.worker.postMessage({ type: "dispose", id: "dispose" });
      } catch {
        // Worker may already be terminated
      }
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = false;
    this.pendingCallbacks.clear();
  }

  get isReady(): boolean {
    return this.ready;
  }
}
