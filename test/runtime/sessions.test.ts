import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  createAttemptSession,
  type AttemptContext,
} from "../../src/runtime/sessions.ts";

const FLOW = "11111111-1111-4111-8111-111111111111";
const ATTEMPT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTEXT: AttemptContext = {
  ticket: {
    ref: { provider: "github", repository: "owner/repo", number: 17 },
    title: "Fix the edge case",
    description: "Handle the documented edge case.",
    repository: {
      provider: "github",
      name: "owner/repo",
      host: "github.example.test",
      cloneRoot: "https://github.example.test/",
      cloneUrl: "https://github.example.test/owner/repo.git",
    },
    open: true,
    labels: ["agent-flow:development", "agent-stage:assessment"],
    updatedAt: "2026-08-26T00:00:00.000Z",
    activation: {
      present: true,
      label: "agent-flow:development",
      eventId: "1",
      actor: { login: "maintainer", providerId: "41" },
      occurredAt: "2026-08-26T00:00:00.000Z",
    },
    comments: [],
    changeRequest: null,
  },
  controlState: {
    apiVersion: "agent-flow/v1alpha1",
    kind: "ControlState",
    flowInstanceId: FLOW,
    flowId: "development",
    configRevision: "0123456789abcdef0123456789abcdef01234567",
    sequence: 1,
    stateId: "assessment",
    resumeStateId: null,
    activatedBy: { login: "maintainer", providerId: "41" },
    activatedAt: "2026-08-26T00:00:00.000Z",
    activationEventId: "event-803",
    updatedAt: "2026-08-26T00:00:00.000Z",
    attemptSeries: null,
    latestReceipt: null,
    humanGate: null,
    changeRequest: null,
  },
  artifacts: [],
  mode: "stage",
};

async function relativeFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .map((entry) => `${relative(root, join(root, entry.name))}${entry.isDirectory() ? "/" : ""}`)
    .sort();
}

test("creates the immutable attempt file layout", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "agent-flow-sessions-"));
  t.after(() => rm(data, { recursive: true, force: true }));

  const session = await createAttemptSession(data, FLOW, ATTEMPT, CONTEXT);

  assert.deepEqual(await relativeFiles(session.root), [
    "context.json",
    "decision.json",
    "harness-session/",
    "harness.log",
  ]);
  assert.deepEqual(JSON.parse(await readFile(session.contextPath, "utf8")), CONTEXT);
  assert.equal(await readFile(session.decisionPath, "utf8"), "");
  assert.equal(await readFile(session.logPath, "utf8"), "");
  assert.equal((await stat(session.root)).mode & 0o777, 0o700);
  assert.equal((await stat(session.decisionPath)).mode & 0o777, 0o600);
});

test("refuses to reuse an attempt directory", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "agent-flow-sessions-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  await createAttemptSession(data, FLOW, ATTEMPT, CONTEXT);

  await assert.rejects(
    createAttemptSession(data, FLOW, ATTEMPT, CONTEXT),
    /attempt session already exists/,
  );
});

test("rejects noncanonical UUID path identities", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "agent-flow-sessions-"));
  t.after(() => rm(data, { recursive: true, force: true }));

  await assert.rejects(
    createAttemptSession(data, "../escape", ATTEMPT, CONTEXT),
    /flow instance ID must be a canonical UUID/,
  );
  await assert.rejects(
    createAttemptSession(data, FLOW, ATTEMPT.toUpperCase(), CONTEXT),
    /attempt ID must be a canonical UUID/,
  );
  await assert.rejects(
    createAttemptSession(data, FLOW, "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa", CONTEXT),
    /attempt ID must be a canonical UUID/,
  );
});

test("rejects a symlinked sessions root without writing outside data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-sessions-symlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "data");
  const outside = join(root, "outside");
  await mkdir(data);
  await mkdir(outside);
  await symlink(outside, join(data, "sessions"), "dir");

  await assert.rejects(
    createAttemptSession(data, FLOW, ATTEMPT, CONTEXT),
    /symbolic link/,
  );
  assert.deepEqual(await readdir(outside), []);
});

test("publishes context.json atomically", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "agent-flow-sessions-atomic-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const size = 32 * 1024 * 1024;
  const contextPath = join(data, "sessions", FLOW, ATTEMPT, "context.json");
  const moduleUrl = new URL("../../src/runtime/sessions.ts", import.meta.url).href;
  const script = [
    `import { createAttemptSession } from ${JSON.stringify(moduleUrl)};`,
    `await createAttemptSession(${JSON.stringify(data)}, ${JSON.stringify(FLOW)},`,
    `${JSON.stringify(ATTEMPT)}, { payload: "x".repeat(${size}) });`,
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk) => { stderr += chunk; });

  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await stat(contextPath);
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (Date.now() >= deadline) throw new Error(`context.json was not published: ${stderr}`);
    await delay(1);
  }
  child.kill("SIGKILL");
  await exited;

  const published = await readFile(contextPath, "utf8");
  assert.equal(published.length, JSON.stringify({ payload: "x".repeat(size) }, null, 2).length + 1);
  assert.doesNotThrow(() => JSON.parse(published));
});

test("removes the temporary context file after a serialization error", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "agent-flow-sessions-error-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const context = { ...CONTEXT } as AttemptContext & { cycle?: unknown };
  context.cycle = context;

  await assert.rejects(createAttemptSession(data, FLOW, ATTEMPT, context), /circular/i);

  const root = join(data, "sessions", FLOW, ATTEMPT);
  assert.deepEqual(await readdir(root), []);
});
