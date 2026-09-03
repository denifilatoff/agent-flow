import assert from "node:assert/strict";
import test from "node:test";

import { parseYaml, validateDocument } from "../../src/config/schema-validator.ts";
import type { AgentDecision, FlowDefinition } from "../../src/config/types.ts";

test("rejects unknown fields and unsupported versions", async () => {
  const value = await parseYaml("config/flows/development.yaml") as Record<string, unknown>;
  assert.throws(() => validateDocument("Flow", { ...value, extra: true }));
  assert.throws(() => validateDocument("Flow", { ...value, apiVersion: "agent-flow/v1" }));
});

test("accepts every shipped YAML document", async () => {
  validateDocument("Stack", await parseYaml("config/stack.yaml"));
  validateDocument("Flow", await parseYaml("config/flows/development-autonomous.yaml"));
  validateDocument("Flow", await parseYaml("config/flows/development.yaml"));
  validateDocument("Flow", await parseYaml("config/flows/development-autonomous.yaml"));
  validateDocument("AgentCatalog", await parseYaml("config/agents.yaml"));
});

test("accepts a minimal AgentDecision and rejects invalid decisions", () => {
  const decision = validateDocument<AgentDecision>("AgentDecision", { event: "agent-succeeded" });
  assert.deepEqual(decision, { event: "agent-succeeded" });
  assert.throws(() => validateDocument<AgentDecision>("AgentDecision", { event: "unknown" }));
  assert.throws(() => validateDocument<AgentDecision>("AgentDecision", {}));
  assert.throws(() => validateDocument<AgentDecision>("AgentDecision", { event: "agent-succeeded", extra: true }));
});

test("keeps the Git agent catalog logical", async () => {
  const catalog = await parseYaml("config/agents.yaml") as Record<string, unknown>;
  validateDocument("AgentCatalog", catalog);
  const agents = catalog.agents as Record<string, Record<string, unknown>>;
  assert.deepEqual(agents.architect, { package: "agent-packages/architect" });
  assert.throws(() => validateDocument("AgentCatalog", {
    ...catalog,
    agents: { ...agents, architect: { ...agents.architect, target: "codex" } },
  }));
});

test("rejects unsafe stack references", async () => {
  const stack = await parseYaml("config/stack.yaml") as Record<string, unknown>;
  const spec = stack.spec as Record<string, unknown>;
  for (const flow of ["../flow.yaml", "config/../flow.yaml", "/config/flow.yaml", "flow.yaml"]) {
    assert.throws(() => validateDocument("Stack", { ...stack, spec: { ...spec, flow } }));
  }
});

test("accepts a cancelled AgentReceipt human gate", () => {
  validateDocument("AgentReceipt", {
    apiVersion: "agent-flow/v1alpha1",
    kind: "AgentReceipt",
    flowInstanceId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    outcome: "succeeded",
    summary: "The authorized user cancelled the flow.",
    artifacts: [],
    humanGate: { sourceCommentId: "17", verdict: "cancelled", notes: [] },
  });
});

test("accepts a cancelled ControlState human gate", () => {
  validateDocument("ControlState", {
    apiVersion: "agent-flow/v1alpha1",
    kind: "ControlState",
    flowInstanceId: "11111111-1111-4111-8111-111111111111",
    flowId: "development",
    configRevision: "0123456789abcdef0123456789abcdef01234567",
    sequence: 1,
    stateId: "needs-human",
    resumeStateId: "review",
    activatedBy: { login: "maintainer", providerId: "7" },
    activatedAt: "2026-08-26T10:00:00.000Z",
    activationEventId: "803",
    updatedAt: "2026-08-26T11:00:00.000Z",
    attemptSeries: null,
    latestReceipt: null,
    humanGate: {
      sourceCommentId: "17",
      actor: { login: "maintainer", providerId: "7" },
      verdict: "cancelled",
      interpretedByAttemptId: "22222222-2222-4222-8222-222222222222",
      notes: [],
    },
    changeRequest: null,
  });
});

test("accepts the human-answer-cancelled flow event", async () => {
  const flow = await parseYaml("config/flows/development.yaml") as FlowDefinition;
  flow.spec.states["needs-human"]!.on!["human-answer-cancelled"] = {
    target: "cancelled",
    guards: ["authorized-actor", "receipt-valid"],
    actions: ["record-receipt", "clear-resume-state", "remove-activation-label"],
  };
  validateDocument("Flow", flow);
});

test("accepts the human-cancelled review-gate event", async () => {
  const flow = await parseYaml("config/flows/development.yaml") as FlowDefinition;
  flow.spec.states["assessment-review"]!.on!["human-cancelled"] = {
    target: "cancelled",
    guards: ["authorized-actor", "receipt-valid"],
    actions: ["record-receipt", "clear-resume-state", "remove-activation-label"],
  };
  validateDocument("Flow", flow);
});
