import type { ReprocessResult } from "$lib/handlers/index.js";

export interface ReprocessTarget {
  chainId: number;
  address: string;
  label: string;
}

class ReprocessStore {
  preview = $state<ReprocessResult | null>(null);
  target = $state<ReprocessTarget | null>(null);

  show(preview: ReprocessResult, target: ReprocessTarget | null) {
    this.preview = preview;
    this.target = target;
  }

  clear() {
    this.preview = null;
    this.target = null;
  }
}

export const reprocessStore = new ReprocessStore();
