import { electOwner, type Publication } from "../provider/publication.ts";
import type { RecoveryEvidence } from "../provider/types.js";

export interface RecoveryDecision {
  kind: "inactive" | "foreign" | "ambiguous" | "resume" | "reassess";
  owner: Publication | null;
  reason: string | null;
}

export function classifyRecovery(evidence: RecoveryEvidence, controllerId: string): RecoveryDecision {
  if (!evidence.snapshot.activation.present || !evidence.snapshot.open) {
    return decision("inactive", null, "ticket is inactive");
  }
  if (!evidence.complete) return decision("ambiguous", null, "provider evidence is incomplete");
  if (evidence.legacyActive) return decision("ambiguous", null, "active legacy state requires migration");
  if (evidence.activeBoundary === "ambiguous") {
    return decision("ambiguous", null, "active work boundary is ambiguous");
  }

  const owner = electOwner(evidence.publications);
  if (owner && owner.metadata.controller !== controllerId) {
    return decision("foreign", owner, "active work belongs to another controller");
  }

  if (owner) {
    const winningPins = new Set(evidence.publications
      .filter(({ metadata }) => metadata.controller === owner.metadata.controller)
      .map(({ metadata }) => metadata.config));
    if (winningPins.size !== 1) {
      return decision("ambiguous", owner, "winning controller publications have conflicting configuration pins");
    }
    if (evidence.publications.some((publication) =>
      publication.metadata.controller !== owner.metadata.controller && publicationKind(publication) === "change-request")) {
      return decision("ambiguous", owner, "a losing controller published a code change");
    }
  }

  if (evidence.ambiguities.length > 0 || evidence.changes.length > 1) {
    return decision("ambiguous", owner, evidence.ambiguities[0] ?? "multiple linked change requests");
  }

  if (evidence.activeBoundary === "fresh" && evidence.publications.length === 0) {
    return decision("resume", null, null);
  }

  const stages = evidence.snapshot.labels.filter((label) => label.startsWith("agent-stage:"));
  if (stages.length !== 1) return decision("ambiguous", owner, "provider stage is missing or contradictory");
  const stage = stages[0]!.slice("agent-stage:".length);
  if (stage === "blocked" || stage === "needs-human") {
    return decision("ambiguous", owner, `${stage} resume target is unavailable`);
  }
  return decision(owner ? "reassess" : "resume", owner, null);
}

function decision(kind: RecoveryDecision["kind"], owner: Publication | null, reason: string | null): RecoveryDecision {
  return { kind, owner, reason };
}

function publicationKind(publication: Publication): string | null {
  try {
    const key = JSON.parse(publication.key);
    return Array.isArray(key) && typeof key[3] === "string" ? key[3] : null;
  } catch {
    return null;
  }
}
