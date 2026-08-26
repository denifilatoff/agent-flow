import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import test from "node:test";

import type { Readiness } from "../src/health.ts";
import { main } from "../src/main.ts";
import type { Controller } from "../src/runtime/controller.ts";

test("a signal during bootstrap drains launched work without becoming ready", async () => {
  const bootstrap = Promise.withResolvers<void>();
  const signals = new EventEmitter();
  let launched = false;
  let cancelled = false;
  let closed = false;
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
      return { controller } as never;
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
  assert.equal(readiness.isReady(), false);
  assert.equal(closed, true);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});
