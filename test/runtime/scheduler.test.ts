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
  await Promise.resolve();
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
  await Promise.resolve();
  scheduler.close();
  gate.resolve();
  await Promise.all([active, rejected, scheduler.drain()]);

  assert.deepEqual(started, ["active"]);
});

test("closing before the deferred start prevents the claimed item from running", async () => {
  let calls = 0;
  const scheduler = createScheduler<string>({
    concurrency: 1,
    key: (value) => value,
    run: async () => { calls += 1; },
  });

  const claimed = scheduler.schedule("claimed");
  scheduler.close();

  await assert.rejects(claimed, /closed before work started/);
  await scheduler.drain();
  assert.equal(calls, 0);
});

test("coalesces an active key into one trailing generation without overlap", async () => {
  const firstGate = deferred();
  const secondGate = deferred();
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const scheduler = createScheduler<string>({
    concurrency: 2,
    key: (value) => value,
    run: async () => {
      calls += 1;
      maximum = Math.max(maximum, ++active);
      await (calls === 1 ? firstGate.promise : secondGate.promise);
      active -= 1;
    },
  });

  const first = scheduler.schedule("ticket");
  await Promise.resolve();
  const trailing = scheduler.schedule("ticket");
  const duplicateTrailing = scheduler.schedule("ticket");
  firstGate.resolve();
  await first;
  await Promise.resolve();

  assert.equal(calls, 2);
  assert.equal(maximum, 1);
  let trailingSettled = false;
  void trailing.then(() => { trailingSettled = true; });
  await Promise.resolve();
  assert.equal(trailingSettled, false);
  secondGate.resolve();
  await Promise.all([trailing, duplicateTrailing, scheduler.drain()]);
  assert.equal(calls, 2);
});

test("preserves an undefined worker rejection", async () => {
  const scheduler = createScheduler<string>({
    concurrency: 1,
    key: (value) => value,
    run: async () => Promise.reject(undefined),
  });

  await assert.rejects(scheduler.schedule("ticket"), () => true);
});

test("applies reduced concurrency only to work not yet claimed", async () => {
  const gates = [deferred(), deferred(), deferred()];
  const started: number[] = [];
  const scheduler = createScheduler<number>({
    concurrency: 2,
    key: String,
    run: async (value) => { started.push(value); await gates[value]!.promise; },
  });
  const work = [0, 1, 2].map((value) => scheduler.schedule(value));
  await Promise.resolve();
  scheduler.setConcurrency(1);
  assert.deepEqual(started, [0, 1]);
  gates[0]!.resolve();
  await Promise.resolve();
  assert.deepEqual(started, [0, 1]);
  gates[1]!.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2]);
  gates[2]!.resolve();
  await Promise.all(work);
});

test("reports active and queued work counts", async () => {
  const gate = deferred();
  const scheduler = createScheduler<string>({
    concurrency: 1,
    key: (value) => value,
    run: async () => gate.promise,
  });

  const active = scheduler.schedule("active");
  const queued = scheduler.schedule("queued");
  await Promise.resolve();

  assert.deepEqual(scheduler.snapshot(), { active: 1, queued: 1, concurrency: 1 });

  gate.resolve();
  await Promise.all([active, queued]);
  assert.deepEqual(scheduler.snapshot(), { active: 0, queued: 0, concurrency: 1 });
});
