import type { RequestPriority } from "../provider/types.js";

export interface RateLimiterOptions {
  maxCallsPerMinute: number;
  quotaReservePercent: number;
}

export interface RateLimiterClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface RateLimitObservation {
  remaining: number;
  limit: number;
  resetAt: number;
}

const systemClock: RateLimiterClock = {
  now: Date.now,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export class RateLimiter {
  private readonly clock: RateLimiterClock;
  private readonly spacing: number;
  private readonly reservePercent: number;
  private queue: Promise<void> = Promise.resolve();
  private lastStart: number | null = null;
  private quota: RateLimitObservation | null = null;
  private blockedUntil = 0;

  constructor(options: RateLimiterOptions, clock: RateLimiterClock = systemClock) {
    if (!Number.isFinite(options.maxCallsPerMinute) || options.maxCallsPerMinute <= 0) {
      throw new Error("maxCallsPerMinute must be positive");
    }
    if (options.quotaReservePercent < 0 || options.quotaReservePercent > 100) {
      throw new Error("quotaReservePercent must be between 0 and 100");
    }
    this.spacing = 60_000 / options.maxCallsPerMinute;
    this.reservePercent = options.quotaReservePercent;
    this.clock = clock;
  }

  acquire(priority: RequestPriority = "background"): Promise<void> {
    const acquisition = this.queue.then(async () => {
      for (;;) {
        const now = this.clock.now();
        let startAt = Math.max(now, this.blockedUntil);
        if (this.lastStart !== null) startAt = Math.max(startAt, this.lastStart + this.spacing);
        if (priority === "background" && this.atReserve(now)) {
          startAt = Math.max(startAt, this.quota!.resetAt);
        }
        if (startAt <= now) break;
        await this.clock.sleep(startAt - now);
      }
      this.lastStart = this.clock.now();
    });
    this.queue = acquisition.catch(() => undefined);
    return acquisition;
  }

  observe(observation: RateLimitObservation): void {
    if (
      Number.isFinite(observation.remaining) &&
      Number.isFinite(observation.limit) &&
      observation.limit > 0 &&
      Number.isFinite(observation.resetAt)
    ) {
      this.quota = observation;
    }
  }

  pauseUntil(timestamp: number): void {
    if (Number.isFinite(timestamp)) this.blockedUntil = Math.max(this.blockedUntil, timestamp);
  }

  pauseFor(milliseconds: number): void {
    if (Number.isFinite(milliseconds) && milliseconds >= 0) {
      this.pauseUntil(this.clock.now() + milliseconds);
    }
  }

  private atReserve(now: number): boolean {
    if (!this.quota || this.quota.resetAt <= now) return false;
    return this.quota.remaining * 100 <= this.quota.limit * this.reservePercent;
  }
}
