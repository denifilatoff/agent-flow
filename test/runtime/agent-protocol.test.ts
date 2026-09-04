import assert from "node:assert/strict";
import test from "node:test";

import { parseYaml, validateDocument } from "../../src/config/schema-validator.ts";
import type { FlowDefinition } from "../../src/config/types.ts";
import {
  allowedAgentEvents,
  EVENT_SOURCES,
  renderRuntimePrompt,
  type RuntimePromptInput,
} from "../../src/runtime/agent-protocol.ts";

const FLOW_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const HEAD_SHA = "abcdef0123456789abcdef0123456789abcdef01";

async function shippedFlow(): Promise<FlowDefinition> {
  return validateDocument("Flow", await parseYaml("config/flows/development.yaml"));
}

function promptInput(flow: FlowDefinition, overrides: Partial<RuntimePromptInput> = {}): RuntimePromptInput {
  return {
    flow,
    stateId: "assessment",
    mode: "stage",
    resultContract: "assessment",
    flowInstanceId: FLOW_ID,
    attemptId: ATTEMPT_ID,
    contextPath: "/data/sessions/context.json",
    decisionPath: "/data/sessions/decision.json",
    changeRequest: null,
    sourceComment: null,
    ...overrides,
  };
}

test("filters configured model events by active state and attempt mode", async () => {
  const flow = await shippedFlow();

  assert.deepEqual(allowedAgentEvents(flow, "assessment", "stage"), [
    "agent-succeeded",
    "agent-needs-human",
  ]);
  assert.deepEqual(allowedAgentEvents(flow, "assessment-review", "human-input"), [
    "human-approved",
    "human-changes-requested",
    "human-question",
    "human-unclear",
    "human-cancelled",
  ]);
  assert.deepEqual(allowedAgentEvents(flow, "needs-human", "human-input"), [
    "human-answer-cancelled",
    "human-answer-accepted",
    "human-answer-unclear",
  ]);
  assert.deepEqual(allowedAgentEvents(flow, "needs-human", "stage"), ["agent-needs-human"]);
  assert.deepEqual(allowedAgentEvents(flow, "awaiting-merge", "stage"), []);
  assert.deepEqual(allowedAgentEvents(flow, "done", "stage"), []);
  assert.equal(EVENT_SOURCES["attempts-exhausted"], "controller");
  assert.equal(EVENT_SOURCES["change-request-closed"], "provider");
});

test("rejects prompt generation when a launch has no permitted model event", () => {
  const flow: FlowDefinition = {
    apiVersion: "agent-flow/v1alpha1",
    kind: "Flow",
    metadata: {
      id: "missing-model-event",
      activationLabel: "agent-flow:development",
      managedLabel: "agent-flow:managed",
    },
    spec: {
      initial: "agent-state",
      states: {
        "agent-state": {
          kind: "agent",
          agent: "worker",
          resultContract: "assessment",
          on: { "attempts-exhausted": { target: "done" } },
        },
        "human-state": {
          kind: "human-gate",
          agent: "worker",
          resultContract: "human-gate",
          on: { "authorized-comment": { target: "done" } },
        },
        done: { kind: "final" },
      },
    },
  };

  assert.throws(() => renderRuntimePrompt(promptInput(flow, { stateId: "agent-state" })), /no permitted model event/);
  assert.throws(() => renderRuntimePrompt(promptInput(flow, {
    stateId: "human-state",
    mode: "human-input",
    resultContract: "human-gate",
  })), /no permitted model event/);
});

test("renders paths, exact decisions, evidence, marker, and protocol boundaries", async () => {
  const flow = await shippedFlow();
  const prompt = renderRuntimePrompt(promptInput(flow));
  const marker = `<!-- agent-flow:v1 flow=${FLOW_ID} attempt=${ATTEMPT_ID} artifact=assessment -->`;

  assert.match(prompt, /\/data\/sessions\/context\.json/);
  assert.match(prompt, /\/data\/sessions\/decision\.json/);
  assert.match(prompt, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompt, /\{"event":"agent-succeeded"\}/);
  assert.match(prompt, /\{"event":"agent-needs-human"\}/);
  assert.match(prompt, /assessment comment/);
  assert.match(prompt, /required provider evidence/);
  assert.match(prompt, /Do not edit labels beginning with `agent-flow:` or `agent-stage:`/);

  for (const forbidden of [
    "attempts-exhausted",
    "authorized-comment",
    "change-request-updated",
    "change-request-merged",
    "change-request-closed",
    "targetState",
    "retry",
  ]) {
    assert.equal(prompt.includes(forbidden), false, `prompt contains ${forbidden}`);
  }
});

