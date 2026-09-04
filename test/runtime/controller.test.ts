import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderAdapter, TicketRef } from "../../src/provider/types.ts";
import { createController } from "../../src/runtime/controller.ts";
import type { AttemptLauncher, ReconcileOutcome } from "../../src/runtime/reconcile.ts";

type DiscoveryAdapter = Pick<ProviderAdapter, "kind" | "bootstrap" | "discover">;

const GITHUB_ONE = { provider: "github", repository: "owner/one", number: 1 } as const;
const GITHUB_TWO = { provider: "github", repository: "owner/two", number: 2 } as const;
const GITLAB_ONE = { provider: "gitlab", repository: "group/one", number: 1 } as const;

function key(ref: TicketRef): string {
  return `${ref.provider}:${ref.repository}#${ref.number}`;
}

function outcome(ref: TicketRef): ReconcileOutcome {
  return {
    flowInstanceId: key(ref),
    stateId: "assessment",
    configRevision: "a".repeat(40),
    stateKind: "agent",
    repositoryUrl: `https://github.example.test/${ref.repository}`,
    ticketUrl: `https://github.example.test/${ref.repository}/issues/${ref.number}`,
    actionUrl: `https://github.example.test/${ref.repository}/issues/${ref.number}`,
    changed: false,
    started: false,
  };
}

function launcher(): AttemptLauncher & { cancelled: string[] } {
  const cancelled: string[] = [];
  return {
    cancelled,
    async start() {},
    async cancel(id) { cancelled.push(id); },
    isRunning: () => true,
  };
}

function idleGitHub(): DiscoveryAdapter {
  return {
    kind: "github",
    async bootstrap() { return []; },
    async discover() { return { tickets: [], nextCursor: null }; },
  };
}

test("bootstraps the unique union returned by every allowlisted repository", async () => {
  const reconciled: string[] = [];
  const prepared: string[][] = [];
  const github: DiscoveryAdapter = {
    kind: "github",
    async bootstrap(repository) {
      assert.equal(repository, "owner/one");
      return [GITHUB_ONE, GITHUB_ONE];
    },
    async discover() { throw new Error("normal discovery is not bootstrap"); },
  };
  const gitlab: DiscoveryAdapter = {
    kind: "gitlab",
    async bootstrap(repository) {
      assert.equal(repository, "group/one");
      return [GITLAB_ONE];
    },
    async discover() { throw new Error("normal discovery is not bootstrap"); },
  };
  const controller = createController({
    providers: [
      { adapter: github, repositories: ["owner/one"] },
      { adapter: gitlab, repositories: ["group/one"] },
    ],
    concurrency: 2,
    prepareBootstrap: async (refs) => { prepared.push(refs.map(key)); },
    reconcile: async (ref) => { reconciled.push(key(ref)); return outcome(ref); },
    launcher: launcher(),
    now: () => "2026-08-25T10:00:00.000Z",
  });

  await controller.bootstrap();

  assert.deepEqual(reconciled, [key(GITHUB_ONE), key(GITLAB_ONE)]);
  assert.deepEqual(prepared, [[key(GITHUB_ONE), key(GITLAB_ONE)]]);
});

