import assert from "node:assert/strict";
import { readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { getCACertificates } from "node:tls";
import test from "node:test";

import { startFixture } from "../fixtures/provider-server.ts";

test("persisted started attempts repeatedly resume with their finite retry budget", async () => {
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const run = await startFixture("github", { firstAttempt: "block" });
    try {
      await run.untilAttempt("started");
      await run.restart();
      await run.untilState("assessment-review");
      assert.equal((await run.control()).attemptSeries?.consumed, 2);
      assert.equal(await run.activeProcesses(), 0);
      assert.equal(await run.maximumConcurrentAttempts(), 1);
    } finally {
      await run.close();
    }
  }
});

test("a transient exit consumes budget and retries in a new session", async (t) => {
  const run = await startFixture("github", { firstAttempt: "exit-failure" });
  t.after(() => run.close());
  await run.untilState("assessment-review");
  assert.equal((await run.control()).attemptSeries?.consumed, 2);
  assert.equal((await run.sessions()).length, 2);
  assert.equal(await run.activeProcesses(), 0);
  assert.equal(await run.maximumConcurrentAttempts(), 1);
});

test("C3/C20 reset keeps identity and reuses a publication from the pre-label crash window", async (t) => {
  const run = await startFixture("github", { firstAttempt: "crash-after-publish" });
  t.after(() => run.close());
  const controllerId = await run.controllerId();
  await run.untilAgentComments(1);
  const published = await run.latestAgentComment();

  await run.resetDatabaseAndRestart();
  await run.untilState("assessment-review");

  assert.equal(await run.controllerId(), controllerId);
  assert.equal((await run.latestAgentComment())?.id, published?.id);
  assert.equal((await run.control()).stateId, "assessment-review");
});

test("C18/C19 concurrent controllers elect the same first publication without a second ownership read", async (t) => {
  const run = await startFixture("github", { firstAttempt: "race" });
  t.after(() => run.close());

  const result = await run.collide();

  assert.ok(result.ownerSeenByA);
  assert.equal(result.ownerSeenByA, result.ownerSeenByB);
  assert.equal(result.loserDisposition, "foreign");
  assert.equal(result.loserCancelled, true);
  assert.equal(result.loserWritesAfterObservation, 0);
  assert.equal(result.duplicateCommentsDeleted, 0);
  assert.equal(result.extraOwnershipReadsBeforePublication, 0);
  assert.ok(result.requestLog.some(({ method, path, phase }) =>
    method === "GET" && path.endsWith("/issues/17") && phase === "initial"));
  assert.equal(result.requestLog.filter(({ method }) => method === "PUBLISH").length, 2);
  assert.ok(result.requestLog.some(({ phase }) => phase === "reconcile-a"));
  assert.ok(result.requestLog.some(({ phase }) => phase === "reconcile-b"));
});

test("activation removal repeatedly cancels a ready process and ignores its late decision", async () => {
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const run = await startFixture("github", { firstAttempt: "late" });
    try {
      await run.untilAttempt("started");
      assert.equal(await run.latestAgentComment(), null);
      assert.deepEqual(await run.receipts(), []);
      await run.removeActivation();
      await run.reconcile();
      const control = await run.control();
      assert.deepEqual(await run.decisions(), [{ event: "agent-succeeded" }]);
      assert.deepEqual(await run.receipts(), []);
      assert.match((await run.latestAgentComment())!.body, /Fixture assessment\./);
      assert.equal(control.stateId, "cancelled");
      assert.equal(control.latestReceipt, null);
      assert.equal(control.changeRequest, null);
      assert.equal(control.humanGate, null);
      assert.equal(control.attemptSeries?.current?.status, "cancelled");
      assert.equal(await run.activeProcesses(), 0);
      assert.equal(await run.maximumConcurrentAttempts(), 1);
    } finally {
      await run.close();
    }
  }
});

test("C9/C17 a changed review head invalidates the old result", async (t) => {
  const run = await startFixture("github");
  t.after(() => run.close());
  await passHumanGates(run);
  await run.untilState("awaiting-merge");
  const oldHead = (await run.changeRequest())!.headSha;
  await run.changeHead();
  await run.reconcile();
  await run.untilState("awaiting-merge");
  assert.notEqual((await run.changeRequest())!.headSha, oldHead);
  assert.equal((await run.control()).stateId, "awaiting-merge");
  const review = (await run.control()).latestReceipt?.artifacts.find((artifact) => artifact.kind === "review");
  assert.equal(review?.kind === "review" ? review.headSha : null, (await run.changeRequest())!.headSha);
});

