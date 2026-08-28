import assert from "node:assert/strict";
import test from "node:test";

import { loadConfigBundle } from "../src/config/load.ts";
import type { RuntimeManager } from "../src/config/runtime.ts";
import type { RuntimeConfig } from "../src/config/types.ts";
import type { HarnessAdapter } from "../src/harness/types.ts";
import type { ProviderAdapter } from "../src/provider/types.ts";
import type { Controller } from "../src/runtime/controller.ts";
import { runPreflight, type PreflightDependencies } from "../src/preflight.ts";

const bundle = await loadConfigBundle(process.cwd(), "config/stack.yaml", "a".repeat(40));
const runtimeConfig: RuntimeConfig = {
  apiVersion: "agent-flow/v1alpha1",
  kind: "RuntimeConfig",
  configuration: { repository: "/config", revision: bundle.revision, stack: "config/stack.yaml" },
  provider: {
    type: "github", apiUrl: "https://api.github.test", repositories: ["owner/repo"], tokenFile: "/secrets/token",
  },
  execution: {
    agents: Object.fromEntries(Object.keys(bundle.catalog.agents).map((id) => [id, {
      harness: id === "architect" || id === "planner" ? "claude" : "codex",
      model: "fixture-model", reasoning: "high", maxAttempts: 1, delaySeconds: 0, timeoutSeconds: 1,
    }])),
    harnesses: { claude: { authFile: "/secrets/claude" }, codex: { authFile: "/secrets/codex" } },
  },
  polling: { intervalSeconds: 300, maxCallsPerMinute: 20, quotaReservePercent: 25 },
  runtime: { concurrency: 2, dataDirectory: "/data", http: { address: "127.0.0.1", port: 8080 } },
};

function provider(calls: string[]): ProviderAdapter {
  return {
    kind: "github",
    async verifyAuth() { calls.push("github:rest"); return { login: "operator", providerId: "1" }; },
  } as ProviderAdapter;
}

function harness(target: "claude" | "codex", calls: string[]): HarnessAdapter {
  return { target, async preflight() { calls.push(`${target}:auth`); }, async run() { throw new Error("unused"); } };
}

function dependencies(calls: string[], fail?: string): PreflightDependencies {
  const controller: Controller = {
    async bootstrap() { calls.push("controller:bootstrap"); if (fail === "controller") throw new Error("secret"); },
    async run() {}, async reconcileNow() {},
  };
  return {
    runtime: { effective: () => runtimeConfig, bindCatalog() {} } as RuntimeManager,
    async loadConfig() { calls.push("config:load"); if (fail === "config") throw new Error("token=secret"); return bundle; },
    async validateConfig() { calls.push("config:validate"); if (fail === "validate") throw new Error("secret schema"); },
    async prepareDirectories() { calls.push("directories"); if (fail === "directories") throw new Error("/secret/path"); },
    createProviders() { return { github: provider(calls) }; },
    async providerEnvironment() { calls.push("provider:environment"); return { PATH: "/bin", GH_ENTERPRISE_TOKEN: "secret" }; },
    createHarnesses() { return { claude: harness("claude", calls), codex: harness("codex", calls) }; },
    async runCommand(file, args) {
      const name = `${file}:${args.join(" ")}`;
      calls.push(name);
      if (fail === name) throw new Error("stdout token=secret");
      return { stdout: "ignored", stderr: "ignored" };
    },
    createController() { calls.push("controller:create"); return controller; },
  };
}

test("runs fail-closed startup checks in a fixed order", async () => {
  const calls: string[] = [];
  const ready = await runPreflight(dependencies(calls));

  assert.equal(ready.bundle, bundle);
  assert.deepEqual(calls, [
    "config:load", "config:validate", "directories", "github:rest", "provider:environment",
    "gh:auth status --hostname api.github.test", "git:--version", "apm:--version",
    "claude:auth", "codex:auth", "controller:create", "controller:bootstrap",
  ]);
});

for (const [failure, message] of [
  ["config", "configuration load failed"],
  ["validate", "configuration validation failed"],
  ["directories", "data directory preflight failed"],
  ["gh:auth status --hostname api.github.test", "github agent authentication failed"],
  ["git:--version", "git executable preflight failed"],
  ["apm:--version", "apm executable preflight failed"],
  ["controller", "controller bootstrap failed"],
] as const) {
  test(`fails closed at ${failure} without leaking command output`, async () => {
    await assert.rejects(runPreflight(dependencies([], failure)), (error: unknown) => {
      assert.equal((error as Error).message, message);
      assert.doesNotMatch((error as Error).message, /secret|token|stdout/);
      return true;
    });
  });
}

test("fails closed on provider REST authentication before CLI checks", async () => {
  const calls: string[] = [];
  const configured = dependencies(calls);
  configured.createProviders = () => ({
    github: { ...provider(calls), async verifyAuth() { throw new Error("token=secret"); } },
  });
  await assert.rejects(runPreflight(configured), { message: "github REST authentication failed" });
  assert.equal(calls.some((call) => call.startsWith("gh:")), false);
});

for (const [stage, message] of [
  ["providers", "provider configuration failed"],
  ["harnesses", "harness configuration failed"],
  ["controller", "controller configuration failed"],
] as const) {
  test(`redacts synchronous ${stage} factory failures`, async () => {
    const configured = dependencies([]);
    if (stage === "providers") configured.createProviders = () => { throw new Error("token=secret"); };
    if (stage === "harnesses") configured.createHarnesses = () => { throw new Error("credential=secret"); };
    if (stage === "controller") configured.createController = () => { throw new Error("command output secret"); };
    await assert.rejects(runPreflight(configured), { message });
  });
}

for (const target of ["claude", "codex"] as const) {
  test(`fails closed on ${target} binary or authentication preflight`, async () => {
    const configured = dependencies([]);
    configured.createHarnesses = () => ({
      claude: harness("claude", []), codex: harness("codex", []),
      [target]: { ...harness(target, []), async preflight() { throw new Error("credential=secret"); } },
    });
    await assert.rejects(runPreflight(configured), { message: `${target} harness preflight failed` });
  });
}