test("renders event-specific evidence and the pinned change identity", async () => {
  const flow = await shippedFlow();
  const changeRequest = {
    provider: "github" as const,
    repository: "owner/repo",
    number: 8,
    url: "https://github.test/owner/repo/pull/8",
    headSha: HEAD_SHA,
    state: "open" as const,
    actor: { login: "owner", providerId: "1" },
    updatedAt: "2026-08-27T10:00:00.000Z",
  };

  const plan = renderRuntimePrompt(promptInput(flow, { stateId: "planning", resultContract: "plan" }));
  assert.match(plan, /plan comment/);
  assert.match(plan, /artifact=plan/);

  const diagnostic = renderRuntimePrompt(promptInput(flow, {
    stateId: "bug-reproduction",
    resultContract: "diagnostic",
  }));
  assert.match(diagnostic, /diagnostic comment/);
  assert.match(diagnostic, /artifact=diagnostic/);

  const initialDevelopment = renderRuntimePrompt(promptInput(flow, {
    stateId: "development",
    resultContract: "development",
  }));
  assert.ok(initialDevelopment.includes(
    '{"event":"agent-succeeded"} requires creation of one linked open change request during this attempt.',
  ));

  const retryDevelopment = renderRuntimePrompt(promptInput(flow, {
    stateId: "development",
    resultContract: "development",
    changeRequest,
  }));
  assert.ok(retryDevelopment.includes(
    '{"event":"agent-succeeded"} requires the exact pinned change request github owner/repo#8 to remain open and be '
      + "updated during this attempt. Do not create another change request.",
  ));

  const review = renderRuntimePrompt(promptInput(flow, {
    stateId: "review",
    resultContract: "review",
    changeRequest,
  }));
  assert.match(review, /provider-native review/);
  assert.ok(review.includes(
    `{"event":"review-approved"} requires a provider-native review on ${HEAD_SHA}`,
  ));
  assert.match(review, new RegExp(HEAD_SHA));
  assert.match(review, /github owner\/repo#8/);
  assert.match(review, /https:\/\/github\.test\/owner\/repo\/pull\/8/);
  assert.match(review, /artifact=review/);

  const verification = renderRuntimePrompt(promptInput(flow, {
    stateId: "bug-verification",
    resultContract: "verification",
    changeRequest,
  }));
  assert.match(verification, /BUG RECEIPT · VERIFIED/);
  assert.match(verification, new RegExp(HEAD_SHA));
  assert.match(verification, /artifact=diagnostic/);

  const paused = renderRuntimePrompt(promptInput(flow, {
    stateId: "needs-human",
    resultContract: "review",
    changeRequest: { ...changeRequest, state: "closed" },
  }));
  assert.match(paused, /question comment/);
  assert.match(paused, /artifact=question/);
  assert.ok(paused.includes(
    "Because the linked change request is closed, do not review its head. Publish exactly one question asking whether "
      + "to reopen the same change request or cancel the flow, then write {\"event\":\"agent-needs-human\"}.",
  ));
});

test("rejects a review prompt without a pinned change request", async () => {
  const flow = await shippedFlow();

  assert.throws(
    () => renderRuntimePrompt(promptInput(flow, { stateId: "review", resultContract: "review" })),
    /review event requires a pinned change request/,
  );
});

test("rejects a verification prompt without a pinned change request", async () => {
  const flow = await shippedFlow();

  assert.throws(
    () => renderRuntimePrompt(promptInput(flow, {
      stateId: "bug-verification",
      resultContract: "verification",
    })),
    /verification requires a pinned change request/,
  );
});

test("human input publishes only clarification questions", async () => {
  const flow = await shippedFlow();
  const sourceComment = {
    id: "comment-17",
    url: "https://github.test/owner/repo/issues/7#issuecomment-17",
    body: "Reopen it.",
    actor: { login: "maintainer", providerId: "2" },
    createdAt: "2026-08-27T10:00:00.000Z",
    updatedAt: "2026-08-27T10:00:00.000Z",
  };
  const prompt = renderRuntimePrompt(promptInput(flow, {
    stateId: "needs-human",
    mode: "human-input",
    resultContract: "human-gate",
    sourceComment,
  }));

  assert.match(prompt, /authorized human comment comment-17/);
  assert.ok(prompt.includes(
    "Human-input mode: interpret only the supplied authorized human comment. Do not perform stage work or publish "
      + "stage artifacts or a review verdict. Accepted, rejected, or cancelled decisions publish nothing. A question "
      + "or unclear decision may publish only the required clarification question.",
  ));
  assert.match(prompt, /\{"event":"human-answer-accepted"\} requires no new provider publication/);
  assert.match(prompt, /\{"event":"human-answer-cancelled"\} requires no new provider publication/);
  assert.match(prompt, /\{"event":"human-answer-unclear"\} requires a marked question comment/);
});