test("polls serialized repository scans with an in-memory cursor and one-second overlap", async () => {
  const firstScan = Promise.withResolvers<void>();
  const calls: Array<{ repository: string; updatedAfter: string; overlapSeconds: number; cursor?: string }> = [];
  let activeScans = 0;
  let maximumScans = 0;
  const adapter: DiscoveryAdapter = {
    kind: "github",
    async bootstrap() { return []; },
    async discover(repository, window, cursor) {
      calls.push({ repository, ...window, ...(cursor === undefined ? {} : { cursor }) });
      maximumScans = Math.max(maximumScans, ++activeScans);
      if (repository === "owner/one" && cursor === undefined) await firstScan.promise;
      activeScans -= 1;
      return cursor === undefined
        ? { tickets: repository === "owner/one" ? [GITHUB_ONE] : [GITHUB_TWO], nextCursor: `${repository}:page-2` }
        : { tickets: [], nextCursor: null };
    },
  };
  const reconciled: string[] = [];
  const abort = new AbortController();
  let intervals = 0;
  const controller = createController({
    providers: [{ adapter, repositories: ["owner/one", "owner/two"] }],
    concurrency: 4,
    reconcile: async (ref) => { reconciled.push(key(ref)); return outcome(ref); },
    launcher: launcher(),
    now: (() => {
      const values = [
        "2026-08-25T10:00:00.000Z",
        "2026-08-25T10:05:00.000Z",
        "2026-08-25T10:10:00.000Z",
      ];
      return () => values.shift() ?? "2026-08-25T10:15:00.000Z";
    })(),
    delay: async (milliseconds) => {
      assert.equal(milliseconds, 300_000);
      intervals += 1;
      if (intervals === 2) {
        setImmediate(firstScan.resolve);
      }
      if (intervals === 3) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        abort.abort();
      }
    },
  });

  await controller.bootstrap();
  await controller.run(abort.signal);

  assert.equal(maximumScans, 1);
  const firstSweep = [
    { repository: "owner/one", updatedAfter: "2026-08-25T10:00:00.000Z", overlapSeconds: 1 },
    {
      repository: "owner/one",
      updatedAfter: "2026-08-25T10:00:00.000Z",
      overlapSeconds: 1,
      cursor: "owner/one:page-2",
    },
    { repository: "owner/two", updatedAfter: "2026-08-25T10:00:00.000Z", overlapSeconds: 1 },
    {
      repository: "owner/two",
      updatedAfter: "2026-08-25T10:00:00.000Z",
      overlapSeconds: 1,
      cursor: "owner/two:page-2",
    },
  ];
  const secondSweep = firstSweep.map((call) => ({
    ...call,
    updatedAfter: "2026-08-25T10:05:00.000Z",
  }));
  assert.deepEqual(calls, [...firstSweep, ...secondSweep]);
  assert.deepEqual(reconciled.toSorted(), [
    key(GITHUB_ONE), key(GITHUB_ONE), key(GITHUB_TWO), key(GITHUB_TWO),
  ].toSorted());
});

test("reloads runtime after sleeping before starting a polling sweep", async () => {
  const abort = new AbortController();
  let delays = 0;
  let discoveries = 0;
  const adapter: DiscoveryAdapter = {
    kind: "github",
    async bootstrap() { return []; },
    async discover() { discoveries += 1; return { tickets: [], nextCursor: null }; },
  };
  const controller = createController({
    providers: [{ adapter, repositories: ["owner/one"] }],
    concurrency: 1,
    reconcile: async (ref) => outcome(ref),
    launcher: launcher(),
    runtimeState: async () => ({ mayStartWork: false, pollingIntervalSeconds: 300, concurrency: 1 }),
    delay: async () => { if (++delays === 2) abort.abort(); },
  });
  await controller.bootstrap();
  await controller.run(abort.signal);
  assert.equal(discoveries, 0);
});

test("reconciles active tickets when their provider discovery timestamp does not change", async () => {
  const adapter: DiscoveryAdapter = {
    kind: "gitlab",
    async bootstrap() { return [GITLAB_ONE]; },
    async discover() { return { tickets: [], nextCursor: null }; },
  };
  const abort = new AbortController();
  let reconcileCalls = 0;
  let intervals = 0;
  const controller = createController({
    providers: [{ adapter, repositories: ["group/one"] }],
    concurrency: 1,
    reconcile: async (ref) => {
      reconcileCalls += 1;
      return {
        ...outcome(ref),
        stateId: reconcileCalls === 1 ? "awaiting-merge" : "done",
      };
    },
    launcher: launcher(),
    delay: async () => {
      intervals += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (intervals === 3) abort.abort();
    },
  });

  await controller.bootstrap();
  await controller.run(abort.signal);

  assert.equal(reconcileCalls, 2);
});

