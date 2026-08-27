import type {
  AgentEventType,
  FlowDefinition,
  ResultContract,
} from "../config/types.js";
import type { FlowEventType } from "../flow/types.js";
import type { NormalizedChangeRequest, ProviderComment } from "../provider/types.js";

type EventSource = "agent" | "provider" | "controller";

export type AttemptMode = "stage" | "human-input";

export interface RuntimePromptInput {
  flow: FlowDefinition;
  stateId: string;
  mode: AttemptMode;
  resultContract: ResultContract;
  flowInstanceId: string;
  attemptId: string;
  contextPath: string;
  decisionPath: string;
  changeRequest: NormalizedChangeRequest | null;
  sourceComment: ProviderComment | null;
}

export const EVENT_SOURCES: Readonly<Record<FlowEventType, EventSource>> = Object.freeze({
  "agent-succeeded": "agent",
  "agent-needs-human": "agent",
  "review-approved": "agent",
  "review-changes-requested": "agent",
  "human-approved": "agent",
  "human-changes-requested": "agent",
  "human-question": "agent",
  "human-unclear": "agent",
  "human-cancelled": "agent",
  "human-answer-accepted": "agent",
  "human-answer-cancelled": "agent",
  "human-answer-unclear": "agent",
  "change-request-updated": "provider",
  "change-request-merged": "provider",
  "change-request-closed": "provider",
  "attempts-exhausted": "controller",
  "authorized-comment": "controller",
});

export function allowedAgentEvents(
  flow: FlowDefinition,
  stateId: string,
  mode: AttemptMode,
): AgentEventType[] {
  const state = flow.spec.states[stateId];
  if (!state) throw new Error(`flow state does not exist: ${stateId}`);

  return Object.keys(state.on ?? {}).filter((event): event is AgentEventType => {
    if (!Object.hasOwn(EVENT_SOURCES, event)
      || EVENT_SOURCES[event as FlowEventType] !== "agent") return false;
    return mode === "stage"
      ? event.startsWith("agent-") || event.startsWith("review-")
      : event.startsWith("human-");
  });
}

export function renderRuntimePrompt(input: RuntimePromptInput): string {
  const events = allowedAgentEvents(input.flow, input.stateId, input.mode);
  if (events.length === 0) {
    throw new Error(`flow state ${input.stateId} has no permitted model event for ${input.mode} mode`);
  }

  const lines = [
    `Read the attempt context from ${input.contextPath}.`,
    `Write exactly one allowed JSON object to ${input.decisionPath}, with no other fields.`,
  ];
  if (input.sourceComment) {
    lines.push(`Interpret the authorized human comment ${input.sourceComment.id} from the attempt context.`);
  }
  if (input.changeRequest) {
    const change = input.changeRequest;
    lines.push(
      `Pinned change request: ${change.provider} ${change.repository}#${change.number}, ${change.url}, `
        + `head ${change.headSha}, state ${change.state}.`,
    );
  }
  if (input.mode === "human-input") {
    lines.push(
      "Human-input mode: interpret only the supplied authorized human comment. Do not perform stage work or publish "
        + "stage artifacts or a review verdict. Accepted, rejected, or cancelled decisions publish nothing. A question "
        + "or unclear decision may publish only the required clarification question.",
    );
  }
  if (input.stateId === "needs-human"
    && input.mode === "stage"
    && input.resultContract === "review"
    && input.changeRequest?.state === "closed") {
    lines.push(
      "Because the linked change request is closed, do not review its head. Publish exactly one question asking whether "
        + "to reopen the same change request or cancel the flow, then write {\"event\":\"agent-needs-human\"}.",
    );
  }
  lines.push(
    "Allowed decisions and required provider evidence:",
    ...events.map((event) => `${JSON.stringify({ event })} requires ${evidence(input, event)}.`),
    "Do not edit labels beginning with `agent-flow:` or `agent-stage:`.",
  );
  return lines.join("\n");
}

function evidence(input: RuntimePromptInput, event: AgentEventType): string {
  if (event === "agent-needs-human"
    || event === "human-question"
    || event === "human-unclear"
    || event === "human-answer-unclear") {
    return `a marked question comment beginning exactly with ${marker(input, "question")}`;
  }
  if (event.startsWith("human-")) return "no new provider publication";
  if (event === "review-approved" || event === "review-changes-requested") {
    if (!input.changeRequest) throw new Error("review event requires a pinned change request");
    const head = input.changeRequest.headSha;
    const verdict = event === "review-approved" ? "approved" : "changes-requested";
    return `a provider-native review on ${head} beginning exactly with ${marker(input, "review")} `
      + `and <!-- agent-flow-review:v1 head=${head} verdict=${verdict} -->`;
  }
  if (event === "agent-succeeded") {
    if (input.resultContract === "assessment") {
      return `a marked assessment comment beginning exactly with ${marker(input, "assessment")}`;
    }
    if (input.resultContract === "plan") {
      return `a marked plan comment beginning exactly with ${marker(input, "plan")}`;
    }
    if (input.resultContract === "development") return "a linked open change request";
  }
  throw new Error(`result contract ${input.resultContract} does not support ${event}`);
}

function marker(input: RuntimePromptInput, artifact: "assessment" | "plan" | "question" | "review"): string {
  return `<!-- agent-flow:v1 flow=${input.flowInstanceId} attempt=${input.attemptId} artifact=${artifact} -->`;
}
