import assert from "node:assert/strict";
import test from "node:test";

import { startFixture } from "../fixtures/provider-server.ts";

test("GitLab activation reaches done through both human gates", async (t) => {
  const run = await startFixture("gitlab");
  t.after(() => run.close());
  assert.equal(await run.unauthenticatedProviderStatus(), 400);

  await run.untilState("assessment-review");
  await run.answer("approved");
  await run.untilState("plan-review");
  await run.answer("approved");
  await run.untilState("awaiting-merge");
  await run.mergeChangeRequest();
  await run.untilState("done");

  assert.deepEqual(await run.controllerLabels(), ["agent-flow:managed", "agent-stage:done"]);
  const decisions = await run.decisions();
  assert.equal(decisions.length, 6);
  assert.deepEqual(decisions.map(({ event }) => event).toSorted(), [
    "agent-succeeded",
    "agent-succeeded",
    "agent-succeeded",
    "human-approved",
    "human-approved",
    "review-approved",
  ]);
  for (const decision of decisions) assert.deepEqual(Object.keys(decision), ["event"]);

  const receipts = await run.receipts();
  assert.equal(receipts.length, 6);
  assert.ok(receipts.every((receipt) =>
    receipt.flowInstanceId && receipt.attemptId && receipt.summary
    && (receipt.artifacts.length > 0 || receipt.humanGate)));
  assert.ok(receipts.some((receipt) => receipt.artifacts.some((artifact) =>
    artifact.kind === "comment" && artifact.id && artifact.url && artifact.marker)));
  assert.ok(receipts.some((receipt) => receipt.artifacts.some((artifact) =>
    artifact.kind === "change-request" && artifact.number && artifact.url && artifact.headSha)));
  assert.ok(receipts.some((receipt) => receipt.artifacts.some((artifact) =>
    artifact.kind === "review" && artifact.id && artifact.url && artifact.headSha)));
  assert.equal((await run.sessions()).length, 6);
  assert.equal(await run.maximumConcurrentAttempts(), 1);
});
