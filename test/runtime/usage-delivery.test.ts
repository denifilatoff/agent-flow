import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { archiveReceipt } from "../../src/runtime/usage-records.ts";
import { queueUsageDelivery, deliverUsageRecord, retryUsageDeliveries } from "../../src/runtime/usage-delivery.ts";
import type { AgentReceipt } from "../../src/config/types.ts";
import type { ProviderAdapter } from "../../src/provider/types.ts";

test("recovers uncertain edits from independent pending attempts after restart", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "usage-delivery-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const controller = "11111111-1111-4111-8111-111111111111";
  const flow = "22222222-2222-4222-8222-222222222222";
  const attempt = "33333333-3333-4333-8333-333333333333";
  const ref = { provider: "github" as const, repository: "owner/repo", number: 2 };
  const marker = `<!-- agent-flow:v1 {"config":"${"a".repeat(40)}","controller":"${controller}"} -->`;
  const receipt: AgentReceipt = { apiVersion: "agent-flow/v1alpha1", kind: "AgentReceipt", flowInstanceId: flow,
    attemptId: attempt, outcome: "succeeded", summary: "Done", usage: { totalTokens: 7 }, artifacts: [
      { kind: "comment", id: "4", url: "https://github.test/comment/4", marker, artifactKind: "plan" }] };
  const root = join(data, "sessions", flow, attempt);
  await mkdir(root, { recursive: true });
  await archiveReceipt(root, receipt);
  await queueUsageDelivery(root, ref, controller, receipt);
  let comment = { id: "4", url: "https://github.test/comment/4", body: `Plan.\n${marker}` };
  let edits = 0;
  const provider = { kind: "github", readComment: async () => comment,
    updateComment: async (_ref: unknown, _id: string, body: string) => {
      edits++; comment = { ...comment, body }; throw new Error("uncertain network write");
    } } as unknown as ProviderAdapter;
  await assert.rejects(deliverUsageRecord(root, ref, controller, flow, attempt, provider));
  await retryUsageDeliveries(data, ref, controller, flow, provider);
  await retryUsageDeliveries(data, ref, controller, flow, provider);
  assert.equal(edits, 1);
  assert.equal(comment.body.match(/Usage:/g)?.length, 1);
  await retryUsageDeliveries(data, ref, controller, flow, provider, () => false);
  assert.equal(edits, 1);
});