test("excludes duplicate reconcileNow work and cancels tracked attempts on shutdown", async () => {
  const gate = Promise.withResolvers<void>();
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const attempts = launcher();
  const controller = createController({
    providers: [{ adapter: idleGitHub(), repositories: ["owner/one"] }],
    concurrency: 1,
    reconcile: async (ref) => {
      calls += 1;
      maximum = Math.max(maximum, ++active);
      await gate.promise;
      active -= 1;
      return outcome(ref);
    },
    launcher: attempts,
  });

  await controller.bootstrap();

  const first = controller.reconcileNow(GITHUB_ONE);
  const duplicate = controller.reconcileNow(GITHUB_ONE);
  await Promise.resolve();
  const abort = new AbortController();
  abort.abort();
  const stopping = controller.run(abort.signal);
  gate.resolve();
  await Promise.all([first, duplicate, stopping]);

  assert.equal(calls, 1);
  assert.equal(maximum, 1);
  assert.deepEqual(attempts.cancelled, [key(GITHUB_ONE)]);
});

test("retries a failed repository sweep from the previous in-memory cursor", async () => {
  const windows: string[] = [];
  let calls = 0;
  const adapter: DiscoveryAdapter = {
    kind: "github",
    async bootstrap() { return []; },
    async discover(_repository, window) {
      windows.push(window.updatedAfter);
      calls += 1;
      if (calls === 1) throw new Error("temporary discovery failure");
      return { tickets: [], nextCursor: null };
    },
  };
  const abort = new AbortController();
  let intervals = 0;
  const errors: unknown[] = [];
  const controller = createController({
    providers: [{ adapter, repositories: ["owner/one"] }],
    concurrency: 1,
    reconcile: async (ref) => outcome(ref),
    launcher: launcher(),
    now: (() => {
      const values = ["2026-08-25T10:00:00.000Z", "2026-08-25T10:05:00.000Z", "2026-08-25T10:10:00.000Z"];
      return () => values.shift() ?? "2026-08-25T10:15:00.000Z";
    })(),
    delay: async () => {
      intervals += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (intervals === 3) abort.abort();
    },
    onError: (error) => errors.push(error),
  });

  await controller.bootstrap();
  await controller.run(abort.signal);

  assert.deepEqual(windows, ["2026-08-25T10:00:00.000Z", "2026-08-25T10:00:00.000Z"]);
  assert.equal(errors.length, 1);
});

test("rejects ticket refs outside the adapter repository identity", async () => {
  const adapter: DiscoveryAdapter = {
    kind: "github",
    async bootstrap() { return [{ ...GITHUB_ONE, repository: "owner/not-allowed" }]; },
    async discover() { return { tickets: [], nextCursor: null }; },
  };
  const controller = createController({
    providers: [{ adapter, repositories: ["owner/one"] }],
    concurrency: 1,
    reconcile: async (ref) => outcome(ref),
    launcher: launcher(),
  });

  await assert.rejects(controller.bootstrap(), /ticket identity/);
});

test("shutdown drops queued tickets and cancels the active attempt owner", async () => {
  const gate = Promise.withResolvers<void>();
  const reconciled: string[] = [];
  const attempts = launcher();
  const controller = createController({
    providers: [{ adapter: idleGitHub(), repositories: ["owner/one", "owner/two"] }],
    concurrency: 1,
    reconcile: async (ref) => {
      reconciled.push(key(ref));
      await gate.promise;
      return outcome(ref);
    },
    launcher: attempts,
  });
  await controller.bootstrap();
  const active = controller.reconcileNow(GITHUB_ONE);
  const queued = controller.reconcileNow(GITHUB_TWO);
  const queuedRejected = assert.rejects(queued, /closed before work started/);
  await Promise.resolve();
  const abort = new AbortController();
  abort.abort();
  const stopping = controller.run(abort.signal);
  gate.resolve();

  await Promise.all([active, queuedRejected, stopping]);
  assert.deepEqual(reconciled, [key(GITHUB_ONE)]);
  assert.deepEqual(attempts.cancelled, [key(GITHUB_ONE)]);
});

