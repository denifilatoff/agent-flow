import { and, createMachine, transition as xstateTransition } from "xstate";

import type { FlowDefinition, FlowTransition } from "../config/types.js";
import type {
  CompiledFlow,
  FlowActionName,
  FlowEvent,
  FlowGuardName,
  MachineInput,
  MachineResult,
} from "./types.js";

const guards: Record<FlowGuardName, ({ event }: { event: FlowEvent }) => boolean> = {
  "authorized-actor": ({ event }) => event.authorizedActor,
  "activation-present": ({ event }) => event.activationPresent,
  "ticket-open": ({ event }) => event.ticketOpen,
  "head-matches": ({ event }) => event.headMatches,
  "receipt-valid": ({ event }) => event.receiptValid,
};

function compileTransition(sourceStateId: string, definition: FlowTransition) {
  return {
    target: definition.target === "$resume" ? sourceStateId : definition.target,
    guard: definition.guards?.length ? and(definition.guards) : undefined,
    actions: definition.actions,
  };
}

export function compileFlow(definition: FlowDefinition): CompiledFlow {
  const states = Object.fromEntries(Object.entries(definition.spec.states).map(([stateId, state]) => [
    stateId,
    state.kind === "final"
      ? { type: "final" as const }
      : {
          on: Object.fromEntries(Object.entries(state.on ?? {}).map(([event, transition]) => [
            event,
            compileTransition(stateId, transition),
          ])),
        },
  ]));
  const machine = createMachine({
    types: {} as { context: Record<string, never>; events: FlowEvent },
    context: {},
    initial: definition.spec.initial,
    states,
  }, { guards });

  return {
    initialStateId: definition.spec.initial,
    transition(input: MachineInput): MachineResult {
      const configuredTransition = definition.spec.states[input.stateId]?.on?.[input.event.type];
      if (configuredTransition?.target === "$resume" && input.resumeStateId === null) {
        return { changed: false, stateId: input.stateId, resumeStateId: null, actions: [] };
      }

      const snapshot = machine.resolveState({ value: input.stateId, context: {} });
      if (!snapshot.can(input.event)) {
        return {
          changed: false,
          stateId: input.stateId,
          resumeStateId: input.resumeStateId,
          actions: [],
        };
      }

      const [nextSnapshot, executableActions] = xstateTransition(machine, snapshot, input.event);
      const actions = executableActions.map((action) => action.type as FlowActionName);
      const stateId = configuredTransition?.target === "$resume"
        ? input.resumeStateId!
        : String(nextSnapshot.value);
      let resumeStateId = input.resumeStateId;
      for (const action of actions) {
        if (action === "remember-resume-state") {
          resumeStateId = configuredTransition?.resumeTarget ?? input.stateId;
        } else if (action === "clear-resume-state") {
          resumeStateId = null;
        }
      }

      return { changed: true, stateId, resumeStateId, actions };
    },
  };
}
