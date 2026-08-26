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
  return { flowInstanceId: key(ref), stateId: "assessment", changed: false, started: false };
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

test("bootstraps the unique union returned by every allowlisted repository", async () => {
  const reconciled: string[] = [];
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
    reconcile: async (ref) => { reconciled.push(key(ref)); return outcome(ref); },
    launcher: launcher(),
    now: () => "2026-08-25T10:00:00.000Z",
  });

  await controller.bootstrap();

  assert.deepEqual(reconciled, [key(GITHUB_ONE), key(GITLAB_ONE)]);
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
  assert.deepEqual(calls, [
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
  ]);
  assert.deepEqual(reconciled.toSorted(), [key(GITHUB_ONE), key(GITHUB_TWO)].toSorted());
});

test("excludes duplicate reconcileNow work and cancels tracked attempts on shutdown", async () => {
  const gate = Promise.withResolvers<void>();
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const attempts = launcher();
  const controller = createController({
    providers: [],
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

  const first = controller.reconcileNow(GITHUB_ONE);
  const duplicate = controller.reconcileNow(GITHUB_ONE);
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
    providers: [],
    concurrency: 1,
    reconcile: async (ref) => {
      reconciled.push(key(ref));
      await gate.promise;
      return outcome(ref);
    },
    launcher: attempts,
  });
  const active = controller.reconcileNow(GITHUB_ONE);
  const queued = controller.reconcileNow(GITHUB_TWO);
  const queuedRejected = assert.rejects(queued, /closed before work started/);
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
  const scanned: string[] = [];
  const adapter: DiscoveryAdapter = {
    kind: "github",
    async bootstrap() { return []; },
    async discover(repository) {
      scanned.push(repository);
      if (repository === "owner/one") await gate.promise;
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
        setImmediate(gate.resolve);
        abort.abort();
      }
    },
  });

  await controller.bootstrap();
  await controller.run(abort.signal);

  assert.deepEqual(scanned, ["owner/one"]);
});
