import assert from "node:assert/strict";
import test from "node:test";
import { startFixture } from "../fixtures/provider-server.ts";

for (const provider of ["github", "gitlab"] as const) {
  for (const policy of ["conservative", "autonomous"] as const) {
    for (const scenario of ["feature", "bugfix"] as const) {
      test(`${provider} ${policy} ${scenario} documents each implementation and rework on one request`, async (t) => {
        const run = await startFixture(provider, { policy, scenario, documentationEdits: scenario === "bugfix", reviewRework: true });
        t.after(() => run.close());
        const prefix = scenario === "bugfix" ? "bug-" : "";
        if (policy === "conservative") {
          await run.untilState(scenario === "bugfix" ? "bug-reproduction-review" : "assessment-review");
          await run.answer("approved");
          if (scenario === "feature") {
            await run.untilState("plan-review");
            await run.answer("approved");
          }
        }
        await run.untilState(`${prefix}awaiting-merge`);
        const receipts = await run.receipts();
        const documentation = receipts.filter((r) => r.artifacts.some((a) => a.kind === "comment" && a.artifactKind === "documentation"));
        assert.equal(documentation.length, 2);
        const changes = documentation.flatMap((r) => r.artifacts.filter((a) => a.kind === "change-request"));
        assert.equal(new Set(changes.map((a) => a.number)).size, 1);
        assert.notEqual(changes[0]!.headSha, changes[1]!.headSha);
        const reviews = receipts.flatMap((r) => r.artifacts.filter((a) => a.kind === "review"));
        assert.deepEqual(reviews.map((r) => r.verdict), ["changes-requested", "approved"]);
        assert.deepEqual(reviews.map((r) => r.headSha), changes.map((c) => c.headSha));
        if (scenario === "bugfix") assert.ok(receipts.some((r) => r.artifacts.some((a) => a.kind === "comment" && a.artifactKind === "diagnostic")));
        assert.equal((await run.changeRequest())!.headSha, changes[1]!.headSha);
        await run.mergeChangeRequest();
        await run.untilState("done");
      });
    }
  }

  test(`${provider} reuses a documentation report after publication-before-transition and local-state loss`, async (t) => {
    const run = await startFixture(provider, { documentationAttempt: "crash-after-publish" });
    t.after(() => run.close());
    await run.untilState("assessment-review"); await run.answer("approved");
    await run.untilState("plan-review"); await run.answer("approved");
    await run.untilState("documentation");
    await run.untilAgentComments(3);
    const report = await run.latestAgentComment();
    assert.match(report!.body, /agent-flow-documentation:v1/);
    await run.resetDatabaseAndRestart();
    await run.untilState("awaiting-merge");
    assert.deepEqual((await run.agentCommentIds()).filter((id) => id === report!.id), [report!.id]);
    assert.equal((await run.agentCommentIds()).length, 3);
  });
}

test("legacy pinned feature flow retains direct implementation-to-review routing", async (t) => {
  const run = await startFixture("github", { legacyFlow: true });
  t.after(() => run.close());
  await run.untilState("assessment-review"); await run.answer("approved");
  await run.untilState("plan-review"); await run.answer("approved");
  await run.untilState("awaiting-merge");
  assert.equal((await run.routing()).some((r) => r.agentId === "documentarian"), false);
});

for (const provider of ["github", "gitlab"] as const) {
  test(`${provider} resumes documentation after push-before-report without another commit`, async (t) => {
    const run = await startFixture(provider, { documentationAttempt: "crash-after-push", documentationEdits: true });
    t.after(() => run.close());
    await run.untilState("assessment-review"); await run.answer("approved");
    await run.untilState("plan-review"); await run.answer("approved");
    await run.untilState("documentation");
    const original = (await run.control()).changeRequest!.headSha;
    const deadline = Date.now() + 5_000;
    while ((await run.changeRequest())!.headSha === original && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const pushed = (await run.changeRequest())!.headSha;
    assert.notEqual(pushed, original);
    assert.equal((await run.agentCommentIds()).length, 2);
    await run.restart();
    await run.untilState("awaiting-merge");
    assert.equal((await run.changeRequest())!.headSha, pushed);
    const docs = (await run.receipts()).find((r) => r.artifacts.some((a) => a.kind === "comment" && a.artifactKind === "documentation"));
    assert.equal(docs!.artifacts[0]!.kind === "comment" && docs!.artifacts[0]!.inputHead, original);
    assert.equal((await run.agentCommentIds()).length, 3);
  });
}

test("documentation asks about a closed request and resumes the same stage after reopening", async (t) => {
  const run = await startFixture("github");
  t.after(() => run.close());
  await run.blockNextAttempt("documentation");
  await run.untilState("assessment-review"); await run.answer("approved");
  await run.untilState("plan-review"); await run.answer("approved");
  await run.untilState("documentation"); await run.untilAttempt("started");
  await run.closeChangeRequest(); await run.restart();
  await run.untilState("needs-human");
  assert.equal((await run.control()).resumeStateId, "documentation");
  assert.match((await run.latestAgentComment())!.body, /Reopen the existing change request/);
  await run.reopenChangeRequest(); await run.answer("Reopen the same request and continue.");
  await run.untilState("awaiting-merge");
  assert.equal((await run.changeRequest())!.number, 31);
  assert.equal((await run.receipts()).filter((r) => r.artifacts.some((a) => a.kind === "comment" && a.artifactKind === "documentation")).length, 1);
});
