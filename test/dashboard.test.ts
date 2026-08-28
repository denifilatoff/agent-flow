import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, readFile, realpath, rename, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfigBundle } from "../src/config/load.ts";
import { RuntimeManager } from "../src/config/runtime.ts";
import {
  createDashboardSnapshot,
  discoverSessions,
  readDashboardSessionFile,
} from "../src/dashboard.ts";
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

test("discovers only the 100 newest canonical regular session directories without following symlinks", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "agent-flow-dashboard-sessions-"));
  const outside = await mkdtemp(join(tmpdir(), "agent-flow-dashboard-outside-"));
  t.after(async () => {
    await rm(data, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const sessions = join(data, "sessions");
  await mkdir(join(sessions, FLOW), { recursive: true });
  for (let index = 0; index < 101; index += 1) {
    const attempt = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const directory = join(sessions, FLOW, attempt);
    await mkdir(directory);
    await writeFile(join(directory, "context.json"), "{}\n");
    const timestamp = new Date(Date.UTC(2026, 7, 29, 0, 0, index));
    await utimes(directory, timestamp, timestamp);
  }
  await mkdir(join(sessions, "not-a-uuid"));
  await symlink(outside, join(sessions, FLOW, ATTEMPT), "dir");

  const result = await discoverSessions(data);

  assert.equal(result.available, true);
  assert.equal(result.entries.length, 100);
  assert.equal(result.entries[0]?.attemptUuid, "00000000-0000-4000-8000-000000000100");
  assert.equal(result.entries.at(-1)?.attemptUuid, "00000000-0000-4000-8000-000000000001");
  assert.equal(result.entries.some(({ attemptUuid }) => attemptUuid === ATTEMPT), false);
  assert.deepEqual(result.entries[0]?.files, ["context.json"]);
});

test("reads only allowed regular session files and caps content at one MiB", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "agent-flow-dashboard-read-"));
  const outside = await mkdtemp(join(tmpdir(), "agent-flow-dashboard-read-outside-"));
  t.after(async () => {
    await rm(data, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const attempt = join(data, "sessions", FLOW, ATTEMPT);
  await mkdir(attempt, { recursive: true });
  await writeFile(join(attempt, "harness.log"), "x".repeat(1_048_577));
  await symlink(join(outside, "decision.json"), join(attempt, "decision.json"));
  await mkdir(join(attempt, "context.json"));

  const read = await readDashboardSessionFile(
    data,
    FLOW,
    ATTEMPT,
    "harness.log",
    undefined,
    async (_fd, expectedPath) => expectedPath,
  );
  assert.equal(read.status, 200);
  if (read.status === 200) {
    assert.equal(Buffer.byteLength(read.body.content), 1_048_576);
    assert.equal(read.body.truncated, true);
  }
  assert.equal((await readDashboardSessionFile(data, "NOT-A-UUID", ATTEMPT, "harness.log")).status, 400);
  assert.equal((await readDashboardSessionFile(data, FLOW, ATTEMPT, "other.txt")).status, 400);
  assert.equal((await readDashboardSessionFile(data, FLOW, ATTEMPT, "decision.json")).status, 404);
  assert.equal((await readDashboardSessionFile(data, FLOW, ATTEMPT, "context.json")).status, 404);
});

test("rejects an attempt directory swapped during file open", async (t) => {
  for (const swapBack of [false, true]) {
    await t.test(swapBack ? "swapped back before verification" : "left swapped", async (t) => {
      const data = await mkdtemp(join(tmpdir(), "agent-flow-dashboard-swap-"));
      const outside = await mkdtemp(join(tmpdir(), "agent-flow-dashboard-swap-outside-"));
      t.after(async () => {
        await rm(data, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      });
      const flow = join(data, "sessions", FLOW);
      const attempt = join(flow, ATTEMPT);
      const parked = join(flow, `${ATTEMPT}.parked`);
      await mkdir(attempt, { recursive: true });
      await writeFile(join(attempt, "context.json"), "inside\n");
      await writeFile(join(outside, "context.json"), "outside\n");

      const result = await readDashboardSessionFile(data, FLOW, ATTEMPT, "context.json", async (path, flags) => {
        await rename(attempt, parked);
        await symlink(outside, attempt, "dir");
        const handle = await open(path, flags);
        if (swapBack) {
          await unlink(attempt);
          await rename(parked, attempt);
        }
        return handle;
      });

      assert.equal(result.status, 404);
    });
  }
});

test("rejects a second directory swap after pathname canonicalization", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "agent-flow-dashboard-second-swap-"));
  const outside = await mkdtemp(join(tmpdir(), "agent-flow-dashboard-second-swap-outside-"));
  t.after(async () => {
    await rm(data, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const flow = join(data, "sessions", FLOW);
  const attempt = join(flow, ATTEMPT);
  const parked = join(flow, `${ATTEMPT}.parked`);
  await mkdir(attempt, { recursive: true });
  await writeFile(join(attempt, "context.json"), "inside\n");
  await writeFile(join(outside, "context.json"), "outside\n");
  let openedPath = "";

  const result = await readDashboardSessionFile(
    data,
    FLOW,
    ATTEMPT,
    "context.json",
    async (path, flags) => {
      await rename(attempt, parked);
      await symlink(outside, attempt, "dir");
      const handle = await open(path, flags);
      openedPath = await realpath(path);
      await unlink(attempt);
      await rename(parked, attempt);
      return handle;
    },
    async () => {
      await rename(attempt, parked);
      await symlink(outside, attempt, "dir");
      return openedPath;
    },
  );

  assert.equal(result.status, 404);
});

test("fails closed when the open descriptor path is mismatched or unavailable", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "agent-flow-dashboard-descriptor-"));
  const outside = await mkdtemp(join(tmpdir(), "agent-flow-dashboard-descriptor-outside-"));
  t.after(async () => {
    await rm(data, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const attempt = join(data, "sessions", FLOW, ATTEMPT);
  await mkdir(attempt, { recursive: true });
  await writeFile(join(attempt, "context.json"), "inside\n");
  await writeFile(join(outside, "context.json"), "outside\n");

  const mismatch = await readDashboardSessionFile(
    data,
    FLOW,
    ATTEMPT,
    "context.json",
    undefined,
    async () => realpath(join(outside, "context.json")),
  );
  const unavailable = await readDashboardSessionFile(
    data,
    FLOW,
    ATTEMPT,
    "context.json",
    undefined,
    async () => { throw new Error("descriptor paths unavailable"); },
  );

  assert.equal(mismatch.status, 404);
  assert.equal(unavailable.status, 404);
});