test("shutdown drops queued repository scans", async () => {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const scanned: string[] = [];
  const adapter: DiscoveryAdapter = {
    kind: "github",
    async bootstrap() { return []; },
    async discover(repository) {
      scanned.push(repository);
      if (repository === "owner/one") {
        entered.resolve();
        await gate.promise;
      }
      return { tickets: [], nextCursor: null };
    },
  };
  const abort = new AbortController();
  let intervals = 0;
  const controller = createController({
    providers: [{ adapter, repositories: ["owner/one", "owner/two"] }],
    concurrency: 1,
    reconcile: async (ref) => outcome(ref),
    launcher: launcher(),
    delay: async () => {
      intervals += 1;
      if (intervals === 2) {
        await entered.promise;
        setImmediate(gate.resolve);
        abort.abort();
      }
    },
  });

  await controller.bootstrap();
  await controller.run(abort.signal);

  assert.deepEqual(scanned, ["owner/one"]);
});

test("retries a discovered ticket failure before advancing its repository cursor", async () => {
  const windows: string[] = [];
  let reconcileCalls = 0;
  const adapter: DiscoveryAdapter = {
    kind: "github",
    async bootstrap() { return []; },
    async discover(_repository, window) {
      windows.push(window.updatedAfter);
      return { tickets: [GITHUB_ONE], nextCursor: null };
    },
  };
  const abort = new AbortController();
  let intervals = 0;
  const controller = createController({
    providers: [{ adapter, repositories: ["owner/one"] }],
    concurrency: 1,
    reconcile: async (ref) => {
      reconcileCalls += 1;
      if (reconcileCalls === 1) throw new Error("temporary reconcile failure");
      return outcome(ref);
    },
    launcher: launcher(),
    now: (() => {
      const values = ["2026-08-25T10:00:00.000Z", "2026-08-25T10:05:00.000Z", "2026-08-25T10:10:00.000Z"];
      return () => values.shift() ?? "2026-08-25T10:15:00.000Z";
    })(),
    delay: async () => {
      intervals += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (intervals === 3) abort.abort();
    },
  });

  await controller.bootstrap();
  await controller.run(abort.signal);

  assert.equal(reconcileCalls, 2);
  assert.deepEqual(windows, ["2026-08-25T10:00:00.000Z", "2026-08-25T10:00:00.000Z"]);
});

test("advances successful repository cursors independently from failed repositories", async () => {
  const windows = new Map<string, string[]>();
  let failingCalls = 0;
  const adapter: DiscoveryAdapter = {
    kind: "github",
    async bootstrap() { return []; },
    async discover(repository, window) {
      const seen = windows.get(repository) ?? [];
      seen.push(window.updatedAfter);
      windows.set(repository, seen);
      if (repository === "owner/two" && failingCalls++ === 0) throw new Error("temporary failure");
      return { tickets: [], nextCursor: null };
    },
  };
  const abort = new AbortController();
  let intervals = 0;
  const controller = createController({
    providers: [{ adapter, repositories: ["owner/one", "owner/two"] }],
    concurrency: 1,
    reconcile: async (ref) => outcome(ref),
    launcher: launcher(),
    now: (() => {
      const values = ["2026-08-25T10:00:00.000Z", "2026-08-25T10:05:00.000Z", "2026-08-25T10:10:00.000Z"];
      return () => values.shift() ?? "2026-08-25T10:15:00.000Z";
    })(),
    delay: async () => {
      intervals += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (intervals === 3) abort.abort();
    },
  });

  await controller.bootstrap();
  await controller.run(abort.signal);

  assert.deepEqual(windows.get("owner/one"), ["2026-08-25T10:00:00.000Z", "2026-08-25T10:05:00.000Z"]);
  assert.deepEqual(windows.get("owner/two"), ["2026-08-25T10:00:00.000Z", "2026-08-25T10:00:00.000Z"]);
});

test("reconcileNow rejects refs outside configured repositories", async () => {
  const adapter: DiscoveryAdapter = {
    kind: "github",
    async bootstrap() { return []; },
    async discover() { return { tickets: [], nextCursor: null }; },
  };
  const controller = createController({
    providers: [{ adapter, repositories: ["owner/one"] }],
    concurrency: 1,
    reconcile: async (ref) => outcome(ref),
    launcher: launcher(),
  });
  await controller.bootstrap();

  await assert.rejects(controller.reconcileNow({ ...GITHUB_ONE, repository: "owner/two" }), /allowlisted/);
  await assert.rejects(controller.reconcileNow({ ...GITHUB_ONE, provider: "gitlab" }), /allowlisted/);
  await assert.rejects(controller.reconcileNow({ ...GITHUB_ONE, number: 0 }), /ticket identity/);
});

