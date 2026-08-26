import assert from "node:assert/strict";
import test from "node:test";

import { createScheduler } from "../../src/runtime/scheduler.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("bounds workers while allowing an independent slow key to make progress", async () => {
  const gates = new Map([["slow", deferred()], ["other", deferred()]]);
  let active = 0;
  let maximum = 0;
  const started: string[] = [];
  const scheduler = createScheduler<string>({
    concurrency: 2,
    key: (value) => value,
    run: async (value) => {
      started.push(value);
      maximum = Math.max(maximum, ++active);
      await gates.get(value)?.promise;
      active -= 1;
    },
  });

  const slow = scheduler.schedule("slow");
  const duplicate = scheduler.schedule("slow");
  const other = scheduler.schedule("other");
  await Promise.resolve();

  assert.deepEqual(started, ["slow", "other"]);
  assert.equal(maximum, 2);
  gates.get("slow")!.resolve();
  gates.get("other")!.resolve();
  await Promise.all([slow, duplicate, other, scheduler.drain()]);
  assert.equal(started.filter((key) => key === "slow").length, 1);
});

test("rejects new work after closing and drains active work", async () => {
  const gate = deferred();
  const scheduler = createScheduler<string>({
    concurrency: 1,
    key: (value) => value,
    run: async () => gate.promise,
  });

  const active = scheduler.schedule("active");
  scheduler.close();
  await assert.rejects(scheduler.schedule("late"), /closed/);
  gate.resolve();
  await Promise.all([active, scheduler.drain()]);
});

test("accepts the same key again after its prior work completes", async () => {
  let calls = 0;
  const scheduler = createScheduler<string>({
    concurrency: 1,
    key: (value) => value,
    run: async () => { calls += 1; },
  });

  await scheduler.schedule("ticket");
  await scheduler.schedule("ticket");

  assert.equal(calls, 2);
});

test("closing drops queued work without interrupting the active item", async () => {
  const gate = deferred();
  const started: string[] = [];
  const scheduler = createScheduler<string>({
    concurrency: 1,
    key: (value) => value,
    run: async (value) => {
      started.push(value);
      if (value === "active") await gate.promise;
    },
  });

  const active = scheduler.schedule("active");
  const queued = scheduler.schedule("queued");
  const rejected = assert.rejects(queued, /closed before work started/);
  scheduler.close();
  gate.resolve();
  await Promise.all([active, rejected, scheduler.drain()]);

  assert.deepEqual(started, ["active"]);
});
