import { createHealthServer } from "/app/dist/health.js";
import { createProductionDependencies, main } from "/app/dist/main.js";
import { runPreflight } from "/app/dist/preflight.js";

let timestamp = Date.now();
const rateLimiterClock = {
  now: () => timestamp,
  sleep: async (milliseconds) => { timestamp += milliseconds; },
};

const exitCode = await main(process.env, {
  createHealthServer,
  createPreflightDependencies(environment, healthPort) {
    const production = createProductionDependencies(environment, healthPort, rateLimiterClock);
    return {
      ...production,
      createController(bundle, providers, harnesses) {
        return production.createController({
          ...bundle,
          controller: {
            ...bundle.controller,
            polling: { ...bundle.controller.polling, intervalSeconds: 0.05 },
          },
        }, providers, harnesses);
      },
    };
  },
  runPreflight,
  signals: process,
  reportError: (message) => console.error(message),
});
process.exitCode = exitCode;