test("requires one successful bootstrap and one run lifecycle", async () => {
  const adapter: DiscoveryAdapter = {
    kind: "github",
    async bootstrap() { return []; },
    async discover() { return { tickets: [], nextCursor: null }; },
  };
  const fresh = () => createController({
    providers: [{ adapter, repositories: ["owner/one"] }],
    concurrency: 1,
    reconcile: async (ref: TicketRef) => outcome(ref),
    launcher: launcher(),
  });

  await assert.rejects(fresh().run(AbortSignal.abort()), /successful bootstrap/);
  const controller = fresh();
  await controller.bootstrap();
  await assert.rejects(controller.bootstrap(), /only run once/);
  await controller.run(AbortSignal.abort());
  await assert.rejects(controller.run(AbortSignal.abort()), /only run once/);
});

test("shutdown completes both cancellation passes and aggregates failures", async () => {
  const cancelled: string[] = [];
  const attempts: AttemptLauncher = {
    async start() {},
    isRunning: () => true,
    async cancel(id) {
      cancelled.push(id);
      throw new Error(`cancel failed: ${id}`);
    },
  };
  const controller = createController({
    providers: [{ adapter: idleGitHub(), repositories: ["owner/one"] }],
    concurrency: 1,
    reconcile: async (ref) => outcome(ref),
    launcher: attempts,
  });
  await controller.bootstrap();
  await controller.reconcileNow(GITHUB_ONE);

  await assert.rejects(controller.run(AbortSignal.abort()), AggregateError);
  assert.deepEqual(cancelled, [key(GITHUB_ONE), key(GITHUB_ONE)]);
  await assert.rejects(controller.reconcileNow(GITHUB_ONE), /stopped/);
});

test("contains errors thrown by the polling error reporter", async () => {
  const adapter: DiscoveryAdapter = {
    kind: "github",
    async bootstrap() { return []; },
    async discover() { throw new Error("discovery failed"); },
  };
  const abort = new AbortController();
  let intervals = 0;
  const controller = createController({
    providers: [{ adapter, repositories: ["owner/one"] }],
    concurrency: 1,
    reconcile: async (ref) => outcome(ref),
    launcher: launcher(),
    delay: async () => {
      intervals += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (intervals === 2) abort.abort();
    },
    onError: () => { throw new Error("reporter failed"); },
  });

  await controller.bootstrap();
  await controller.run(abort.signal);
});

test("a slow ticket does not block an independent repository ticket", async () => {
  const slow = Promise.withResolvers<void>();
  const independentStarted = Promise.withResolvers<void>();
  const started: string[] = [];
  const adapter: DiscoveryAdapter = {
    kind: "github",
    async bootstrap() { return []; },
    async discover(repository) {
      return {
        tickets: [repository === "owner/one" ? GITHUB_ONE : GITHUB_TWO],
        nextCursor: null,
      };
    },
  };
  const abort = new AbortController();
  let intervals = 0;
  const controller = createController({
    providers: [{ adapter, repositories: ["owner/one", "owner/two"] }],
    concurrency: 2,
    reconcile: async (ref) => {
      started.push(key(ref));
      if (ref.repository === "owner/one") await slow.promise;
      else independentStarted.resolve();
      return outcome(ref);
    },
    launcher: launcher(),
    delay: async () => {
      intervals += 1;
      if (intervals === 2) {
        await independentStarted.promise;
        abort.abort();
        slow.resolve();
      }
    },
  });

  await controller.bootstrap();
  await controller.run(abort.signal);

  assert.deepEqual(started, [key(GITHUB_ONE), key(GITHUB_TWO)]);
});

