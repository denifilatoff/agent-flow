import assert from "node:assert/strict";
import test from "node:test";

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
  assert.equal((await run.sessions()).length, 6);
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
