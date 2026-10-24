import type { RateLimitRule } from './config.js';

/**
 * In-memory sliding-window limiter. One process serves the whole party, so
 * there's no need for shared storage.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Records a hit; returns ms until retry if over the limit, else 0. */
  hit(key: string, rule: RateLimitRule): number {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - rule.windowMs);
    if (recent.length >= rule.count) {
      this.hits.set(key, recent);
      return recent[0]! + rule.windowMs - now;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(now, rule.windowMs);
    return 0;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private prune(now: number, windowMs: number) {
    for (const [k, times] of this.hits) {
      if (times.every((t) => t <= now - windowMs)) this.hits.delete(k);
    }
  }
}
