import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import type { ConfigBundle } from "../src/config/load.ts";
import type { HarnessAdapter } from "../src/harness/types.ts";
import type { ProviderAdapter } from "../src/provider/types.ts";
import type { Controller } from "../src/runtime/controller.ts";
import { loadControllerId } from "../src/runtime/identity.ts";
import { openLocalStore, providerScope, type LocalStore } from "../src/runtime/local-store.ts";
import { runPreflight, type PreflightDependencies } from "../src/preflight.ts";

const CONTROLLER_ID = "11111111-1111-4111-8111-111111111111";

const bundle = {
  revision: "a".repeat(40),
  root: "/pinned",
  controller: {
    apiVersion: "agent-flow/v1alpha1",
    kind: "ControllerConfig",
    configuration: { repository: "/config", flow: "config/flows/development.yaml", catalog: "config/agents.yaml" },
    providers: {
      github: { apiUrl: "https://api.github.test", tokenEnv: "GITHUB_TOKEN", repositories: ["owner/repo"] },
      gitlab: { apiUrl: "https://gitlab.test/api/v4", tokenEnv: "GITLAB_TOKEN", repositories: ["group/repo"] },
    },
    polling: { intervalSeconds: 300, maxCallsPerMinute: 20, quotaReservePercent: 25 },
    runtime: { concurrency: 2, dataDirectory: "/data", healthPort: 8080 },
  },
  flow: { apiVersion: "agent-flow/v1alpha1", kind: "Flow", metadata: {
    id: "development", activationLabel: "agent-flow:development", managedLabel: "agent-flow:managed",
  }, spec: { initial: "assessment", states: {} } },
  catalog: { apiVersion: "agent-flow/v1alpha1", kind: "AgentCatalog", agents: {
    architect: { package: "agent-packages/architect", target: "claude", retry: {
      maxAttempts: 1, delaySeconds: 0, timeoutSeconds: 1,
    } },
    developer: { package: "agent-packages/developer", target: "codex", retry: {
      maxAttempts: 1, delaySeconds: 0, timeoutSeconds: 1,
    } },
  } },
} satisfies ConfigBundle;

function provider(kind: "github" | "gitlab", calls: string[]): ProviderAdapter {
  return { kind, async verifyAuth() { calls.push(`${kind}:rest`); return { login: "operator", providerId: "1" }; } } as ProviderAdapter;
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
    async loadConfig() { calls.push("config:load"); if (fail === "config") throw new Error("token=secret"); return bundle; },
    async validateConfig() { calls.push("config:validate"); if (fail === "validate") throw new Error("secret schema"); },
    async prepareDirectories() { calls.push("directories"); if (fail === "directories") throw new Error("/secret/path"); },
    async loadControllerId() {
      calls.push("identity");
      if (fail === "identity") throw new Error("secret identity");
      return CONTROLLER_ID;
    },
    openLocalStore() {
      calls.push("store:open");
      if (fail === "store") throw new Error("secret database");
      return memoryStore(calls);
    },
    createProviders() {
      return { github: provider("github", calls), gitlab: provider("gitlab", calls) };
    },
    createHarnesses() {
      return { claude: harness("claude", calls), codex: harness("codex", calls) };
    },
    async runCommand(file, args) {
      const name = `${file}:${args.join(" ")}`;
      calls.push(name);
      if (fail === name) throw new Error("stdout token=secret");
      return { stdout: "ignored", stderr: "ignored" };
    },
    createController(_bundle, _providers, _harnesses, runtime) {
      calls.push("controller:create");
      assert.equal(runtime.controllerId, CONTROLLER_ID);
      assert.deepEqual(runtime.providerScopes, {
        github: "github:https://api.github.test",
        gitlab: "gitlab:https://gitlab.test/api/v4",
      });
      return controller;
    },
  };
}

function memoryStore(calls: string[] = []): LocalStore {
  return {
    load() { return null; },
    save() { throw new Error("unused"); },
    close() { calls.push("store:close"); },
  };
}

