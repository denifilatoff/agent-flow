import assert from "node:assert/strict";
import test from "node:test";

import type { ControlState } from "../../src/config/types.ts";
import {
  advanceControlState,
  listControlComments,
  parseControlComment,
  parseExpectedControlComment,
  renderControlComment,
  selectActiveControlComment,
  type ProviderComment,
} from "../../src/provider/control-comment.ts";

const NOW = "2026-08-26T09:30:00.000Z";
const FLOW_1 = "11111111-1111-4111-8111-111111111111";
const FLOW_2 = "22222222-2222-4222-8222-222222222222";

function controlState(patch: Partial<ControlState> = {}): ControlState {
  return {
    apiVersion: "agent-flow/v1alpha1",
    kind: "ControlState",
    flowInstanceId: FLOW_1,
    flowId: "development",
    configRevision: "a".repeat(40),
    sequence: 0,
    stateId: "assessment",
    resumeStateId: null,
    activatedBy: { login: "owner", providerId: "42" },
    activatedAt: "2026-08-26T09:00:00.000Z",
    activationEventId: "event-803",
    updatedAt: "2026-08-26T09:00:00.000Z",
    attemptSeries: null,
    latestReceipt: null,
    humanGate: null,
    changeRequest: null,
    ...patch,
  };
}

function comment(state: ControlState, id = state.flowInstanceId): ProviderComment {
  return { id, body: renderControlComment(state) };
}

test("round trips the exact control marker and increments sequence", () => {
  const body = renderControlComment(controlState({ sequence: 4 }));
  assert.equal(body.split("\n")[0], "<!-- agent-flow-control:v1 -->");
  assert.equal((body.match(/```/g) ?? []).length, 2);
  assert.ok(body.endsWith("```\n"));

  const next = advanceControlState(parseControlComment(body)!, { stateId: "planning" }, NOW);
  assert.equal(next.sequence, 5);
  assert.equal(next.stateId, "planning");
  assert.equal(next.updatedAt, NOW);
});

test("round trips a control comment after GitLab removes its final newline", () => {
  const state = controlState({ sequence: 4 });
  const gitLabBody = renderControlComment(state).slice(0, -1);

  assert.deepEqual(parseControlComment(gitLabBody), state);
  assert.deepEqual(parseExpectedControlComment(gitLabBody, state), state);
});

test("rejects any other trailing control comment format", () => {
  const expected = controlState();
  const canonical = renderControlComment(expected);
  const withoutFinalNewline = canonical.slice(0, -1);
  for (const body of [
    `${canonical}\n`,
    `${withoutFinalNewline} `,
    `${withoutFinalNewline}text`,
    canonical.replace("\n```\n", "```\n"),
  ]) {
    assert.throws(() => parseControlComment(body), /control comment/);
    assert.equal(parseExpectedControlComment(body, expected), null);
  }
  assert.equal(
    parseExpectedControlComment(
      renderControlComment(controlState({ sequence: 1 })),
      expected,
    ),
    null,
  );
});

test("returns null only for bodies without the marker on the first line", () => {
  assert.equal(parseControlComment("ordinary comment"), null);
  assert.equal(parseControlComment(`preface\n${renderControlComment(controlState())}`), null);
  assert.throws(() => parseControlComment("<!-- agent-flow-control:v1 -->\nnot-json\n"), /control comment/);
});

test("rejects malformed JSON and schema-invalid state", () => {
  assert.throws(
    () => parseControlComment("<!-- agent-flow-control:v1 -->\n```json\n{\n```\n"),
    /control comment/,
  );
  assert.throws(
    () => parseControlComment(renderControlComment(controlState()).replace('"sequence": 0', '"sequence": -1')),
    /ControlState validation failed/,
  );
  assert.throws(
    () => parseControlComment(`${renderControlComment(controlState())}\nextra`),
    /control comment/,
  );
});

test("keeps terminal history but rejects two comments for one flow", () => {
  const terminal1 = comment(controlState({ stateId: "done" }), "comment-1");
  const terminal2 = comment(controlState({ flowInstanceId: FLOW_2, stateId: "cancelled" }), "comment-2");
  assert.equal(listControlComments([terminal1, terminal2]).length, 2);
  assert.throws(
    () => listControlComments([terminal1, { ...terminal1, id: "comment-copy" }]),
    /duplicate control comment for flow/,
  );
});

test("selects one active flow while retaining terminal history", () => {
  const parsed = listControlComments([
    comment(controlState({ stateId: "done" }), "terminal"),
    comment(controlState({ flowInstanceId: FLOW_2, stateId: "development" }), "active"),
  ]);
  assert.equal(selectActiveControlComment(parsed, new Set(["done", "cancelled"]))?.comment.id, "active");
  assert.equal(
    selectActiveControlComment([parsed[0]!], new Set(["done", "cancelled"])),
    null,
  );
});

test("rejects multiple active flows", () => {
  const parsed = listControlComments([
    comment(controlState(), "active-1"),
    comment(controlState({ flowInstanceId: FLOW_2, stateId: "planning" }), "active-2"),
  ]);
  assert.throws(
    () => selectActiveControlComment(parsed, new Set(["done", "cancelled"])),
    /multiple active control comments/,
  );
});

test("advances only the declared patch surface and preserves identity", () => {
  const current = controlState({ sequence: 7, resumeStateId: "review" });
  const next = advanceControlState(current, { resumeStateId: null, humanGate: null }, NOW);

  assert.deepEqual(
    {
      flowInstanceId: next.flowInstanceId,
      flowId: next.flowId,
      configRevision: next.configRevision,
      activatedBy: next.activatedBy,
      activatedAt: next.activatedAt,
      activationEventId: next.activationEventId,
    },
    {
      flowInstanceId: current.flowInstanceId,
      flowId: current.flowId,
      configRevision: current.configRevision,
      activatedBy: current.activatedBy,
      activatedAt: current.activatedAt,
      activationEventId: current.activationEventId,
    },
  );
  assert.equal(next.sequence, 8);
  assert.equal(next.resumeStateId, null);
  assert.throws(
    () => advanceControlState(current, { configRevision: "b".repeat(40) } as never, NOW),
    /unsupported control state patch field/,
  );
});

test("rejects sequences that cannot be incremented safely", () => {
  assert.throws(
    () => advanceControlState(controlState({ sequence: Number.MAX_SAFE_INTEGER }), {}, NOW),
    /safe integer/,
  );

  const unsafeBody = renderControlComment(controlState()).replace(
    '"sequence": 0',
    '"sequence": 9007199254740992',
  );
  const unsafe = parseControlComment(unsafeBody)!;
  assert.equal(Number.isSafeInteger(unsafe.sequence), false);
  assert.throws(() => advanceControlState(unsafe, {}, NOW), /safe integer/);
});

test("requires one bounded activation event ID", () => {
  const valid = controlState();
  assert.doesNotThrow(() => renderControlComment(valid));

  const missing = { ...valid } as Partial<ControlState> & { activationEventId?: string };
  delete missing.activationEventId;
  assert.throws(() => renderControlComment(missing as ControlState), /activationEventId/);
  assert.throws(
    () => renderControlComment({ ...valid, activationEventId: "" } as ControlState),
    /activationEventId/,
  );
  assert.throws(
    () => renderControlComment({ ...valid, activationEventId: "x".repeat(256) } as ControlState),
    /activationEventId/,
  );
});
