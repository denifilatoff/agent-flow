import assert from "node:assert/strict";
import {
  appendFile,
  mkdtemp,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfigBundle } from "../src/config/load.ts";
import { RuntimeManager } from "../src/config/runtime.ts";
import { createDashboardSnapshot, discoverSessions, readDashboardSessionFile } from "../src/dashboard.ts";
import { createStartupRedactor } from "../src/redaction.ts";
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
      queue: { active: 0, queued: 0, concurrency: 4 }, locks: [], activeWork: [], errors: [],
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
    redactSessionContent: (value: string) => value,
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
  assert.deepEqual(dashboard.configuration.provenance, {
    repositoryUrl: "https://github.com/example/agent-stack",
    revisionUrl: `https://github.com/example/agent-stack/tree/${bundle.revision}`,
    stackUrl: `https://github.com/example/agent-stack/blob/${bundle.revision}/config/stack.yaml`,
    flowUrl: `https://github.com/example/agent-stack/blob/${bundle.revision}/config/flows/development.yaml`,
    catalogUrl: `https://github.com/example/agent-stack/blob/${bundle.revision}/config/agents.yaml`,
    agentPackageUrls: {
      architect: `https://github.com/example/agent-stack/tree/${bundle.revision}/agent-packages/architect`,
      planner: `https://github.com/example/agent-stack/tree/${bundle.revision}/agent-packages/planner`,
      developer: `https://github.com/example/agent-stack/tree/${bundle.revision}/agent-packages/developer`,
      reviewer: `https://github.com/example/agent-stack/tree/${bundle.revision}/agent-packages/reviewer`,
    },
  });
  for (const forbidden of ["tokenFile", "authFile", "dataDirectory", "/run/secrets/", root]) {
    assert.equal(serialized.includes(forbidden), false, `dashboard exposed ${forbidden}`);
  }
});

test("stops session discovery after its global budget while advertising only safe files", async (t) => {
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
  await writeFile(join(outside, "decision.json"), "{}\n");
  await symlink(
    join(outside, "decision.json"),
    join(sessions, FLOW, "00000000-0000-4000-8000-000000000000", "decision.json"),
  );
  await mkdir(join(sessions, "not-a-uuid"));
  await symlink(outside, join(sessions, FLOW, ATTEMPT), "dir");

  const result = await discoverSessions(data);

  assert.equal(result.available, true);
  assert.equal(result.truncated, true);
  assert.ok(result.entries.length <= 100);
  assert.equal(new Set(result.entries.map(({ attemptUuid }) => attemptUuid)).size, result.entries.length);
  assert.equal(result.entries.some(({ attemptUuid }) => attemptUuid === ATTEMPT), false);
  assert.deepEqual(result.entries[0]?.files, ["harness.log", "context.json"]);
  assert.equal(result.entries.find(({ attemptUuid }) => attemptUuid.endsWith("000000000000"))?.files.includes("decision.json"), false);
  assert.equal(JSON.stringify(result).includes("provider-token=secret"), false);

});

test("distinguishes exactly 100 attempts from a truncated 101-attempt scan", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "agent-flow-dashboard-exact-limit-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const flow = join(data, "sessions", FLOW);
  await mkdir(flow, { recursive: true });
  for (let index = 0; index < 100; index += 1) {
    await mkdir(join(flow, `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`));
  }

  const exact = await discoverSessions(data);
  assert.equal(exact.available, true);
  assert.equal(exact.truncated, false);
  assert.equal(exact.entries.length, 100);

  await mkdir(join(flow, "00000000-0000-4000-8000-000000000100"));
  const over = await discoverSessions(data);
  assert.equal(over.available, true);
  assert.equal(over.truncated, true);
  assert.equal(over.entries.length, 100);
});

