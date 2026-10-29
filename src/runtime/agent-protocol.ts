import type {
  AgentEventType,
  FlowDefinition,
  ResultContract,
} from "../config/types.js";
import type { FlowEventType } from "../flow/types.js";
import type { NormalizedChangeRequest, ProviderComment } from "../provider/types.js";
import { renderDocumentation } from "../provider/documentation.ts";
import { renderPublication } from "../provider/publication.ts";

type EventSource = "agent" | "provider" | "controller";

export type AttemptMode = "stage" | "human-input";

export interface RuntimePromptInput {
  flow: FlowDefinition;
  stateId: string;
  mode: AttemptMode;
  resultContract: ResultContract;
  configRevision: string;
  controllerId: string;
  contextPath: string;
  decisionPath: string;
  changeRequest: NormalizedChangeRequest | null;
  sourceComment: ProviderComment | null;
  excludedReviewIds?: readonly string[];
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

  if (input.resultContract === "verification" && !input.changeRequest) {
    throw new Error("verification requires a pinned change request");
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
  if (input.mode === "stage") {
    lines.push(
      "Inspect the supplied prior publications and code before deciding that the stage is complete. "
        + "Reuse an existing suitable final result by returning its matching decision without publishing a duplicate. "
        + "A question, progress note, partial implementation, or obsolete review is not a completed result. "
        + "If the existing publication asks an unresolved question, reuse it with agent-needs-human. "
        + "If the evidence is still ambiguous, request human clarification instead of claiming success.",
    );
  }
  if (input.resultContract === "review" && input.mode === "stage") {
    if (input.excludedReviewIds?.length) {
      lines.push(`Do not reuse these existing review IDs for this attempt: ${input.excludedReviewIds.join(", ")}.`);
    }
    lines.push(
      "If one existing provider-native review already satisfies either exact review evidence contract for this pinned "
        + "head, reuse it by writing the matching decision without publishing another review.",
    );
  }
  lines.push(
    "Allowed decisions and required provider evidence:",
    ...events.map((event) => `${JSON.stringify({ event })} requires ${evidence(input, event)}.`),
    "Add the publication marker only to the final result, question, review body, or change-request description. "
      + "Do not mark progress notes.",
    "Do not edit labels beginning with `agent-flow:` or `agent-stage:`.",
  );
  return lines.join("\n");
}

function evidence(input: RuntimePromptInput, event: AgentEventType): string {
  if (event === "agent-needs-human"
    || event === "human-question"
    || event === "human-unclear"
    || event === "human-answer-unclear") {
    return `a marked question comment containing exactly ${marker(input)}`;
  }
  if (event.startsWith("human-")) return "no new provider publication";
  if (event === "review-approved" || event === "review-changes-requested") {
    if (!input.changeRequest) throw new Error("review event requires a pinned change request");
    const head = input.changeRequest.headSha;
    const verdict = event === "review-approved" ? "approved" : "changes-requested";
    return `a provider-native review on ${head} beginning exactly with ${marker(input)} `
      + `and <!-- agent-flow-review:v1 head=${head} verdict=${verdict} -->`;
  }
  if (event === "agent-succeeded") {
    if (input.resultContract === "assessment") {
      return `a marked assessment comment containing exactly ${marker(input)}`;
    }
    if (input.resultContract === "plan") {
      return `a marked plan comment containing exactly ${marker(input)}`;
    }
    if (input.resultContract === "diagnostic") return `a marked diagnostic comment containing exactly ${marker(input)}`;
    if (input.resultContract === "verification") {
      return `a marked diagnostic comment containing exactly ${marker(input)} followed by `
        + `BUG RECEIPT · VERIFIED for pinned head ${input.changeRequest!.headSha}`;
    }
    if (input.resultContract === "documentation") {
      const change = input.changeRequest;
      if (!change || change.state !== "open") {
        return "an open pinned linked change request; documentation cannot succeed with a missing or closed request. "
          + "Publish a focused marked question and return agent-needs-human";
      }
      return `the same linked open change request ${change.repository}#${change.number} and a final documentation `
        + `report on the ticket containing exactly ${marker(input)} and a metadata line in this form: `
        + `${renderDocumentation({ change: change.number, inputHead: change.headSha, resultHead: change.headSha })}. `
        + "Keep inputHead fixed to the supplied implementation boundary; replace resultHead with the current full head "
        + "after inspecting the complete diff against the target branch, including rework. Report affected documents "
        + "and checks, or a reasoned no-op with equal heads and no empty commit. Reconcile any head movement before "
        + "claiming completion. Reuse a suitable final report, never an obsolete iteration report; on a retry after "
        + "pushing, inspect existing work and finish the report without duplicating commits. If the implementation "
        + "boundary or concurrent changes cannot be established, ask a focused question. Do not create another request";
    }
    if (input.resultContract === "development") {
      if (!input.changeRequest) {
        return `creation of one linked open change request whose description contains exactly ${marker(input)}`;
      }
      const change = input.changeRequest;
      return `the exact pinned change request ${change.provider} ${change.repository}#${change.number} to remain open `
        + `and be updated during this attempt. Its description must contain exactly ${marker(input)}. `
        + "Do not create another change request";
    }
  }
  throw new Error(`result contract ${input.resultContract} does not support ${event}`);
}

function marker(input: RuntimePromptInput): string {
  return renderPublication({ config: input.configRevision, controller: input.controllerId });
}
