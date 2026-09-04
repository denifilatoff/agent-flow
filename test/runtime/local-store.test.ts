import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateDocument } from "../../src/config/schema-validator.ts";
import type { ControlState, LocalExecution } from "../../src/config/types.ts";
import { openLocalStore, providerScope } from "../../src/runtime/local-store.ts";

const controllerId = "11111111-1111-4111-8111-111111111111";
const ref = { provider: "github" as const, repository: "owner/repository", number: 17 };
const scope = "github:https://github.example.test/api/v3";

function inactiveRecord(): LocalExecution {
  return {
    controllerId,
    observedAt: "2026-09-04T10:00:00Z",
    owner: null,
    disposition: "inactive",
    reason: null,
    publicationKeys: [],
    control: null,
  };
}

function control(sequence: number): ControlState {
  return {
    apiVersion: "agent-flow/v1alpha1",
    kind: "ControlState",
    flowInstanceId: "22222222-2222-4222-8222-222222222222",
    flowId: "development",
    configRevision: "a".repeat(40),
    sequence,
    stateId: "assessment",
    resumeStateId: null,
    activatedBy: { login: "maintainer", providerId: "1" },
    activatedAt: "2026-09-04T10:00:00Z",
    activationEventId: "activation-1",
    updatedAt: "2026-09-04T10:00:00Z",
    attemptSeries: null,
    latestReceipt: null,
    humanGate: null,
    changeRequest: null,
  };
}

test("persists a record and applies compare-and-swap revisions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-local-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "execution.sqlite");
  const store = openLocalStore(path);
  const record = inactiveRecord();

  assert.equal(store.save(scope, ref, null, record).revision, 0);
  assert.throws(() => store.save(scope, ref, null, record), /stale local execution write/);
  assert.equal(store.save(scope, ref, 0, record).revision, 1);
  assert.throws(() => store.save(scope, ref, 0, record), /stale local execution write/);
  store.close();

  const reopened = openLocalStore(path);
  assert.deepEqual(reopened.load(scope, ref), { revision: 1, value: record });
  assert.equal(reopened.load("github:https://github.example.test/api/v3-alt", ref), null);
  reopened.close();
});

test("canonicalizes credential-free provider scopes and keeps hosts separate", async (t) => {
  const canonical = providerScope("github", "HTTPS://GitHub.example.test:443/api/v3/");
  assert.equal(canonical, "github:https://github.example.test/api/v3");
  assert.equal(providerScope("github", "https://github.example.test/api/v3/./"), canonical);
  assert.notEqual(providerScope("github", "https://other.example.test/api/v3"), canonical);
  assert.throws(
    () => providerScope("github", "https://operator:secret@github.example.test/api/v3"),
    /credential-free/,
  );

  const directory = await mkdtemp(join(tmpdir(), "agent-flow-local-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = openLocalStore(join(directory, "execution.sqlite"));
  assert.equal(store.save(canonical, ref, null, inactiveRecord()).revision, 0);
  assert.equal(
    store.save(providerScope("github", "https://other.example.test/api/v3"), ref, null, inactiveRecord()).revision,
    0,
  );
  assert.throws(
    () => store.load("github:https://github.example.test/api/v3/", ref),
    /canonical provider/,
  );
  store.close();
});

test("rejects a provider scope that does not match the ticket provider", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-local-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = openLocalStore(join(directory, "execution.sqlite"));
  const gitlabScope = providerScope("gitlab", "https://gitlab.example.test/api/v4");

  assert.throws(
    () => store.save(gitlabScope, ref, null, inactiveRecord()),
    /provider scope does not match ticket provider/,
  );
  assert.throws(() => store.load(gitlabScope, ref), /provider scope does not match ticket provider/);
  store.close();
});

test("rejects invalid payloads without creating a row", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-local-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = openLocalStore(join(directory, "execution.sqlite"));
  const invalid = { ...inactiveRecord(), disposition: "running" } as unknown as LocalExecution;

  assert.throws(() => store.save(scope, ref, null, invalid), /LocalExecution validation failed/);
  assert.equal(store.load(scope, ref), null);
  store.close();
});

test("requires a control sequence equal to the saved revision", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-local-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = openLocalStore(join(directory, "execution.sqlite"));

  assert.throws(
    () => store.save(scope, ref, null, { ...inactiveRecord(), control: control(1) }),
    /control sequence must equal local revision/,
  );
  assert.equal(store.save(scope, ref, null, { ...inactiveRecord(), control: control(0) }).revision, 0);
  assert.equal(store.save(scope, ref, 0, { ...inactiveRecord(), control: control(1) }).revision, 1);
  store.close();
});

test("rejects corrupt payloads and unsupported schema versions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-local-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "execution.sqlite");
  const store = openLocalStore(path);
  store.save(scope, ref, null, inactiveRecord());
  store.close();

  const database = new DatabaseSync(path);
  database.exec("PRAGMA ignore_check_constraints = ON");
  database.prepare("UPDATE ticket_execution SET payload = ?").run("{bad json");
  database.close();
  const corrupt = openLocalStore(path);
  assert.throws(() => corrupt.load(scope, ref), /invalid local execution payload/);
  corrupt.close();

  const versionPath = join(directory, "unsupported.sqlite");
  const unsupported = new DatabaseSync(versionPath);
  unsupported.exec("PRAGMA user_version = 2");
  unsupported.close();
  assert.throws(() => openLocalStore(versionPath), /unsupported local store schema version: 2/);
});

test("refuses to overwrite a corrupt row during a compare-and-swap update", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-local-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "execution.sqlite");
  const store = openLocalStore(path);
  store.save(scope, ref, null, inactiveRecord());
  store.close();

  const database = new DatabaseSync(path);
  database.exec("PRAGMA ignore_check_constraints = ON");
  database.prepare("UPDATE ticket_execution SET payload = ?").run("{bad json");
  database.close();

  const corrupt = openLocalStore(path);
  assert.throws(() => corrupt.save(scope, ref, 0, inactiveRecord()), /invalid local execution payload/);
  corrupt.close();

  const preserved = new DatabaseSync(path);
  assert.equal(preserved.prepare("SELECT payload FROM ticket_execution").get().payload, "{bad json");
  preserved.close();
});

test("validates the LocalExecution data contract", () => {
  assert.deepEqual(validateDocument<LocalExecution>("LocalExecution", inactiveRecord()), inactiveRecord());
  assert.throws(
    () => validateDocument<LocalExecution>("LocalExecution", { ...inactiveRecord(), publicationKeys: [1] }),
    /LocalExecution validation failed/,
  );
});
