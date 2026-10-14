/** Retry with exponential backoff + jitter for Google API quota (429) and transient failures. */
export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

export function isRetryable(err: unknown): boolean {
  const e = err as { code?: number | string; status?: number; response?: { status?: number }; message?: string; errors?: Array<{ reason?: string }> };
  const status = Number(e?.status ?? e?.response?.status ?? (typeof e?.code === 'number' ? e.code : NaN));
  if ([408, 429, 500, 502, 503, 504].includes(status)) return true;
  if (status === 403 && e?.errors?.some((x) => /rateLimit|quotaExceeded|userRateLimit/i.test(x.reason ?? ''))) return true;
  const code = typeof e?.code === 'string' ? e.code : '';
  if (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'ECONNABORTED'].includes(code)) return true;
  return /rate limit|quota exceeded|backend error|socket hang up/i.test(e?.message ?? '');
}

export async function withRetry<T>(fn: () => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const retries = o.retries ?? 6;
  const base = o.baseMs ?? 500;
  const max = o.maxMs ?? 32_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rnd = o.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const delay = Math.min(max, base * 2 ** attempt) + Math.floor(rnd() * 250);
      o.onRetry?.({ attempt: attempt + 1, delayMs: delay, error: err });
      await sleep(delay);
    }
  }
}

/** In-process FIFO mutex per key. Multi-instance deployments must additionally use the Apps Script LockService gateway. */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => gate);
    this.tails.set(key, tail);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/** Short-TTL read cache with in-flight coalescing (protects the Sheets read quota). */
export class ReadCache<T> {
  private store = new Map<string, { at: number; value: T }>();
  private inflight = new Map<string, Promise<T>>();
  /** bumped on every invalidation: a load that started before it must not store its (possibly stale) result */
  private generation = new Map<string, number>();
  constructor(private ttlMs: number, private now: () => number = Date.now) {}
  async get(key: string, load: () => Promise<T>, ttlMs = this.ttlMs): Promise<T> {
    const hit = this.store.get(key);
    if (hit && this.now() - hit.at < ttlMs) return hit.value;
    const running = this.inflight.get(key);
    if (running) return running;
    const gen = this.generation.get(key) ?? 0;
    const p: Promise<T> = load().then((v) => {
      if ((this.generation.get(key) ?? 0) === gen) this.store.set(key, { at: this.now(), value: v });
      return v;
    }).finally(() => { if (this.inflight.get(key) === p) this.inflight.delete(key); });
    this.inflight.set(key, p);
    return p;
  }
  /** drop one key and any load already running for it */
  delete(key: string): void {
    this.generation.set(key, (this.generation.get(key) ?? 0) + 1);
    this.store.delete(key);
    this.inflight.delete(key);
  }
  invalidate(prefix?: string): void {
    const keys = prefix ? [...this.store.keys(), ...this.inflight.keys()].filter((k) => k.startsWith(prefix)) : [...new Set([...this.store.keys(), ...this.inflight.keys()])];
    for (const k of keys) this.delete(k);
  }
}
