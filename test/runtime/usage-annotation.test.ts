import assert from "node:assert/strict";
import test from "node:test";
import { usageLine } from "../../src/runtime/usage-annotation.ts";
import type { AgentReceipt } from "../../src/config/types.ts";
import type { ProviderAdapter, ProviderComment } from "../../src/provider/types.ts";

const marker = '<!-- agent-flow:v1 {"config":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","controller":"11111111-1111-4111-8111-111111111111"} -->';
const ref = { provider: "github" as const, repository: "owner/repo", number: 2 };
const receipt: AgentReceipt = { apiVersion: "agent-flow/v1alpha1", kind: "AgentReceipt",
  flowInstanceId: "22222222-2222-4222-8222-222222222222", attemptId: "33333333-3333-4333-8333-333333333333",
  outcome: "succeeded", summary: "Done", artifacts: [{ kind: "comment", id: "4",
    url: "https://github.test/owner/repo/issues/2#issuecomment-4", marker, artifactKind: "plan" }],
  usage: { totalTokens: 53796, costUsd: 0.42, costSource: "estimated" } };

test("renders known totals, estimates, zero, native and cost-only usage", () => {
  assert.equal(usageLine(receipt.usage), "Usage: 53,796 tokens · $0.42 estimated");
  assert.equal(usageLine({ totalTokens: 0 }), "Usage: 0 tokens");
  assert.equal(usageLine({ costUsd: 0, costSource: "harness" }), "Usage: $0.00 harness estimate");
  assert.equal(usageLine({ inputTokens: 3 }), null);
});
