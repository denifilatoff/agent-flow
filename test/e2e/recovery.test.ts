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

test("activation removal repeatedly cancels a ready process and ignores its late receipt", async () => {
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const run = await startFixture("github", { firstAttempt: "late" });
    try {
      await run.untilAttempt("started");
      assert.equal(await run.latestAgentComment(), null);
      assert.deepEqual(await run.receipts(), []);
      await run.removeActivation();
      await run.reconcile();
      const control = await run.control();
      const [receipt] = await run.receipts();
      assert.equal(receipt?.outcome, "succeeded");
      assert.equal(receipt?.artifacts[0]?.kind, "comment");
      assert.match((await run.latestAgentComment())!.body, /artifact=assessment/);
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
  const [oldComment] = await run.controlComments();
  const first = (await run.control()).flowInstanceId;
  await run.blockNextAttempt("assessment");
  await run.activate();
  await run.reconcile();
  const comments = await run.controlComments();
  const states = await run.controlStates();
  const current = await run.control();
  assert.equal(comments.length, 2);
  assert.equal(comments[0]!.body, oldComment!.body);
  assert.equal(states[0]!.flowInstanceId, first);
  assert.equal(current.stateId, "assessment");
  assert.equal(current.flowId, "development");
  assert.equal(current.sequence, 1);
  assert.notEqual(current.flowInstanceId, first);
  assert.notEqual(current.activationEventId, states[0]!.activationEventId);
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
