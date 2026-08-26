import assert from "node:assert/strict";
import test from "node:test";

import { RateLimiter } from "../../src/runtime/rate-limiter.ts";

function fakeClock(start = 0) {
  let now = start;
  const delays: number[] = [];
  return {
    clock: {
      now: () => now,
      sleep: async (milliseconds: number) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
    },
    delays,
    get now() {
      return now;
    },
  };
}

test("spreads calls and pauses background work at the quota reserve", async () => {
  const fake = fakeClock();
  const limiter = new RateLimiter({ maxCallsPerMinute: 20, quotaReservePercent: 25 }, fake.clock);

  await limiter.acquire();
  await limiter.acquire("active");
  assert.equal(fake.delays.at(-1), 3_000);

  limiter.observe({ remaining: 25, limit: 100, resetAt: fake.now + 60_000 });
  await limiter.acquire("background");
  assert.equal(fake.delays.at(-1), 60_000);
});

test("lets active work bypass the background quota reserve", async () => {
  const fake = fakeClock();
  const limiter = new RateLimiter({ maxCallsPerMinute: 20, quotaReservePercent: 25 }, fake.clock);

  await limiter.acquire();
  limiter.observe({ remaining: 10, limit: 100, resetAt: 60_000 });
  await limiter.acquire("active");

  assert.deepEqual(fake.delays, [3_000]);
});

test("serves concurrent acquisitions in FIFO order", async () => {
  const fake = fakeClock();
  const limiter = new RateLimiter({ maxCallsPerMinute: 60, quotaReservePercent: 25 }, fake.clock);
  const order: number[] = [];

  await Promise.all([
    limiter.acquire().then(() => order.push(1)),
    limiter.acquire().then(() => order.push(2)),
    limiter.acquire().then(() => order.push(3)),
  ]);

  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(fake.delays, [1_000, 1_000]);
});

test("extends an already waiting acquisition when the provider pauses the account", async () => {
  let now = 0;
  const delays: number[] = [];
  let limiter: RateLimiter;
  let extend = false;
  limiter = new RateLimiter(
    { maxCallsPerMinute: 20, quotaReservePercent: 25 },
    {
      now: () => now,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
        if (extend) {
          extend = false;
          limiter.pauseFor(5_000);
        }
      },
    },
  );

  await limiter.acquire("active");
  extend = true;
  await limiter.acquire("active");

  assert.deepEqual(delays, [3_000, 5_000]);
});
