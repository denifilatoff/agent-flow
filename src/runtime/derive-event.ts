import type { ControlState, FlowDefinition } from "../config/types.js";
import type { FlowEvent } from "../flow/types.js";
import type { ProviderTicketSnapshot } from "../provider/types.js";

export type DerivedProviderEvent = FlowEvent | null;

function event(
  type: FlowEvent["type"],
  snapshot: ProviderTicketSnapshot,
  control: ControlState,
  values: Partial<Omit<FlowEvent, "type">> = {},
): FlowEvent {
  return {
    type,
    authorizedActor: control.humanGate !== null,
    activationPresent: snapshot.activation.present,
    ticketOpen: snapshot.open,
    headMatches: false,
    receiptValid: false,
    ...values,
  };
}

export function deriveEvent(
  snapshot: ProviderTicketSnapshot,
  control: ControlState | null,
  flow: FlowDefinition,
): DerivedProviderEvent {
  if (!control || !flow.spec.states[control.stateId]) return null;

  if (control.stateId === "awaiting-merge" && snapshot.changeRequest) {
    if (snapshot.changeRequest.state === "merged") {
      return event("change-request-merged", snapshot, control);
    }
    if (snapshot.changeRequest.state === "closed") {
      return event("change-request-closed", snapshot, control);
    }
    if (control.changeRequest?.headSha !== snapshot.changeRequest.headSha) {
      return event("change-request-updated", snapshot, control);
    }
  }

  const series = control.attemptSeries;
  const receipt = control.latestReceipt;
  if (!series || !receipt || series.stateId !== control.stateId) return null;
  if (series.current?.status !== "succeeded" || series.current.attemptId !== receipt.attemptId) return null;

  if (receipt.humanGate) {
    const type = control.stateId === "needs-human"
      ? receipt.humanGate.verdict === "unclear" ? "human-answer-unclear" : "human-answer-accepted"
      : `human-${receipt.humanGate.verdict}` as FlowEvent["type"];
    return event(type, snapshot, control, { authorizedActor: true, receiptValid: true });
  }
  if (receipt.outcome === "needs-human") {
    return event("agent-needs-human", snapshot, control, { receiptValid: true });
  }
  if (receipt.outcome === "failed") {
    return series.consumed >= series.maxAttempts
      ? event("attempts-exhausted", snapshot, control)
      : null;
  }

  const review = receipt.artifacts.find((artifact) => artifact.kind === "review");
  if (review?.kind === "review") {
    const headMatches = snapshot.changeRequest?.headSha === review.headSha;
    if (review.verdict === "commented") return null;
    return event(
      review.verdict === "approved" ? "review-approved" : "review-changes-requested",
      snapshot,
      control,
      { receiptValid: true, headMatches },
    );
  }
  return event("agent-succeeded", snapshot, control, { receiptValid: true });
}
