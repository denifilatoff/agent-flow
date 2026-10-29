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
  private spacing: number;
  private reservePercent: number;
  private queue: Promise<void> = Promise.resolve();
  private lastStart: number | null = null;
  private quota: RateLimitObservation | null = null;
  private blockedUntil = 0;

  constructor(options: RateLimiterOptions, clock: RateLimiterClock = systemClock) {
    validateOptions(options);
    this.spacing = 60_000 / options.maxCallsPerMinute;
    this.reservePercent = options.quotaReservePercent;
    this.clock = clock;
  }

  update(options: RateLimiterOptions): void {
    validateOptions(options);
    this.spacing = 60_000 / options.maxCallsPerMinute;
    this.reservePercent = options.quotaReservePercent;
  }

  acquire(priority: RequestPriority = "background"): Promise<void> {
    if (priority === "background" && this.atReserve(this.clock.now())) {
      return this.waitForReserve().then(() => this.enqueue());
    }
    return this.enqueue();
  }

  private enqueue(): Promise<void> {
    const acquisition = this.queue.then(async () => {
      for (;;) {
        const now = this.clock.now();
        let startAt = Math.max(now, this.blockedUntil);
        if (this.lastStart !== null) startAt = Math.max(startAt, this.lastStart + this.spacing);
        if (startAt <= now) break;
        await this.clock.sleep(startAt - now);
      }
      this.lastStart = this.clock.now();
    });
    this.queue = acquisition.catch(() => undefined);
    return acquisition;
  }

  private async waitForReserve(): Promise<void> {
    while (this.atReserve(this.clock.now())) {
      await this.clock.sleep(this.quota!.resetAt - this.clock.now());
    }
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

function validateOptions(options: RateLimiterOptions): void {
  if (!Number.isFinite(options.maxCallsPerMinute) || options.maxCallsPerMinute <= 0) {
    throw new Error("maxCallsPerMinute must be positive");
  }
  if (options.quotaReservePercent < 0 || options.quotaReservePercent > 100) {
    throw new Error("quotaReservePercent must be between 0 and 100");
  }
}
