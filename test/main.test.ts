import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import test from "node:test";

import type { RuntimeManager } from "../src/config/runtime.ts";
import type { RuntimeConfig } from "../src/config/types.ts";
import type { OperationalStatus } from "../src/health.ts";
import { main } from "../src/main.ts";
import type { Controller } from "../src/runtime/controller.ts";

test("a signal during bootstrap drains launched work without becoming ready", async () => {
  const bootstrap = Promise.withResolvers<void>();
  const signals = new EventEmitter();
  let launched = false;
  let cancelled = false;
  let closed = false;
  let readiness!: OperationalStatus;
  let bound = false;
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
    snapshot: () => ({ lifecycle: "ready", repositories: [], tickets: [],
      queue: { active: 0, queued: 0, concurrency: 1 }, activeWork: [], errors: [] }),
  };
  const server = {
    listening: true,
    close(callback: (error?: Error) => void) { closed = true; callback(); return this; },
  } as unknown as Server;
  const dependencies = {
    async createRuntime() { return {
      effective: () => ({ runtime: { http: { address: "127.0.0.1", port: 8080 } }, configuration: {
        repository: "/config", revision: "a".repeat(40),
      } } as RuntimeConfig),
      mayStartWork: () => true,
      status: () => ({ runtimeDigest: "b".repeat(64), validationErrors: [], restartRequired: false,
        restartReason: null, changedRestartFields: [], activeAttempts: 0, safeToRestart: false }),
    } as RuntimeManager; },
    createHealthServer(_address, _port, state) {
      readiness = state;
      state.bindReady = (ready) => { bound = ready.controller === controller; };
      return server;
    },
    createPreflightDependencies() { return {} as never; },
    async runPreflight() {
      await controller.bootstrap();
      return { controller } as never;
    },
    signals,
    reportError() {},
  };

  const running = main({}, dependencies);
  while (!launched) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(launched, true);
  signals.emit("SIGTERM");
  bootstrap.resolve();

  assert.equal(await running, 0);
  assert.equal(cancelled, true);
  assert.equal(bound, true);
  assert.equal(readiness.isReady(), false);
  assert.equal(closed, true);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});