test("failed bootstrap drains late reconciles and retries attempt cancellation", async () => {
  const secondStarted = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  let running = true;
  let cancelCalls = 0;
  const attempts: AttemptLauncher = {
    async start() {},
    isRunning: () => running,
    async cancel() {
      cancelCalls += 1;
      if (cancelCalls === 1) throw new Error("temporary cancel failure");
      running = false;
    },
  };
  const adapter: DiscoveryAdapter = {
    kind: "github",
    async bootstrap() { return [GITHUB_ONE, { ...GITHUB_ONE, number: 2 }]; },
    async discover() { return { tickets: [], nextCursor: null }; },
  };
  const controller = createController({
    providers: [{ adapter, repositories: ["owner/one"] }],
    concurrency: 2,
    reconcile: async (ref) => {
      if (ref.number === 1) {
        await secondStarted.promise;
        throw new Error("bootstrap reconcile failed");
      }
      secondStarted.resolve();
      await releaseSecond.promise;
      return outcome(ref);
    },
    launcher: attempts,
  });

  const bootstrapping = controller.bootstrap();
  let settled = false;
  void bootstrapping.finally(() => { settled = true; }).catch(() => undefined);
  await secondStarted.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseSecond.resolve();

  const error = await bootstrapping.catch((caught: unknown) => caught);
  assert.ok(error instanceof AggregateError);
  assert.match(String(error.errors[0]), /bootstrap reconcile failed/);
  assert.match(String(error.errors[1]), /temporary cancel failure/);
  assert.equal(cancelCalls, 2);
  assert.equal(running, false);
  await assert.rejects(controller.reconcileNow(GITHUB_ONE), /failed/);
});

