import type { FlowTransition } from "../config/types.js";

export type FlowEventType =
  | "agent-succeeded"
  | "agent-needs-human"
  | "attempts-exhausted"
  | "review-approved"
  | "review-changes-requested"
  | "human-approved"
  | "human-changes-requested"
  | "human-question"
  | "human-unclear"
  | "human-answer-accepted"
  | "human-answer-cancelled"
  | "human-answer-unclear"
  | "authorized-comment"
  | "change-request-updated"
  | "change-request-merged"
  | "change-request-closed";

export type FlowGuardName = NonNullable<FlowTransition["guards"]>[number];
export type FlowActionName = NonNullable<FlowTransition["actions"]>[number];

export interface FlowEvent {
  type: FlowEventType;
  authorizedActor: boolean;
  activationPresent: boolean;
  ticketOpen: boolean;
  headMatches: boolean;
  receiptValid: boolean;
}

export interface MachineInput {
  stateId: string;
  resumeStateId: string | null;
  event: FlowEvent;
}

export interface MachineResult {
  changed: boolean;
  stateId: string;
  resumeStateId: string | null;
  actions: FlowActionName[];
}

export interface CompiledFlow {
  readonly initialStateId: string;
  transition(input: MachineInput): MachineResult;
}
