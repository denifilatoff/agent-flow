import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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
    repository: {
      provider: "github",
      name: "owner/repo",
      host: "github.example.test",
      cloneUrl: "https://github.example.test/owner/repo.git",
    },
    open: true,
    labels: ["agent-flow:development", "agent-stage:assessment"],
    updatedAt: "2026-08-26T00:00:00.000Z",
    activation: {
      present: true,
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
    "harness-session/",
    "harness.log",
    "receipt.json",
  ]);
  assert.deepEqual(JSON.parse(await readFile(session.contextPath, "utf8")), CONTEXT);
  assert.equal(await readFile(session.receiptPath, "utf8"), "");
  assert.equal(await readFile(session.logPath, "utf8"), "");
  assert.equal((await stat(session.root)).mode & 0o777, 0o700);
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

test("rejects non-UUID path identities", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "agent-flow-sessions-"));
  t.after(() => rm(data, { recursive: true, force: true }));

  await assert.rejects(
    createAttemptSession(data, "../escape", ATTEMPT, CONTEXT),
    /flow instance ID must be a UUID/,
  );
});