test("reads and redacts only complete allowlisted session files within one MiB", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "agent-flow-dashboard-read-"));
  const outside = await mkdtemp(join(tmpdir(), "agent-flow-dashboard-read-outside-"));
  t.after(async () => {
    await rm(data, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const attempt = join(data, "sessions", FLOW, ATTEMPT);
  await mkdir(attempt, { recursive: true });
  const secret = "provider-token+/=42";
  const numericSecret = "314159";
  const redactor = createStartupRedactor();
  redactor.register(secret);
  redactor.register(numericSecret);
  await writeFile(join(attempt, "harness.log"), [
    secret,
    encodeURIComponent(secret),
    Buffer.from(secret).toString("base64"),
    Buffer.from(secret).toString("hex"),
  ].join("\n"));
  await writeFile(join(attempt, "decision.json"), JSON.stringify({ event: "done", token: secret, pin: 314159 }));
  await writeFile(join(attempt, "context.json"), `{\"prompt\":\"${secret}`);
  await writeFile(join(attempt, "other.txt"), secret);
  await symlink(join(outside, "context.json"), join(attempt, "linked.json"));

  for (const file of ["harness.log", "decision.json", "context.json"] as const) {
    const result = await readDashboardSessionFile(
      data,
      FLOW,
      ATTEMPT,
      file,
      redactor.redact,
      undefined,
      async (_fd, expectedPath) => expectedPath,
    );
    assert.equal(result.status, 200, file);
    if (result.status !== 200) continue;
    assert.equal(result.body.content.includes(secret), false, file);
    assert.ok(Buffer.byteLength(result.body.content) <= 1_048_576, file);
    if (file === "decision.json") assert.deepEqual(JSON.parse(result.body.content), {
      event: "done", token: "[REDACTED]", pin: "[REDACTED]",
    });
    if (file === "context.json") assert.equal(result.body.content, `{\"prompt\":\"[REDACTED]`);
    assert.equal(result.body.truncated, false);
  }
  assert.equal((await readDashboardSessionFile(data, FLOW, ATTEMPT, "other.txt", redactor.redact)).status, 400);
  assert.equal((await readDashboardSessionFile(data, "NOT-A-UUID", ATTEMPT, "context.json", redactor.redact)).status, 400);
  assert.equal((await readDashboardSessionFile(data, FLOW, ATTEMPT, "%63ontext.json", redactor.redact)).status, 400);
});

test("rejects oversized session content before redaction without returning a partial body", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "agent-flow-dashboard-oversize-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const attempt = join(data, "sessions", FLOW, ATTEMPT);
  await mkdir(attempt, { recursive: true });
  const secret = "secret-straddles-boundary";
  const redactor = createStartupRedactor();
  redactor.register(secret);

  await writeFile(join(attempt, "harness.log"), "x".repeat(1_048_576 - 8));
  await writeFile(join(attempt, "context.json"), JSON.stringify({ secret, filler: "x".repeat(1_048_576) }));

  for (const file of ["harness.log", "context.json"] as const) {
    let grew = false;
    const result = await readDashboardSessionFile(
      data, FLOW, ATTEMPT, file, redactor.redact, undefined, async (_fd, path) => {
        if (file === "harness.log" && !grew) {
          grew = true;
          await appendFile(path, secret);
        }
        return path;
      },
    );
    assert.deepEqual(result, {
      status: 413,
      body: { available: false, reason: "session file too large" },
    });
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal("content" in result.body, false);
  }
});

test("rejects a redacted JSON representation that grows beyond one MiB", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "agent-flow-dashboard-redacted-limit-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const attempt = join(data, "sessions", FLOW, ATTEMPT);
  await mkdir(attempt, { recursive: true });
  await writeFile(join(attempt, "decision.json"), JSON.stringify(Array.from({ length: 175_000 }, () => 0)));

  const result = await readDashboardSessionFile(
    data, FLOW, ATTEMPT, "decision.json", (value) => value, undefined, async (_fd, path) => path,
  );

  assert.deepEqual(result, {
    status: 413,
    body: { available: false, reason: "session file too large" },
  });
});

test("fails closed for symlinks, descriptor mismatches, and unavailable descriptor verification", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "agent-flow-dashboard-descriptor-"));
  const outside = await mkdtemp(join(tmpdir(), "agent-flow-dashboard-descriptor-outside-"));
  t.after(async () => {
    await rm(data, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const flow = join(data, "sessions", FLOW);
  const attempt = join(flow, ATTEMPT);
  await mkdir(attempt, { recursive: true });
  await writeFile(join(attempt, "context.json"), "{\"source\":\"inside\"}\n");
  await writeFile(join(outside, "context.json"), "{\"source\":\"outside\"}\n");
  await symlink(join(outside, "decision.json"), join(attempt, "decision.json"));
  const redact = (value: string) => value;

  assert.equal((await readDashboardSessionFile(data, FLOW, ATTEMPT, "decision.json", redact)).status, 404);
  assert.equal((await readDashboardSessionFile(
    data, FLOW, ATTEMPT, "context.json", redact, undefined,
    async () => realpath(join(outside, "context.json")),
  )).status, 404);
  assert.equal((await readDashboardSessionFile(
    data, FLOW, ATTEMPT, "context.json", redact, undefined,
    async () => { throw new Error("/proc unavailable"); },
  )).status, 404);

  const parked = join(flow, `${ATTEMPT}.parked`);
  const swapped = await readDashboardSessionFile(data, FLOW, ATTEMPT, "context.json", redact, async (path, flags) => {
    await rename(attempt, parked);
    await symlink(outside, attempt, "dir");
    const handle = await open(path, flags);
    await unlink(attempt);
    await rename(parked, attempt);
    return handle;
  });
  assert.equal(swapped.status, 404);
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