test("reconcileNow is available only while ready or running", async () => {
  const bootstrapEntered = Promise.withResolvers<void>();
  const releaseBootstrap = Promise.withResolvers<void>();
  const runEntered = Promise.withResolvers<void>();
  const adapter: DiscoveryAdapter = {
    kind: "github",
    async bootstrap() {
      bootstrapEntered.resolve();
      await releaseBootstrap.promise;
      return [];
    },
    async discover() { return { tickets: [], nextCursor: null }; },
  };
  const abort = new AbortController();
  const controller = createController({
    providers: [{ adapter, repositories: ["owner/one"] }],
    concurrency: 1,
    reconcile: async (ref) => outcome(ref),
    launcher: launcher(),
    delay: async (_milliseconds, signal) => {
      runEntered.resolve();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });

  await assert.rejects(controller.reconcileNow(GITHUB_ONE), /ready or running/);
  const bootstrapping = controller.bootstrap();
  await bootstrapEntered.promise;
  await assert.rejects(controller.reconcileNow(GITHUB_ONE), /ready or running/);
  releaseBootstrap.resolve();
  await bootstrapping;
  await controller.reconcileNow(GITHUB_ONE);

  const running = controller.run(abort.signal);
  await runEntered.promise;
  await controller.reconcileNow(GITHUB_ONE);
  abort.abort();
  await running;
  await assert.rejects(controller.reconcileNow(GITHUB_ONE), /ready or running/);
});

test("reports controller work from its ephemeral collections", async () => {
  const gate = Promise.withResolvers<void>();
  const controller = createController({
    providers: [{ adapter: idleGitHub(), repositories: ["owner/one"] }],
    concurrency: 1,
    reconcile: async (ref) => {
      await gate.promise;
      return {
        ...outcome(ref),
        stateId: "awaiting-merge",
        stateKind: "provider-wait",
        actionUrl: `https://github.example.test/${ref.repository}/pull/2`,
      };
    },
    launcher: launcher(),
    now: () => "2026-08-29T10:00:00.000Z",
  });

  assert.deepEqual(controller.snapshot(), {
    lifecycle: "created",
    repositories: [{ provider: "github", repository: "owner/one", nextWindowStartedAt: null }],
    tickets: [],
    queue: { active: 0, queued: 0, concurrency: 1 },
    locks: [],
    activeWork: [],
    errors: [],
  });

  await controller.bootstrap();
  const scheduled = controller.reconcileNow(GITHUB_ONE);
  await Promise.resolve();

  assert.deepEqual(controller.snapshot(), {
    lifecycle: "ready",
    repositories: [{ provider: "github", repository: "owner/one", nextWindowStartedAt: "2026-08-29T10:00:00.000Z" }],
    tickets: [{
      ...GITHUB_ONE,
      flowInstanceId: null,
      stateId: null,
      configRevision: null,
      stateKind: null,
      repositoryUrl: null,
      ticketUrl: null,
      actionUrl: null,
      observedAt: null,
    }],
    queue: { active: 1, queued: 0, concurrency: 1 },
    locks: [GITHUB_ONE],
    activeWork: [],
    errors: [],
  });

  gate.resolve();
  await scheduled;

  assert.deepEqual(controller.snapshot(), {
    lifecycle: "ready",
    repositories: [{ provider: "github", repository: "owner/one", nextWindowStartedAt: "2026-08-29T10:00:00.000Z" }],
    tickets: [{
      ...GITHUB_ONE,
      flowInstanceId: key(GITHUB_ONE),
      stateId: "awaiting-merge",
      configRevision: "a".repeat(40),
      stateKind: "provider-wait",
      repositoryUrl: "https://github.example.test/owner/one",
      ticketUrl: "https://github.example.test/owner/one/issues/1",
      actionUrl: "https://github.example.test/owner/one/pull/2",
      observedAt: "2026-08-29T10:00:00.000Z",
    }],
    queue: { active: 0, queued: 0, concurrency: 1 },
    locks: [],
    activeWork: [GITHUB_ONE],
    errors: [],
  });
});

test("keeps the accepted observation when same-ticket work coalesces before start", async () => {
  let calls = 0;
  const controller = createController({
    providers: [{ adapter: idleGitHub(), repositories: ["owner/one"] }],
    concurrency: 1,
    reconcile: async (ref) => { calls += 1; return outcome(ref); },
    launcher: launcher(),
    now: () => "2026-08-29T11:00:00.000Z",
  });
  await controller.bootstrap();

  const first = controller.reconcileNow(GITHUB_ONE);
  const coalesced = controller.reconcileNow(GITHUB_ONE);
  assert.deepEqual(controller.snapshot().locks, [GITHUB_ONE]);
  await Promise.all([first, coalesced]);

  assert.equal(calls, 1);
  assert.deepEqual(controller.snapshot().locks, []);
  assert.deepEqual(controller.snapshot().tickets, [{
    ...GITHUB_ONE,
    flowInstanceId: key(GITHUB_ONE),
    stateId: "assessment",
    configRevision: "a".repeat(40),
    stateKind: "agent",
    repositoryUrl: "https://github.example.test/owner/one",
    ticketUrl: "https://github.example.test/owner/one/issues/1",
    actionUrl: "https://github.example.test/owner/one/issues/1",
    observedAt: "2026-08-29T11:00:00.000Z",
  }]);
});

test("keeps the last completed observation visible while the ticket refreshes", async () => {
  const refresh = Promise.withResolvers<void>();
  let calls = 0;
  const controller = createController({
    providers: [{ adapter: idleGitHub(), repositories: ["owner/one"] }],
    concurrency: 1,
    reconcile: async (ref) => {
      if (++calls === 2) await refresh.promise;
      return outcome(ref);
    },
    launcher: launcher(),
    now: () => "2026-08-29T11:00:00.000Z",
  });
  await controller.bootstrap();
  await controller.reconcileNow(GITHUB_ONE);

  const refreshing = controller.reconcileNow(GITHUB_ONE);
  await Promise.resolve();
  assert.equal(controller.snapshot().tickets[0]?.stateId, "assessment");
  assert.equal(controller.snapshot().tickets[0]?.observedAt, "2026-08-29T11:00:00.000Z");

  refresh.resolve();
  await refreshing;
});

test("keeps only bounded generic polling errors in its snapshot", async () => {
  const abort = new AbortController();
  let delays = 0;
  const controller = createController({
    providers: [{
      adapter: {
        kind: "github",
        async bootstrap() { return []; },
        async discover() { throw new Error("provider response body: credential=secret"); },
      },
      repositories: ["owner/one"],
    }],
    concurrency: 1,
    reconcile: async (ref) => outcome(ref),
    launcher: launcher(),
    delay: async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (++delays === 12) abort.abort();
    },
  });

  await controller.bootstrap();
  await controller.run(abort.signal);

  assert.deepEqual(controller.snapshot().errors, Array(10).fill("controller error"));
});

