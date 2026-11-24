export class TokenBucket {
  private tokens: number;
  private at?: number;
  private readonly limits: readonly [perSecond: number, burst: number];
  constructor(limits: readonly [perSecond: number, burst: number]) {
    this.limits = limits;
    this.tokens = limits[1];
  }
  take(now: number, cost = 1): boolean {
    const [rate, burst] = this.limits;
    this.tokens = Math.min(burst, this.tokens + (now - (this.at ?? now)) * rate / 1000);
    this.at = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

export function retainedBudget<T>(create: () => T) {
  const keys = new Map<string, { budget: T; at: number }>(), overflow = create();
  return {
    get(key: string, now: number): T {
      let entry = keys.get(key);
      if (!entry) {
        if (keys.size >= 4096) return overflow;
        keys.set(key, entry = { budget: create(), at: now });
      }
      entry.at = now;
      return entry.budget;
    },
    prune(now: number) {
      for (const [key, { at }] of keys) if (now - at >= 120_000) keys.delete(key);
    },
  };
}
