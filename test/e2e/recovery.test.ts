import assert from "node:assert/strict";
import test from "node:test";

import { startFixture } from "../fixtures/provider-server.ts";

test("a persisted started attempt resumes with its finite retry budget", async (t) => {
  const run = await startFixture("github", { firstAttempt: "block" });
  t.after(() => run.close());
  await run.untilAttempt("started");
  await run.restart();
  await run.untilState("assessment-review");
  assert.equal((await run.control()).attemptSeries?.consumed, 2);
});

test("a transient exit consumes budget and retries in a new session", async (t) => {
  const run = await startFixture("github", { firstAttempt: "exit-failure" });
  t.after(() => run.close());
  await run.untilState("assessment-review");
  assert.equal((await run.control()).attemptSeries?.consumed, 2);
  assert.equal((await run.sessions()).length, 2);
});

test("activation removal cancels a live process and ignores its late receipt", async (t) => {
  const run = await startFixture("github", { firstAttempt: "late" });
  t.after(() => run.close());
  await run.untilAttempt("started");
  await run.removeActivation();
  await run.reconcile();
  assert.equal((await run.control()).stateId, "cancelled");
  assert.equal((await run.control()).latestReceipt, null);
  assert.equal(await run.activeProcesses(), 0);
});

test("a changed review head invalidates the old result", async (t) => {
  const run = await startFixture("github");
  t.after(() => run.close());
  await passHumanGates(run);
  await run.untilState("awaiting-merge");
  const oldHead = (await run.changeRequest())!.headSha;
  await run.changeHead();
  await run.reconcile();
  await run.untilAttempt("succeeded");
  assert.notEqual((await run.changeRequest())!.headSha, oldHead);
  assert.equal((await run.control()).stateId, "review");
  const review = (await run.control()).latestReceipt?.artifacts.find((artifact) => artifact.kind === "review");
  assert.equal(review?.kind === "review" ? review.headSha : null, (await run.changeRequest())!.headSha);
});

test("a closed unmerged change asks for reopen or cancel", async (t) => {
  const run = await startFixture("gitlab");
  t.after(() => run.close());
  await passHumanGates(run);
  await run.untilState("awaiting-merge");
  await run.closeChangeRequest();
  await run.reconcile();
  await run.untilAttempt("succeeded");
  assert.equal((await run.control()).stateId, "needs-human");
  assert.equal((await run.control()).resumeStateId, "review");
  assert.match((await run.latestAgentComment())!.body, /reopen|cancel/i);
});

test("terminal reactivation creates a new flow instance", async (t) => {
  const run = await startFixture("github");
  t.after(() => run.close());
  await run.finish();
  const first = (await run.control()).flowInstanceId;
  await run.activate();
  await run.reconcile();
  assert.notEqual((await run.control()).flowInstanceId, first);
});

async function passHumanGates(run: Awaited<ReturnType<typeof startFixture>>): Promise<void> {
  await run.untilState("assessment-review");
  await run.answer("approved");
  await run.untilState("plan-review");
  await run.answer("approved");
}
