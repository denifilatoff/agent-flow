import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadControllerId } from "../../src/runtime/identity.ts";
import { openLocalStore } from "../../src/runtime/local-store.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("publishes one stable controller UUID across concurrent initializers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-identity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const ids = await Promise.all(Array.from({ length: 16 }, () => loadControllerId(directory)));
  assert.equal(new Set(ids).size, 1);
  assert.match(ids[0]!, UUID);
});

test("rejects malformed and oversized existing identities", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-identity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identityPath = join(directory, "controller-id");

  await writeFile(identityPath, "invalid\n");
  await assert.rejects(loadControllerId(directory), /controller ID must be a canonical UUID/);
  await writeFile(identityPath, `${"a".repeat(4096)}\n`);
  await assert.rejects(loadControllerId(directory), /controller ID is too large/);
});

test("does not replace a failed identity target", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-identity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "controller-id"));

  await assert.rejects(loadControllerId(directory));
});

test("rejects a symlinked identity instead of reading outside the data directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "data");
  const outside = join(root, "outside-id");
  await mkdir(directory);
  await writeFile(outside, "11111111-1111-4111-8111-111111111111\n");
  await symlink(outside, join(directory, "controller-id"));

  await assert.rejects(loadControllerId(directory), /symbolic link/);
});

test("keeps the controller identity after the SQLite file is reset", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-identity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "execution.sqlite");
  const controllerId = await loadControllerId(directory);
  openLocalStore(databasePath).close();
  await rm(databasePath);
  openLocalStore(databasePath).close();

  assert.equal(await loadControllerId(directory), controllerId);
});
