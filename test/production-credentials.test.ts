import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";

import { RuntimeManager } from "../src/config/runtime.ts";
import type { RuntimeConfig } from "../src/config/types.ts";
import { createProductionDependencies } from "../src/main.ts";

async function fixture(apiUrl: string): Promise<{
  root: string;
  tokenFile: string;
  production: ReturnType<typeof createProductionDependencies>;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-production-credential-"));
  const tokenFile = join(root, "provider-token");
  const authFile = join(root, "codex-auth");
  const runtimeFile = join(root, "runtime.yaml");
  await writeFile(tokenFile, "mounted-provider-token\n", { mode: 0o600 });
  await writeFile(authFile, "{}\n", { mode: 0o600 });
  const execution = {
    harness: "codex" as const, model: "fixture-model", reasoning: "high" as const,
    maxAttempts: 2, delaySeconds: 0, timeoutSeconds: 60,
  };
  const config: RuntimeConfig = {
    apiVersion: "agent-flow/v1alpha1",
    kind: "RuntimeConfig",
    configuration: { repository: "/config", revision: "a".repeat(40), stack: "config/stack.yaml" },
    provider: { type: "github", apiUrl, repositories: ["owner/repo"], tokenFile },
    execution: {
      agents: Object.fromEntries(["architect", "planner", "developer", "reviewer"].map((id) => [id, execution])),
      harnesses: { codex: { authFile } },
    },
    polling: { intervalSeconds: 300, maxCallsPerMinute: 20, quotaReservePercent: 25 },
    runtime: { concurrency: 2, dataDirectory: join(root, "data"), http: { address: "127.0.0.1", port: 8080 } },
  };
  await writeFile(runtimeFile, stringify(config), { mode: 0o600 });
  const runtime = await RuntimeManager.create(runtimeFile);
  return { root, tokenFile, production: createProductionDependencies(runtime) };
}

test("reads the mounted provider secret once and exposes only the fixed public GitHub environment", async (t) => {
  const { root, tokenFile, production } = await fixture("https://api.github.com");
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = await production.providerEnvironment();
  await writeFile(tokenFile, "replacement-token\n", { mode: 0o600 });

  assert.equal(environment.GH_TOKEN, "mounted-provider-token");
  assert.equal((await production.providerEnvironment()).GH_TOKEN, "mounted-provider-token");
  assert.deepEqual(Object.keys(environment).sort(), ["GH_TOKEN", "PATH"]);
  assert.equal(JSON.stringify(production.runtime.status()).includes("mounted-provider-token"), false);
});

test("uses the fixed enterprise GitHub environment without leaking ambient credentials", async (t) => {
  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "ambient-public-token";
  t.after(() => {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  });
  const { root, production } = await fixture("https://github.enterprise.test/api/v3");
  t.after(() => rm(root, { recursive: true, force: true }));

  const environment = await production.providerEnvironment();
  assert.equal(environment.GH_ENTERPRISE_TOKEN, "mounted-provider-token");
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.GH_TOKEN, undefined);
});
