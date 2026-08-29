import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfigBundle } from "../src/config/load.ts";
import { RuntimeManager } from "../src/config/runtime.ts";
import { createDashboardSnapshot, discoverSessions } from "../src/dashboard.ts";
import type { ReadyDependencies } from "../src/preflight.ts";
import type { Controller } from "../src/runtime/controller.ts";

const FLOW = "11111111-1111-4111-8111-111111111111";
const ATTEMPT = "22222222-2222-4222-8222-222222222222";

test("projects the real runtime and pinned configuration without paths to secrets or persistent data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-dashboard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "sessions"));
  const runtimePath = join(root, "runtime.yaml");
  const source = await readFile("config/runtime.example.yaml", "utf8");
  await writeFile(runtimePath, source.replace("/var/lib/agent-flow", root));
  const runtime = await RuntimeManager.create(runtimePath);
  const bundle = await loadConfigBundle(process.cwd(), "config/stack.yaml", "a".repeat(40));
  const controller: Controller = {
    async bootstrap() {}, async run() {}, async reconcileNow() {},
    snapshot: () => ({
      lifecycle: "ready", repositories: [], tickets: [],
      queue: { active: 0, queued: 0, concurrency: 4 }, activeWork: [], errors: [],
    }),
  };
  const ready = {
    bundle,
    providers: { github: {} as never },
    harnesses: { claude: {} as never, codex: {} as never },
    controller,
    preflight: {
      status: "ready", provider: "github", harnesses: ["claude", "codex"], configurationRevision: bundle.revision,
    },
  } satisfies ReadyDependencies;

  const dashboard = await createDashboardSnapshot(runtime, ready);
  const serialized = JSON.stringify(dashboard);

  assert.equal(dashboard.available, true);
  assert.equal(dashboard.configuration.revision, bundle.revision);
  assert.equal(Object.keys(dashboard.flow.spec.states).length, 11);
  assert.deepEqual(Object.keys(dashboard.catalog.agents), ["architect", "planner", "developer", "reviewer"]);
  assert.equal(dashboard.preflight.status, "ready");
  assert.equal(dashboard.controller.lifecycle, "ready");
  assert.equal(dashboard.sessions.available, true);
  for (const forbidden of ["tokenFile", "authFile", "dataDirectory", "/run/secrets/", root]) {
    assert.equal(serialized.includes(forbidden), false, `dashboard exposed ${forbidden}`);
  }
});

test("stops session discovery after 100 entries and one truncation probe without advertising harness logs", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "agent-flow-dashboard-sessions-"));
  const outside = await mkdtemp(join(tmpdir(), "agent-flow-dashboard-outside-"));
  t.after(async () => {
    await rm(data, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const sessions = join(data, "sessions");
  await mkdir(join(sessions, FLOW), { recursive: true });
  for (let index = 0; index < 102; index += 1) {
    const attempt = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const directory = join(sessions, FLOW, attempt);
    await mkdir(directory);
    await writeFile(join(directory, "context.json"), "{}\n");
    await writeFile(join(directory, "harness.log"), "provider-token=secret\n");
    const timestamp = new Date(Date.UTC(2026, 7, 29, 0, 0, index));
    await utimes(directory, timestamp, timestamp);
  }
  await mkdir(join(sessions, "not-a-uuid"));
  await symlink(outside, join(sessions, FLOW, ATTEMPT), "dir");

  const result = await discoverSessions(data);

  assert.equal(result.available, true);
  assert.equal(result.truncated, true);
  assert.ok(result.entries.length <= 100);
  assert.equal(new Set(result.entries.map(({ attemptUuid }) => attemptUuid)).size, result.entries.length);
  assert.equal(result.entries.some(({ attemptUuid }) => attemptUuid === ATTEMPT), false);
  assert.equal(result.entries.some((entry) => "files" in entry), false);
  assert.equal(JSON.stringify(result).includes("provider-token=secret"), false);
  assert.equal(JSON.stringify(result).includes("harness.log"), false);

  await rm(join(sessions, FLOW, "00000000-0000-4000-8000-000000000100"), { recursive: true });
  await rm(join(sessions, FLOW, "00000000-0000-4000-8000-000000000101"), { recursive: true });
  const exactLimit = await discoverSessions(data);
  assert.equal(exactLimit.available, true);
  assert.equal(exactLimit.truncated, true);
  assert.ok(exactLimit.entries.length <= 100);
});

test("bounds discovery across invalid, non-directory, empty-flow, and invalid-attempt dirents", async (t) => {
  await t.test("top-level entries", async (t) => {
    const data = await mkdtemp(join(tmpdir(), "agent-flow-dashboard-root-budget-"));
    t.after(() => rm(data, { recursive: true, force: true }));
    const sessions = join(data, "sessions");
    await mkdir(sessions, { recursive: true });
    for (let index = 0; index < 34; index += 1) {
      await mkdir(join(sessions, `invalid-${index}`));
      await writeFile(join(sessions, `file-${index}`), "ignored\n");
      await mkdir(join(sessions, `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`));
    }

    const result = await discoverSessions(data);

    assert.equal(result.available, true);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.entries, []);
  });

  await t.test("attempt entries", async (t) => {
    const data = await mkdtemp(join(tmpdir(), "agent-flow-dashboard-attempt-budget-"));
    t.after(() => rm(data, { recursive: true, force: true }));
    const flow = join(data, "sessions", FLOW);
    await mkdir(flow, { recursive: true });
    for (let index = 0; index < 101; index += 1) await mkdir(join(flow, `invalid-${index}`));

    const result = await discoverSessions(data);

    assert.equal(result.available, true);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.entries, []);
  });
});
