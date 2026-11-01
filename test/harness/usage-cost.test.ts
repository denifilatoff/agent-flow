import assert from "node:assert/strict";
import test from "node:test";
import { resolveUsageCost } from "../../src/harness/usage-cost.ts";

const model = {
  model: "claude-haiku-4-5-20251001", inputTokens: 1000000, outputTokens: 1000000,
  cacheReadInputTokens: 1000000, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0,
  tier: "standard", geography: "global", contextWindow: 200000,
};
test("prefers harness cost including valid zero", () => {
  for (const costUsd of [0, 42]) assert.deepEqual(resolveUsageCost({ costUsd, costSource: "harness" }, [model]),
    { costUsd, costSource: "harness" });
});
test("estimates only a fully priced single or mixed model attempt", () => {
  assert.deepEqual(resolveUsageCost({ totalTokens: 3000000 }, [model]),
    { totalTokens: 3000000, costUsd: 6.1, costSource: "estimated" });
  const mixed = resolveUsageCost({}, [model, { ...model, model: "claude-sonnet-4-6" }]);
  assert.equal(mixed.costUsd, 24.4);
  assert.equal(mixed.costSource, "estimated");
});
test("omits unreliable prices rather than guessing or partially pricing", () => {
  for (const partial of [{ model: "haiku" }, { model: "unknown" }, { tier: "unknown" },
    { geography: "unknown" }, { contextWindow: 1000000 }, { cacheReadInputTokens: undefined }]) {
    assert.deepEqual(resolveUsageCost({ inputTokens: 1 }, [model, { ...model, ...partial }]), { inputTokens: 1 });
  }
});
