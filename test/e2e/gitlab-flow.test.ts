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
  assert.equal((await run.sessions()).length, 6);
  assert.equal(await run.maximumConcurrentAttempts(), 1);
});