test("runs fail-closed startup checks in a fixed order", async () => {
  const calls: string[] = [];
  const ready = await runPreflight(dependencies(calls));

  assert.equal(ready.bundle, bundle);
  assert.deepEqual(calls, [
    "config:load", "config:validate", "directories", "identity", "store:open",
    "github:rest", "gitlab:rest",
    "gh:auth status --hostname api.github.test", "glab:auth status --hostname gitlab.test",
    "git:--version", "apm:--version",
    "claude:auth", "codex:auth",
    "controller:create", "controller:bootstrap",
  ]);
});

for (const [failure, message] of [
  ["config", "configuration load failed"],
  ["validate", "configuration validation failed"],
  ["directories", "data directory preflight failed"],
  ["identity", "controller identity load failed"],
  ["store", "local execution store open failed"],
  ["gh:auth status --hostname api.github.test", "github agent authentication failed"],
  ["glab:auth status --hostname gitlab.test", "gitlab agent authentication failed"],
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

for (const directory of ["repository", "worktree", "session"] as const) {
  test(`fails closed when the ${directory} data path is not writable`, async () => {
    const configured = dependencies([]);
    configured.prepareDirectories = async () => { throw new Error(`${directory} /private/secret`); };
    await assert.rejects(runPreflight(configured), { message: "data directory preflight failed" });
  });
}

test("fails closed on provider REST authentication before CLI checks", async () => {
  const calls: string[] = [];
  const configured = dependencies(calls);
  configured.createProviders = () => ({
    github: { ...provider("github", calls), async verifyAuth() { throw new Error("token=secret"); } },
    gitlab: provider("gitlab", calls),
  });
  await assert.rejects(runPreflight(configured), { message: "github REST authentication failed" });
  assert.equal(calls.some((call) => call.startsWith("gh:")), false);
});

test("closes the local store when a later preflight check fails", async () => {
  const calls: string[] = [];
  await assert.rejects(runPreflight(dependencies(calls, "gh:auth status --hostname api.github.test")));
  assert.equal(calls.filter((call) => call === "store:close").length, 1);
});

test("keeps the controller identity when the SQLite database is reset", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-startup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configuredBundle = structuredClone(bundle);
  configuredBundle.controller.runtime.dataDirectory = directory;

  const start = async () => {
    let observed = "";
    const configured = dependencies([]);
    configured.loadConfig = async () => configuredBundle;
    configured.prepareDirectories = async () => undefined;
    configured.loadControllerId = loadControllerId;
    configured.openLocalStore = openLocalStore;
    configured.createController = (_bundle, _providers, _harnesses, runtime) => {
      observed = runtime.controllerId;
      return { async bootstrap() {}, async run() {}, async reconcileNow() {} };
    };
    const ready = await runPreflight(configured);
    ready.store.close();
    return observed;
  };

  const before = await start();
  await unlink(join(directory, "execution.sqlite"));
  const after = await start();

  assert.equal(after, before);
  assert.equal(await loadControllerId(directory), before);
});

test("fails startup without replacing a corrupt controller identity", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-startup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "controller-id"), "corrupt\n");
  const configuredBundle = structuredClone(bundle);
  configuredBundle.controller.runtime.dataDirectory = directory;
  const configured = dependencies([]);
  configured.loadConfig = async () => configuredBundle;
  configured.prepareDirectories = async () => undefined;
  configured.loadControllerId = loadControllerId;
  configured.openLocalStore = openLocalStore;

  await assert.rejects(runPreflight(configured), { message: "controller identity load failed" });
  assert.equal(await readFile(join(directory, "controller-id"), "utf8"), "corrupt\n");
});

test("fails startup without replacing an unsupported SQLite database", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-startup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await loadControllerId(directory);
  const databasePath = join(directory, "execution.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA user_version = 2");
  database.close();
  const configuredBundle = structuredClone(bundle);
  configuredBundle.controller.runtime.dataDirectory = directory;
  const configured = dependencies([]);
  configured.loadConfig = async () => configuredBundle;
  configured.prepareDirectories = async () => undefined;
  configured.loadControllerId = loadControllerId;
  configured.openLocalStore = openLocalStore;

  await assert.rejects(runPreflight(configured), { message: "local execution store open failed" });
  const preserved = new DatabaseSync(databasePath);
  assert.equal((preserved.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
  preserved.close();
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
