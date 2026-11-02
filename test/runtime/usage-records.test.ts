import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { archiveReceipt } from "../../src/runtime/usage-records.ts";

test("archives immutable validated receipts separately for each attempt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "usage-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const value = { apiVersion: "agent-flow/v1alpha1" as const, kind: "AgentReceipt" as const,
    flowInstanceId: "11111111-1111-4111-8111-111111111111", attemptId: "22222222-2222-4222-8222-222222222222",
    outcome: "failed" as const, summary: "Failed.", artifacts: [], error: { code: "HARNESS_EXIT_FAILED", message: "Failed." },
    usage: { totalTokens: 12 } };
  await archiveReceipt(root, value);
  await archiveReceipt(root, value);
  assert.deepEqual(JSON.parse(await readFile(join(root, "receipt.json"), "utf8")), value);
  await assert.rejects(archiveReceipt(root, { ...value, usage: { totalTokens: 13 } }));
  await assert.rejects(archiveReceipt(root, { ...value, usage: { totalTokens: -1 } }));
});

test("refuses symlinked receipt files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "usage-symlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(join(root, "outside"), join(root, "receipt.json"));
  await assert.rejects(archiveReceipt(root, {} as never));
});
