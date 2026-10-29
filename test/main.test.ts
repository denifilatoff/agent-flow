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
  let operatorSecretReads = 0;
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
      effective: () => ({ runtime: { http: {
        address: "127.0.0.1", port: 8080, authFile: "/run/secrets/agent-flow/operator-password",
      } }, configuration: {
        repository: "/config", revision: "a".repeat(40),
      } } as RuntimeConfig),
      mayStartWork: () => true,
      status: () => ({ runtimeDigest: "b".repeat(64), validationErrors: [], restartRequired: false,
        restartReason: null, changedRestartFields: [], activeAttempts: 0, safeToRestart: false }),
    } as RuntimeManager; },
    async readSecretFile(path) {
      operatorSecretReads += 1;
      assert.equal(path, "/run/secrets/agent-flow/operator-password");
      return "operator-password";
    },
    createHealthServer(_address, _port, state, password) {
      assert.equal(password, "operator-password");
      readiness = state;
      state.bindReady = (ready) => { bound = ready.controller === controller; };
      return server;
    },
    createPreflightDependencies() {
      return { registerStartupSecret(value: string) { assert.equal(value, "operator-password"); } } as never;
    },
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
  assert.equal(operatorSecretReads, 1);
  assert.equal(readiness.isReady(), false);
  assert.equal(closed, true);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("fails before binding when the operator password cannot be read", async () => {
  const calls: string[] = [];
  const operatorPath = "/run/secrets/agent-flow/operator-password";
  const dependencies = {
    async createRuntime() {
      calls.push("runtime");
      return {
        effective: () => ({
          runtime: { http: { address: "0.0.0.0", port: 8080, authFile: operatorPath } },
        } as RuntimeConfig),
      } as RuntimeManager;
    },
    createPreflightDependencies() {
      calls.push("dependencies");
      return { registerStartupSecret() { calls.push("register"); } } as never;
    },
    async readSecretFile(path: string) {
      calls.push(`secret:${path}`);
      throw new Error(`cannot read ${path}: password-value`);
    },
    createHealthServer() {
      calls.push("listen");
      throw new Error("must not bind");
    },
    async runPreflight() { throw new Error("must not run"); },
    signals: new EventEmitter(),
    reportError(message: string) { calls.push(`error:${message}`); },
  };

  assert.equal(await main({}, dependencies as never), 1);
  assert.deepEqual(calls, [
    "runtime",
    `secret:${operatorPath}`,
    "error:agent-flow startup failed: operator authentication load failed",
  ]);
  assert.equal(calls.join("\n").includes("password-value"), false);
});

test("fails before binding when the operator password cannot fit in HTTP headers", async () => {
  let bound = false;
  const dependencies = {
    async createRuntime() { return {
      effective: () => ({ runtime: { http: { address: "0.0.0.0", port: 8080, authFile: "/operator-password" } } } as RuntimeConfig),
    } as RuntimeManager; },
    async readSecretFile() { return "x".repeat(4_097); },
    createPreflightDependencies() { throw new Error("must not create dependencies"); },
    createHealthServer() { bound = true; throw new Error("must not bind"); },
    async runPreflight() { throw new Error("must not run"); },
    signals: new EventEmitter(),
    reportError(message: string) { assert.equal(message, "agent-flow startup failed: operator authentication load failed"); },
  };

  assert.equal(await main({}, dependencies as never), 1);
  assert.equal(bound, false);
});
