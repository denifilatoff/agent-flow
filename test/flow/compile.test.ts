import assert from "node:assert/strict";
import test from "node:test";

import { parseYaml, validateDocument } from "../../src/config/schema-validator.ts";
import type { FlowDefinition } from "../../src/config/types.ts";
import { compileFlow } from "../../src/flow/compile.ts";
import type { FlowEvent, FlowEventType } from "../../src/flow/types.ts";

async function loadDevelopmentFlow(): Promise<FlowDefinition> {
  return validateDocument("Flow", await parseYaml("config/flows/development.yaml"));
}

function event(type: FlowEventType, values: Partial<Omit<FlowEvent, "type">> = {}): FlowEvent {
  return {
    type,
    authorizedActor: false,
    activationPresent: false,
    ticketOpen: false,
    headMatches: false,
    receiptValid: false,
    ...values,
  };
}

test("uses XState for the shipped assessment transition", async () => {
  const machine = compileFlow(await loadDevelopmentFlow());
  const result = machine.transition({
    stateId: "assessment",
    resumeStateId: null,
    event: event("agent-succeeded", {
      receiptValid: true,
      activationPresent: true,
      ticketOpen: true,
    }),
  });

  assert.deepEqual(result, {
    changed: true,
    stateId: "assessment-review",
    resumeStateId: null,
    actions: ["record-receipt"],
  });
});

test("refuses a transition when a configured guard fails", async () => {
  const machine = compileFlow(await loadDevelopmentFlow());

  assert.deepEqual(machine.transition({
    stateId: "assessment",
    resumeStateId: null,
    event: event("agent-succeeded", {
      activationPresent: true,
      ticketOpen: true,
    }),
  }), {
    changed: false,
    stateId: "assessment",
    resumeStateId: null,
    actions: [],
  });
});

test("remembers the source state and resolves the needs-human resume target", async () => {
  const machine = compileFlow(await loadDevelopmentFlow());
  const paused = machine.transition({
    stateId: "assessment",
    resumeStateId: null,
    event: event("agent-needs-human", { receiptValid: true }),
  });

  assert.deepEqual(paused, {
    changed: true,
    stateId: "needs-human",
    resumeStateId: "assessment",
    actions: ["record-receipt", "remember-resume-state"],
  });
  assert.deepEqual(machine.transition({
    stateId: paused.stateId,
    resumeStateId: paused.resumeStateId,
    event: event("human-answer-accepted", {
      authorizedActor: true,
      activationPresent: true,
      ticketOpen: true,
      receiptValid: true,
    }),
  }), {
    changed: true,
    stateId: "assessment",
    resumeStateId: null,
    actions: ["record-receipt", "clear-resume-state"],
  });
});

test("resumes a blocked stage and returns the retry reset action", async () => {
  const machine = compileFlow(await loadDevelopmentFlow());

  assert.deepEqual(machine.transition({
    stateId: "blocked",
    resumeStateId: "development",
    event: event("authorized-comment", {
      authorizedActor: true,
      activationPresent: true,
      ticketOpen: true,
    }),
  }), {
    changed: true,
    stateId: "development",
    resumeStateId: null,
    actions: ["reset-retry-budget", "clear-resume-state"],
  });
});

test("refuses a review result for a different change-request head", async () => {
  const machine = compileFlow(await loadDevelopmentFlow());

  assert.deepEqual(machine.transition({
    stateId: "review",
    resumeStateId: null,
    event: event("review-approved", {
      receiptValid: true,
      activationPresent: true,
      ticketOpen: true,
    }),
  }), {
    changed: false,
    stateId: "review",
    resumeStateId: null,
    actions: [],
  });
});

test("final states refuse every machine event", async () => {
  const machine = compileFlow(await loadDevelopmentFlow());
  const input = {
    resumeStateId: null,
    event: event("authorized-comment", {
      authorizedActor: true,
      activationPresent: true,
      ticketOpen: true,
    }),
  };

  for (const stateId of ["done", "cancelled"]) {
    assert.deepEqual(machine.transition({ ...input, stateId }), {
      changed: false,
      stateId,
      resumeStateId: null,
      actions: [],
    });
  }
});
