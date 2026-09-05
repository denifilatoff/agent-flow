import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ConfigBundle } from "../src/config/load.ts";
import type { Readiness } from "../src/health.ts";
import { createProductionDependencies, main } from "../src/main.ts";
import type { ProviderAdapter, RecoveryEvidence } from "../src/provider/types.ts";
import type { Controller } from "../src/runtime/controller.ts";
import { openLocalStore, providerScope } from "../src/runtime/local-store.ts";

test("a signal during bootstrap drains launched work without becoming ready", async () => {
  const bootstrap = Promise.withResolvers<void>();
  const signals = new EventEmitter();
  let launched = false;
  let cancelled = false;
  let closed = false;
  let storeClosed = false;
  let readiness!: Readiness;
  const controller: Controller = {
    async bootstrap() {
      launched = true;
      await bootstrap.promise;
    },
    async run(signal) {
      assert.equal(signal.aborted, true);
      if (launched) cancelled = true;
    },
    async reconcileNow() {},
  };
  const server = {
    listening: true,
    close(callback: (error?: Error) => void) { closed = true; callback(); return this; },
  } as unknown as Server;
  const dependencies = {
    createHealthServer(_port, state) { readiness = state; return server; },
    createPreflightDependencies() { return {} as never; },
    async runPreflight() {
      await controller.bootstrap();
      return {
        controller,
        store: {
          close() {
            assert.equal(cancelled, true);
            storeClosed = true;
          },
        },
      } as never;
    },
    signals,
    reportError() {},
  };

  const running = main({ AGENT_FLOW_HEALTH_PORT: "8080" }, dependencies);
  await Promise.resolve();
  assert.equal(launched, true);
  signals.emit("SIGTERM");
  bootstrap.resolve();

  assert.equal(await running, 0);
  assert.equal(cancelled, true);
  assert.equal(storeClosed, true);
  assert.equal(readiness.isReady(), false);
  assert.equal(closed, true);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("production startup records active legacy work as migration-required without provider writes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-legacy-startup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ref = { provider: "github" as const, repository: "owner/repo", number: 17 };
  const actor = { login: "maintainer", providerId: "7" };
  const snapshot = {
    ref,
    repository: {
      provider: "github" as const,
      name: ref.repository,
      host: "github.test",
      cloneRoot: "https://github.test/",
      cloneUrl: "https://github.test/owner/repo.git",
    },
    title: "Legacy work",
    description: "",
    open: true,
    labels: ["agent-flow:development", "agent-flow:managed", "agent-stage:planning"],
    updatedAt: "2026-09-04T10:00:00Z",
    activation: { present: true, eventId: "1", actor, occurredAt: "2026-09-04T09:00:00Z" },
    comments: [{
      id: "10",
      url: "https://github.test/owner/repo/issues/17#issuecomment-10",
      body: "<!-- agent-flow-control:v1 -->\nlegacy state",
      actor,
      createdAt: "2026-09-04T09:30:00Z",
      updatedAt: "2026-09-04T09:30:00Z",
    }],
    changeRequest: null,
  };
  const evidence: RecoveryEvidence = {
    snapshot,
    publications: [],
    changes: [],
    reviews: [],
    ambiguities: [],
    complete: true,
    activeBoundary: "known",
    legacyActive: true,
  };
  const writes: string[] = [];
  const provider = {
    kind: "github",
    async bootstrap() { return [ref]; },
    async discover() { return { tickets: [], nextCursor: null }; },
    async readRecoveryEvidence() { return evidence; },
    async readTicket() { throw new Error("legacy startup bypassed recovery classification"); },
    async createComment() { writes.push("comment"); throw new Error("unexpected provider write"); },
    async updateComment() { writes.push("comment-update"); throw new Error("unexpected provider write"); },
    async setControllerLabels() { writes.push("labels"); throw new Error("unexpected provider write"); },
  } as unknown as ProviderAdapter;
  const bundle = {
    revision: "a".repeat(40),
    root: "/pinned",
    controller: {
      apiVersion: "agent-flow/v1alpha1",
      kind: "ControllerConfig",
      configuration: { repository: "/config", flow: "flow.yaml", catalog: "agents.yaml" },
      providers: { github: { apiUrl: "https://api.github.test", tokenEnv: "GITHUB_TOKEN", repositories: [ref.repository] } },
      polling: { intervalSeconds: 300, maxCallsPerMinute: 20, quotaReservePercent: 25 },
      runtime: { concurrency: 1, dataDirectory: directory, healthPort: 8080 },
    },
    flow: {
      apiVersion: "agent-flow/v1alpha1",
      kind: "Flow",
      metadata: { id: "development", activationLabel: "agent-flow:development", managedLabel: "agent-flow:managed" },
      spec: { initial: "assessment", states: {} },
    },
    catalog: { apiVersion: "agent-flow/v1alpha1", kind: "AgentCatalog", agents: {} },
  } satisfies ConfigBundle;
  const controllerId = "11111111-1111-4111-8111-111111111111";
  const scope = providerScope("github", "https://api.github.test");
  const store = openLocalStore(join(directory, "execution.sqlite"));
  const production = createProductionDependencies({ HOME: directory, AGENT_FLOW_DATA_DIRECTORY: directory }, 8080);
  const controller = production.createController(bundle, { github: provider }, {}, {
    controllerId,
    store,
    providerScopes: { github: scope },
  });

  await controller.bootstrap();

  const stored = store.load(scope, ref);
  assert.equal(stored?.value.disposition, "ambiguous");
  assert.equal(stored?.value.reason, "active legacy state requires migration");
  assert.deepEqual(writes, []);
  await controller.run(AbortSignal.abort());
  store.close();
});
