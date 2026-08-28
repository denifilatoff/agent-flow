import { createHealthServer } from "/app/dist/health.js";
import { RuntimeManager } from "/app/dist/config/runtime.js";
import { createProductionDependencies, main } from "/app/dist/main.js";
import { runPreflight } from "/app/dist/preflight.js";

let timestamp = Date.now();
const rateLimiterClock = {
  now: () => timestamp,
  sleep: async (milliseconds) => { timestamp += milliseconds; },
};

const exitCode = await main(process.env, {
  createHealthServer,
  async createRuntime() {
    return RuntimeManager.create();
  },
  createPreflightDependencies(runtime) {
    return createProductionDependencies(runtime, rateLimiterClock);
  },
  runPreflight,
  signals: process,
  reportError: (message) => console.error(message),
});
process.exitCode = exitCode;