test("C10 a closed unmerged change asks for reopen or cancel", async (t) => {
  const run = await startFixture("gitlab");
  t.after(() => run.close());
  await passHumanGates(run);
  await run.untilState("awaiting-merge");
  await run.closeChangeRequest();
  await run.reconcile();
  await run.untilReceipt("needs-human");
  assert.equal((await run.control()).stateId, "needs-human");
  assert.equal((await run.control()).resumeStateId, "review");
  assert.match((await run.latestAgentComment())!.body, /reopen|cancel/i);
});

test("C11 terminal reactivation creates a new flow instance", async (t) => {
  const run = await startFixture("github");
  t.after(() => run.close());
  await run.finish();
  const oldLatestComment = await run.latestAgentComment();
  const previous = await run.control();
  const first = previous.flowInstanceId;
  await run.blockNextAttempt("assessment");
  await run.reactivateAfterStop();
  const current = await run.control();
  assert.equal((await run.latestAgentComment())?.id, oldLatestComment?.id);
  assert.equal(current.stateId, "assessment");
  assert.equal(current.flowId, "development");
  assert.ok(current.sequence > previous.sequence);
  assert.notEqual(current.flowInstanceId, first);
  assert.notEqual(current.activationEventId, previous.activationEventId);
  assert.equal(current.resumeStateId, null);
  assert.equal(current.latestReceipt, null);
  assert.equal(current.humanGate, null);
  assert.equal(current.changeRequest, null);
  assert.deepEqual(current.attemptSeries && {
    agentId: current.attemptSeries.agentId,
    stateId: current.attemptSeries.stateId,
    maxAttempts: current.attemptSeries.maxAttempts,
    consumed: current.attemptSeries.consumed,
    status: current.attemptSeries.current?.status,
    finishedAt: current.attemptSeries.current?.finishedAt,
    error: current.attemptSeries.current?.error,
  }, {
    agentId: "architect",
    stateId: "assessment",
    maxAttempts: 3,
    consumed: 1,
    status: "started",
    finishedAt: undefined,
    error: undefined,
  });
  assert.deepEqual(await run.controllerLabels(), [
    "agent-flow:development",
    "agent-flow:managed",
    "agent-stage:assessment",
  ]);
});

test("a startup failure restores global trust, environment, and temporary files", async () => {
  const before = {
    certificates: canonicalCertificates(),
    path: process.env.PATH,
    extraCertificates: process.env.NODE_EXTRA_CA_CERTS,
    roots: await fixtureRoots(),
  };
  await assert.rejects(startFixture("github", { forceStartupFailure: true }), /forced fixture startup failure/);
  assert.deepEqual(canonicalCertificates(), before.certificates);
  assert.equal(process.env.PATH, before.path);
  assert.equal(process.env.NODE_EXTRA_CA_CERTS, before.extraCertificates);
  assert.deepEqual(await fixtureRoots(), before.roots);

  const run = await startFixture("github");
  await run.close();
});

async function passHumanGates(run: Awaited<ReturnType<typeof startFixture>>): Promise<void> {
  await run.untilState("assessment-review");
  await run.answer("approved");
  await run.untilState("plan-review");
  await run.answer("approved");
}

async function fixtureRoots(): Promise<string[]> {
  return (await readdir(await realpath(tmpdir())))
    .filter((name) => name.startsWith("agent-flow-e2e-"))
    .sort();
}

function canonicalCertificates(): string[] {
  return getCACertificates("default")
    .map((certificate) => certificate.replace(/-----[^-]+-----|\s/g, ""))
    .sort();
}


test("C2 reset reassesses a published result and returns to its gate without duplicating it", async (t) => {
  const run = await startFixture("github");
  t.after(() => run.close());
  await run.untilState("assessment-review");
  const publications = await run.agentCommentIds();
  assert.equal(publications.length, 1);
  await run.resetDatabaseAndRestart();
  await run.untilState("assessment-review");
  assert.deepEqual(await run.agentCommentIds(), publications);
  assert.equal(await run.controllerCommentWrites(), 0);
  assert.equal((await run.control()).latestReceipt?.artifacts[0]?.kind, "comment");
  await run.answer("approved");
  await run.untilState("plan-review");
});

test("warm SQLite restart reuses the result published before its receipt was committed", async (t) => {
  const run = await startFixture("github", { firstAttempt: "crash-after-publish" });
  t.after(() => run.close());
  await run.untilAgentComments(1);
  const publications = await run.agentCommentIds();
  await run.restart();
  await run.untilState("assessment-review");
  assert.deepEqual(await run.agentCommentIds(), publications);
  assert.equal((await run.control()).attemptSeries?.consumed, 2);
  assert.equal(await run.controllerCommentWrites(), 0);
});
