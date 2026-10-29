import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigBundle, validateBundleDocument } from "../../src/config/load.ts";
import { validateDocument } from "../../src/config/schema-validator.ts";

const receipt = {
  apiVersion: "agent-flow/v1alpha1", kind: "AgentReceipt",
  flowInstanceId: "11111111-1111-4111-8111-111111111111",
  attemptId: "22222222-2222-4222-8222-222222222222",
  outcome: "succeeded", summary: "Completed.", artifacts: [],
};

test("accepts legacy receipts and optional complete or partial usage", () => {
  for (const usage of [undefined, { totalTokens: 0, costUsd: 0, costSource: "harness" },
    { inputTokens: 12 }, { totalTokens: 123, model: "example", costUsd: 0.1, costSource: "estimated" }]) {
    const value = { ...receipt, ...(usage ? { usage } : {}) };
    assert.deepEqual(validateDocument("AgentReceipt", value), value);
  }
});

test("rejects invalid usage, unsafe counts and unpaired cost", () => {
  for (const usage of [{ totalTokens: -1 }, { inputTokens: 1.5 }, { outputTokens: 2 ** 53 },
    { costUsd: Infinity, costSource: "harness" }, { costUsd: -1, costSource: "harness" },
    { costUsd: 0 }, { costSource: "estimated" }, { extra: 1 }]) {
    assert.throws(() => validateDocument("AgentReceipt", { ...receipt, usage }));
  }
});

test("validates the usage extension independently of an older pinned receipt schema", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "usage-old-pin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["config", "schemas"]) await cp(directory, join(root, directory), { recursive: true });
  const path = join(root, "schemas/v1/agent-receipt.schema.json");
  const schema = JSON.parse(await readFile(path, "utf8"));
  delete schema.properties.usage;
  await writeFile(path, JSON.stringify(schema));
  const bundle = await loadConfigBundle(root, "config/stack.yaml", "0".repeat(40));
  const value = { ...receipt, usage: { totalTokens: 4 } };
  assert.deepEqual(validateBundleDocument(bundle, "AgentReceipt", value), value);
  assert.throws(() => validateBundleDocument(bundle, "AgentReceipt", { ...value, extra: 1 }));
  assert.throws(() => validateBundleDocument(bundle, "AgentReceipt", { ...value, usage: { totalTokens: -1 } }));
});
