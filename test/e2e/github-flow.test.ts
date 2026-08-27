import assert from "node:assert/strict";
import test from "node:test";

import type { AgentReceipt, ReceiptArtifact } from "../../src/config/types.ts";
import { startFixture } from "../fixtures/provider-server.ts";

test("GitHub activation reaches done through both human gates", async (t) => {
  const run = await startFixture("github");
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
  assert.deepEqual(receipts.map((receipt) => ({
    outcome: receipt.outcome,
    summary: receipt.summary,
    artifacts: receipt.artifacts.map(normalizeArtifact),
    humanGate: receipt.humanGate && { verdict: receipt.humanGate.verdict, notes: receipt.humanGate.notes },
  })), [
    { outcome: "succeeded", summary: "Agent completed the stage.", artifacts: [{ kind: "comment", artifactKind: "assessment" }], humanGate: undefined },
    { outcome: "succeeded", summary: "Human approved the result.", artifacts: [], humanGate: { verdict: "approved", notes: [] } },
    { outcome: "succeeded", summary: "Agent completed the stage.", artifacts: [{ kind: "comment", artifactKind: "plan" }], humanGate: undefined },
    { outcome: "succeeded", summary: "Human approved the result.", artifacts: [], humanGate: { verdict: "approved", notes: [] } },
    { outcome: "succeeded", summary: "Agent completed the stage.", artifacts: [{ kind: "change-request", number: 31, headSha: "0123456789abcdef0123456789abcdef01234567", state: "open" }], humanGate: undefined },
    { outcome: "succeeded", summary: "Review approved the change.", artifacts: [{ kind: "review", headSha: "0123456789abcdef0123456789abcdef01234567", verdict: "approved" }], humanGate: undefined },
  ]);
  assert.equal(new Set(receipts.map(({ flowInstanceId }) => flowInstanceId)).size, 1);
  assert.equal(new Set(receipts.map(({ attemptId }) => attemptId)).size, 6);
  assert.deepEqual(
    receipts.map(({ flowInstanceId, attemptId }) => `${flowInstanceId}/${attemptId}`).toSorted(),
    (await run.sessions()).toSorted(),
  );

  const [assessment, assessmentGate, plan, planGate, development, review] = receipts;
  assertCommentReceipt(assessment!, "assessment", "#issuecomment-");
  assertCommentReceipt(plan!, "plan", "#issuecomment-");
  const change = development!.artifacts[0]!;
  const nativeReview = review!.artifacts[0]!;
  assert.equal(change.kind, "change-request");
  assert.equal(nativeReview.kind, "review");
  assert.equal(nativeReview.kind === "review" && change.kind === "change-request" && nativeReview.headSha, change.headSha);
  assert.match(change.url, /\/pull\/31$/);
  assert.match(nativeReview.url, new RegExp(`#pullrequestreview-${nativeReview.kind === "review" ? nativeReview.id : ""}$`));
  assert.deepEqual(await run.reviewRequests(), [
    "repos/owner/repo/pulls/31/reviews?per_page=100",
    "repos/owner/repo/pulls/31/reviews?per_page=100&page=2",
    `repos/owner/repo/pulls/31/reviews/${nativeReview.kind === "review" ? nativeReview.id : ""}`,
  ]);
  const humanAnswers = await run.humanAnswers();
  assert.deepEqual(
    [assessmentGate!.humanGate?.sourceCommentId, planGate!.humanGate?.sourceCommentId],
    humanAnswers.map(({ id }) => id),
  );
  assert.ok(humanAnswers.every(({ body, actor }) => body === "approved" && actor.providerId === "7"));
  assert.equal(await run.maximumConcurrentAttempts(), 1);
  assert.deepEqual(await run.routing(), [
    { agentId: "architect", target: "claude" },
    { agentId: "architect", target: "claude" },
    { agentId: "planner", target: "claude" },
    { agentId: "planner", target: "claude" },
    { agentId: "developer", target: "codex" },
    { agentId: "reviewer", target: "codex" },
  ]);
  assert.deepEqual(await run.compilations(), [
    { agentId: "architect", target: "claude" },
    { agentId: "architect", target: "claude" },
    { agentId: "planner", target: "claude" },
    { agentId: "planner", target: "claude" },
    { agentId: "developer", target: "codex" },
    { agentId: "reviewer", target: "codex" },
  ]);
});

function normalizeArtifact(artifact: ReceiptArtifact | undefined) {
  if (!artifact) return null;
  if (artifact.kind === "comment") return { kind: artifact.kind, artifactKind: artifact.artifactKind };
  if (artifact.kind === "change-request") {
    return { kind: artifact.kind, number: artifact.number, headSha: artifact.headSha, state: artifact.state };
  }
  return { kind: artifact.kind, headSha: artifact.headSha, verdict: artifact.verdict };
}

function assertCommentReceipt(
  receipt: AgentReceipt,
  artifactKind: "assessment" | "plan",
  urlFragment: string,
): void {
  const artifact = receipt.artifacts[0];
  assert.equal(artifact?.kind, "comment");
  if (artifact?.kind !== "comment") return;
  assert.equal(
    artifact.marker,
    `<!-- agent-flow:v1 flow=${receipt.flowInstanceId} attempt=${receipt.attemptId} artifact=${artifactKind} -->`,
  );
  assert.ok(artifact.url.endsWith(`${urlFragment}${artifact.id}`));
}
