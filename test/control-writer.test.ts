import assert from "node:assert/strict";
import test from "node:test";

import type { ControlState } from "../src/config/types.ts";
import { advanceControlState, renderControlComment } from "../src/provider/control-comment.ts";
import type {
  ProviderAdapter,
  ProviderComment,
  ProviderTicketSnapshot,
  TicketRef,
} from "../src/provider/types.ts";
import { createControlWriter } from "../src/runtime/control-state.ts";

const NOW = "2026-08-26T12:00:00.000Z";
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

function comment(body: string): ProviderComment {
  return {
    id: "603",
    url: "https://gitlab.example.test/group/project/-/issues/23#note_603",
    body,
    actor: { login: "owner", providerId: "42" },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function provider(initial: ControlState, updateBody = (body: string) => body.slice(0, -1)): ProviderAdapter {
  let stored = comment(renderControlComment(initial));
  return {
    kind: "gitlab",
    async readTicket(): Promise<ProviderTicketSnapshot> {
      return { comments: [structuredClone(stored)] } as ProviderTicketSnapshot;
    },
    async updateComment(_ref, _id, body): Promise<ProviderComment> {
      stored = comment(updateBody(body));
      return structuredClone(stored);
    },
    async readComment(): Promise<ProviderComment> { return structuredClone(stored); },
  } as ProviderAdapter;
}

test("accepts a GitLab control update readback without the final newline", async () => {
  const current = state();
  const next = advanceControlState(current, { stateId: "planning" }, NOW);

  const readback = await createControlWriter(provider(current))(REF, current, next);

  assert.deepEqual(readback, next);
});

test("rejects a control update response with the wrong state", async () => {
  const current = state();
  const next = advanceControlState(current, { stateId: "planning" }, NOW);
  const wrong = advanceControlState(current, { stateId: "development" }, NOW);

  await assert.rejects(
    createControlWriter(provider(current, () => renderControlComment(wrong)))(REF, current, next),
    /control state update mismatch/,
  );
});
