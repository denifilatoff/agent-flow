import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RuntimeManager, loadRuntimeConfig, runtimeDigest } from "../../src/config/runtime.ts";
import { parseYaml, validateDocument } from "../../src/config/schema-validator.ts";
import type { RuntimeConfig } from "../../src/config/types.ts";

test("loads the mounted runtime example with one exact Git revision", async () => {
  const generation = await loadRuntimeConfig("config/runtime.example.yaml");
  assert.equal(generation.config.configuration.revision.length, 40);
  assert.match(generation.runtimeDigest, /^[0-9a-f]{64}$/);
  validateDocument("RuntimeConfig", await parseYaml("config/runtime.example.yaml"));
});

test("rejects moving or abbreviated revisions", async () => {
  const runtime = await parseYaml("config/runtime.example.yaml") as RuntimeConfig;
  for (const revision of ["main", "v1", "0123456", `${"a".repeat(40)}~1`]) {
    assert.throws(() => validateDocument("RuntimeConfig", {
      ...runtime,
      configuration: { ...runtime.configuration, revision },
    }));
  }
});

test("normalizes mappings for a stable digest without reading secret files", async () => {
  const runtime = await parseYaml("config/runtime.example.yaml") as RuntimeConfig;
  const reordered = { ...runtime, runtime: runtime.runtime, polling: runtime.polling };
  assert.equal(runtimeDigest(runtime), runtimeDigest(reordered));

  const root = await mkdtemp(join(tmpdir(), "agent-flow-runtime-secret-"));
  try {
    const token = join(root, "token");
    const operatorPassword = join(root, "operator-password");
    await writeFile(token, "first-secret\n");
    await writeFile(operatorPassword, "first-password\n");
    const configured = {
      ...runtime,
      provider: { ...runtime.provider, tokenFile: token },
      runtime: { ...runtime.runtime, http: { ...runtime.runtime.http, authFile: operatorPassword } },
    };
    const before = runtimeDigest(configured);
    await writeFile(token, "second-secret\n");
    await writeFile(operatorPassword, "second-password\n");
    assert.equal(runtimeDigest(configured), before);
    assert.notEqual(runtimeDigest({
      ...configured,
      runtime: {
        ...configured.runtime,
        http: { ...configured.runtime.http, authFile: join(root, "replacement-password") },
      },
    }), before);
    assert.doesNotMatch(before, /secret/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects secret values and relative runtime paths", async () => {
  const runtime = await parseYaml("config/runtime.example.yaml") as RuntimeConfig;
  assert.throws(() => validateDocument("RuntimeConfig", {
    ...runtime,
    provider: { ...runtime.provider, token: "secret" },
  }));
  assert.throws(() => validateDocument("RuntimeConfig", {
    ...runtime,
    provider: { ...runtime.provider, tokenFile: "token" },
  }));
  assert.throws(() => validateDocument("RuntimeConfig", {
    ...runtime,
    runtime: { ...runtime.runtime, http: { ...runtime.runtime.http, authFile: "operator-password" } },
  }));
  const { authFile: _authFile, ...httpWithoutAuth } = runtime.runtime.http;
  assert.throws(() => validateDocument("RuntimeConfig", {
    ...runtime,
    runtime: { ...runtime.runtime, http: httpWithoutAuth },
  }));
  assert.equal((await readFile("config/runtime.example.yaml", "utf8")).includes("token:"), false);
});

test("rejects credentials and secret-bearing URL components", async () => {
  const runtime = await parseYaml("config/runtime.example.yaml") as RuntimeConfig;
  for (const apiUrl of [
    "https://user:password@api.github.com",
    "https://api.github.com?private_token=secret",
    "https://api.github.com#secret",
  ]) {
    assert.throws(() => validateDocument("RuntimeConfig", {
      ...runtime,
      provider: { ...runtime.provider, apiUrl },
    }));
  }
  for (const repository of [
    "https://token@github.com/example/agent-stack.git",
    "https://github.com/example/agent-stack.git?private_token=secret",
    "file:///config/agent-stack.git#secret",
  ]) {
    assert.throws(() => validateDocument("RuntimeConfig", {
      ...runtime,
      configuration: { ...runtime.configuration, repository },
    }));
  }

  const root = await mkdtemp(join(tmpdir(), "agent-flow-runtime-url-secret-"));
  try {
    const path = join(root, "runtime.yaml");
    const source = await readFile("config/runtime.example.yaml", "utf8");
    await writeFile(path, source.replace("https://api.github.com", "https://user:password@api.github.com"));
    await assert.rejects(loadRuntimeConfig(path), /RuntimeConfig validation failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects incomplete harness and pinned-catalog bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-runtime-bindings-"));
  try {
    const path = join(root, "runtime.yaml");
    const initial = await readFile("config/runtime.example.yaml", "utf8");
    await writeFile(path, initial);
    const manager = await RuntimeManager.create(path);
    manager.bindCatalog(Object.fromEntries(
      ["architect", "planner", "developer", "reviewer"].map((agentId) => [agentId, ["claude", "codex"] as const]),
    ));
    await writeFile(path, initial.replace("    claude:\n      authFile: /run/secrets/agent-flow/claude-auth\n", ""));
    await manager.reload();
    assert.equal(manager.mayStartWork(), false);
    assert.match(manager.status().validationErrors[0]!, /harness binding is missing/);

    await writeFile(path, initial.replace(/    reviewer:\n(?:      .+\n){6}/, ""));
    await manager.reload();
    assert.equal(manager.mayStartWork(), false);
    assert.deepEqual(manager.status().validationErrors, ["runtime agent bindings do not match the pinned catalog"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps bindings for unfinished pinned catalogs and rejects unsupported harnesses", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-runtime-catalogs-"));
  try {
    const path = join(root, "runtime.yaml");
    const initial = await readFile("config/runtime.example.yaml", "utf8");
    const withLegacy = initial.replace("    reviewer:\n", `    legacy-reviewer:
      harness: codex
      model: legacy-reviewer-model
      reasoning: high
      maxAttempts: 3
      delaySeconds: 30
      timeoutSeconds: 2700
    reviewer:
`);
    await writeFile(path, withLegacy);
    const manager = await RuntimeManager.create(path);
    manager.bindCatalog({
      architect: ["claude"], planner: ["claude"], developer: ["codex"], reviewer: ["codex"],
    });
    manager.bindCatalog({ "legacy-reviewer": ["codex"] });
    assert.equal((await manager.execution("legacy-reviewer")).executionSnapshot.model, "legacy-reviewer-model");
    assert.throws(() => manager.bindCatalog({ developer: ["claude"] }), /not supported/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts reloadable generations and drains on restart-only or invalid replacements", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-runtime-reload-"));
  try {
    const path = join(root, "runtime.yaml");
    const initial = await readFile("config/runtime.example.yaml", "utf8");
    await writeFile(path, initial);
    const manager = await RuntimeManager.create(path);
    const firstDigest = manager.status().runtimeDigest;

    await writeFile(path, initial.replace("intervalSeconds: 300", "intervalSeconds: 600"));
    await manager.reload();
    assert.equal(manager.effective().polling.intervalSeconds, 600);
    assert.notEqual(manager.status().runtimeDigest, firstDigest);
    assert.equal(manager.mayStartWork(), true);

    manager.attemptStarted();
    await writeFile(path, initial.replace("port: 8080", "port: 8081"));
    await manager.reload();
    assert.equal(manager.effective().runtime.http.port, 8080);
    assert.equal(manager.status().restartRequired, true);
    assert.deepEqual(manager.status().changedRestartFields, ["runtime.http.port"]);
    assert.equal(manager.status().safeToRestart, false);
    assert.equal(manager.mayStartWork(), false);
    manager.attemptFinished();
    assert.equal(manager.status().safeToRestart, true);

    await writeFile(path, initial.replace(
      "/run/secrets/agent-flow/operator-password",
      "/run/secrets/agent-flow/replacement-operator-password",
    ));
    await manager.reload();
    assert.equal(manager.effective().runtime.http.authFile, "/run/secrets/agent-flow/operator-password");
    assert.deepEqual(manager.status().changedRestartFields, ["runtime.http.authFile"]);

    await writeFile(path, "not: valid\n");
    await manager.reload();
    assert.equal(manager.status().validationErrors.length, 1);
    assert.equal(manager.mayStartWork(), false);

    await writeFile(path, initial);
    await manager.reload();
    assert.equal(manager.status().restartRequired, false);
    assert.deepEqual(manager.status().validationErrors, []);
    assert.equal(manager.mayStartWork(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
