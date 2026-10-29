import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ControlState } from "../src/config/types.ts";
import { advanceControlState } from "../src/provider/control-comment.ts";
import type { TicketRef } from "../src/provider/types.ts";
import { createControlWriter } from "../src/runtime/control-state.ts";
import { openLocalStore, providerScope } from "../src/runtime/local-store.ts";

const NOW = "2026-08-26T12:00:00.000Z";
const CONTROLLER = "22222222-2222-4222-8222-222222222222";
const REF: TicketRef = { provider: "gitlab", repository: "group/project", number: 23 };

function state(): ControlState {
  return {
    apiVersion: "agent-flow/v1alpha1",
    kind: "ControlState",
    flowInstanceId: "11111111-1111-4111-8111-111111111111",
    flowId: "development",
    configRevision: "a".repeat(40),
    sequence: 0,
    stateId: "assessment",
    resumeStateId: null,
    activatedBy: { login: "owner", providerId: "42" },
    activatedAt: NOW,
    activationEventId: "event-803",
    updatedAt: NOW,
    attemptSeries: null,
    latestReceipt: null,
    humanGate: null,
    changeRequest: null,
  };
}

test("stores control updates locally and rejects a stale revision without provider calls", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-control-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = openLocalStore(join(directory, "execution.sqlite"));
  t.after(() => store.close());
  const providerWrites: string[] = [];
  const scope = providerScope("gitlab", "https://gitlab.example.test/api/v4");
  const writer = createControlWriter(store, scope, CONTROLLER, () => NOW);
  const current = state();

  await writer(REF, null, current);
  const next = advanceControlState(current, { stateId: "planning" }, NOW);
  assert.deepEqual(await writer(REF, current, next), next);

  assert.equal(providerWrites.length, 0);
  assert.deepEqual(store.load(scope, REF)?.value.control, next);
  await assert.rejects(
    writer(REF, current, advanceControlState(current, { stateId: "development" }, NOW)),
    /stale local execution write/,
  );
});