test("keeps a newer coalesced ticket observation after an earlier reconcile fails", async () => {
  const firstStarted = Promise.withResolvers<void>();
  const failFirst = Promise.withResolvers<void>();
  const finishLater = Promise.withResolvers<void>();
  let calls = 0;
  const controller = createController({
    providers: [{ adapter: idleGitHub(), repositories: ["owner/one"] }],
    concurrency: 1,
    reconcile: async (ref) => {
      if (++calls === 1) {
        firstStarted.resolve();
        await failFirst.promise;
        throw new Error("first reconcile failed");
      }
      await finishLater.promise;
      return outcome(ref);
    },
    launcher: launcher(),
  });

  await controller.bootstrap();
  const first = controller.reconcileNow(GITHUB_ONE);
  await firstStarted.promise;
  const later = controller.reconcileNow(GITHUB_ONE);
  assert.deepEqual(controller.snapshot().locks, [GITHUB_ONE]);
  failFirst.resolve();

  await assert.rejects(first, /first reconcile failed/);
  assert.deepEqual(controller.snapshot().locks, [GITHUB_ONE]);
  assert.deepEqual(controller.snapshot().tickets.map(({ provider, repository, number }) => ({
    provider, repository, number,
  })), [GITHUB_ONE]);

  finishLater.resolve();
  await later;
  assert.deepEqual(controller.snapshot().locks, []);
});

test("removes an observation rejected after the ticket scheduler closes", async () => {
  const cancellationStarted = Promise.withResolvers<void>();
  const releaseCancellation = Promise.withResolvers<void>();
  let cancellations = 0;
  const controller = createController({
    providers: [{ adapter: idleGitHub(), repositories: ["owner/one", "owner/two"] }],
    concurrency: 1,
    reconcile: async (ref) => outcome(ref),
    launcher: {
      async start() {},
      async cancel() {
        if (++cancellations === 1) {
          cancellationStarted.resolve();
          await releaseCancellation.promise;
        }
      },
      isRunning: () => true,
    },
  });
  const abort = new AbortController();

  await controller.bootstrap();
  await controller.reconcileNow(GITHUB_ONE);
  abort.abort();
  const stopping = controller.run(abort.signal);
  await cancellationStarted.promise;

  await assert.rejects(controller.reconcileNow(GITHUB_TWO), /scheduler is closed/);
  assert.deepEqual(controller.snapshot().tickets.map(({ provider, repository, number }) => ({
    provider, repository, number,
  })), [GITHUB_ONE]);

  releaseCancellation.resolve();
  await stopping;
});

test("reports running and stopped snapshots around a polling repository scan", async () => {
  const abort = new AbortController();
  const discovered: Array<{ updatedAfter: string; overlapSeconds: number }> = [];
  let delays = 0;
  const controller = createController({
    providers: [{
      adapter: {
        kind: "github",
        async bootstrap() { return []; },
        async discover(_repository, window) {
          discovered.push(window);
          return { tickets: [], nextCursor: null };
        },
      },
      repositories: ["owner/one"],
    }],
    concurrency: 1,
    reconcile: async (ref) => outcome(ref),
    launcher: launcher(),
    now: (() => {
      const values = ["2026-08-29T10:00:00.000Z", "2026-08-29T10:05:00.000Z"];
      return () => values.shift() ?? "2026-08-29T10:10:00.000Z";
    })(),
    delay: async () => {
      if (++delays === 1) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
      abort.abort();
    },
  });

  await controller.bootstrap();
  const running = controller.run(abort.signal);

  assert.equal(controller.snapshot().lifecycle, "running");
  await running;

  assert.deepEqual(controller.snapshot(), {
    lifecycle: "stopped",
    repositories: [{ provider: "github", repository: "owner/one", nextWindowStartedAt: "2026-08-29T10:05:00.000Z" }],
    tickets: [],
    queue: { active: 0, queued: 0, concurrency: 1 },
    locks: [],
    activeWork: [],
    errors: [],
  });
  assert.deepEqual(discovered, [{ updatedAfter: "2026-08-29T10:00:00.000Z", overlapSeconds: 1 }]);
});
