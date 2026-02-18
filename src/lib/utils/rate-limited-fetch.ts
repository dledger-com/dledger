export interface RateLimiterConfig {
  maxRequests: number;
  intervalMs: number;
}

interface QueueEntry {
  input: RequestInfo | URL;
  init: RequestInit | undefined;
  resolve: (value: Response) => void;
  reject: (reason: unknown) => void;
  retries: number;
}

const MAX_RETRIES = 3;
const DEFAULT_RETRY_MS = 5_000;

export class RateLimitedFetcher {
  private tokens: number;
  private queue: QueueEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly replenishMs: number;

  constructor(config: RateLimiterConfig) {
    this.tokens = config.maxRequests;
    this.replenishMs = config.intervalMs / config.maxRequests;
    this.timer = setInterval(() => this.replenish(), this.replenishMs);
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (this.disposed) throw new Error("RateLimitedFetcher has been disposed");

    return new Promise<Response>((resolve, reject) => {
      this.queue.push({ input, init, resolve, reject, retries: 0 });
      this.drain();
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const entry of this.queue) {
      entry.reject(new Error("RateLimitedFetcher disposed"));
    }
    this.queue = [];
  }

  private replenish(): void {
    if (this.tokens < 1) {
      this.tokens++;
    }
    this.drain();
  }

  private drain(): void {
    while (this.queue.length > 0 && this.tokens > 0) {
      this.tokens--;
      const entry = this.queue.shift()!;
      this.execute(entry);
    }
  }

  private async execute(entry: QueueEntry): Promise<void> {
    try {
      const resp = await fetch(entry.input, entry.init);
      if (resp.status === 429 && entry.retries < MAX_RETRIES) {
        const retryAfter = resp.headers.get("Retry-After");
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : DEFAULT_RETRY_MS;
        entry.retries++;
        await new Promise((r) => setTimeout(r, isNaN(waitMs) ? DEFAULT_RETRY_MS : waitMs));
        this.queue.unshift(entry);
        this.drain();
      } else {
        entry.resolve(resp);
      }
    } catch (err) {
      entry.reject(err);
    }
  }
}
