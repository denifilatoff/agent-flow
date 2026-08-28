import { open } from "node:fs/promises";

import { validateDocument, type DocumentValidator } from "../config/schema-validator.ts";
import type {
  AgentDecision,
  AgentEventType,
  AgentReceipt,
  FlowDefinition,
  ReceiptArtifact,
  ReceiptChangeRequest,
  ReceiptComment,
  ReceiptHumanGate,
  ResultContract,
} from "../config/types.js";
import type {
  NormalizedChangeRequest,
  NormalizedReview,
  ProviderAdapter,
  ProviderComment,
  ProviderTicketSnapshot,
  TicketRef,
} from "../provider/types.js";
import { ProviderHttpError } from "../provider/http.ts";
import { allowedAgentEvents, type AttemptMode } from "./agent-protocol.ts";

const MAX_DECISION_BYTES = 1024 * 1024;
const MAX_ERROR_MESSAGE = 240;
const AUTHORIZED_PERMISSIONS = new Set(["write", "maintain", "admin"]);

export interface DecisionExpectation {
  flow: FlowDefinition;
  stateId: string;
  mode: AttemptMode;
  resultContract: ResultContract;
  flowInstanceId: string;
  attemptId: string;
  ticket: TicketRef;
  startedAt: string;
  sourceComment: ProviderComment | null;
  pinnedChangeRequest: NormalizedChangeRequest | null;
}

class DecisionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(name: string, code: string, message: string, retryable: boolean) {
    super(message.slice(0, MAX_ERROR_MESSAGE));
    this.name = name;
    this.code = code;
    this.retryable = retryable;
  }
}

export class InvalidDecisionError extends DecisionError {
  constructor(message: string) {
    super("InvalidDecisionError", "INVALID_DECISION", message, true);
  }
}

export class DecisionEvidenceUnavailableError extends DecisionError {
  constructor(message: string) {
    super("DecisionEvidenceUnavailableError", "DECISION_EVIDENCE_UNAVAILABLE", message, true);
  }
}

export class DecisionReadbackError extends DecisionError {
  constructor() {
    super(
      "DecisionReadbackError",
      "DECISION_READBACK_FAILED",
      "provider decision evidence readback failed transiently",
      true,
    );
  }
}

export class DecisionTrustError extends DecisionError {
  constructor(message: string) {
    super("DecisionTrustError", "DECISION_TRUST_FAILED", message, false);
  }
}

const DECISION_SUMMARIES: Readonly<Record<AgentEventType, string>> = Object.freeze({
  "agent-succeeded": "Agent completed the stage.",
  "agent-needs-human": "Agent requested human input.",
  "review-approved": "Review approved the change.",
  "review-changes-requested": "Review requested changes.",
  "human-approved": "Human approved the result.",
  "human-changes-requested": "Human requested changes.",
  "human-question": "Human asked a question.",
  "human-unclear": "Human intent was unclear.",
  "human-cancelled": "Human cancelled the flow.",
  "human-answer-accepted": "Human answer was accepted.",
  "human-answer-cancelled": "Human answer cancelled the flow.",
  "human-answer-unclear": "Human answer was unclear.",
});

export async function readDecisionAndBuildReceipt(
  path: string,
  expected: DecisionExpectation,
  provider: ProviderAdapter,
  cancelled: boolean,
  validate: DocumentValidator = validateDocument,
): Promise<AgentReceipt> {
  if (cancelled) decisionTrust("cancelled attempt cannot accept a decision");
  if (provider.kind !== expected.ticket.provider) {
    decisionTrust("provider does not match the expected ticket");
  }

  const source = await readBoundedDecision(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    invalidDecision("decision contains invalid JSON");
  }

  let decision: AgentDecision;
  try {
    decision = validate<AgentDecision>("AgentDecision", parsed);
  } catch {
    invalidDecision("decision does not match the AgentDecision schema");
  }

  let allowed: AgentEventType[];
  try {
    allowed = allowedAgentEvents(expected.flow, expected.stateId, expected.mode);
  } catch {
    invalidDecision("decision state is not configured in the pinned flow");
  }
  if (!allowed.includes(decision.event)) {
    invalidDecision("decision event is not allowed by the pinned flow state");
  }

  const initialTicket = await decisionProviderRead(() => provider.readTicket(expected.ticket));
  assertDecisionTicket(initialTicket, expected.ticket);

  const artifacts: ReceiptArtifact[] = [];
  const verifiedComments: ProviderComment[] = [];
  let verifiedChange: NormalizedChangeRequest | null = null;
  let humanGate: ReceiptHumanGate | undefined;
  let outcome: AgentReceipt["outcome"] = "succeeded";

  if (decision.event === "agent-succeeded") {
    if (expected.resultContract === "assessment" || expected.resultContract === "plan") {
      const artifactKind = expected.resultContract;
      const published = await discoverDecisionComment(
        initialTicket,
        artifactKind,
        expected,
        provider,
      );
      verifiedComments.push(published);
      artifacts.push(commentArtifact(published, artifactKind, expected));
    } else if (expected.resultContract === "development") {
      verifiedChange = await readDecisionChange(initialTicket, expected, provider);
      artifacts.push(changeArtifact(verifiedChange));
    } else {
      invalidDecision("agent-succeeded is not configured for the pinned result contract");
    }
  } else if (decision.event === "agent-needs-human") {
    const published = await discoverDecisionComment(initialTicket, "question", expected, provider);
    verifiedComments.push(published);
    artifacts.push(commentArtifact(published, "question", expected));
    outcome = "needs-human";
  } else if (decision.event === "review-approved" || decision.event === "review-changes-requested") {
    const published = await readDecisionReview(initialTicket, decision.event, expected, provider);
    artifacts.push({
      kind: "review",
      id: published.id,
      url: published.url,
      headSha: published.headSha,
      verdict: published.verdict,
    });
  } else {
    const sourceComment = await readHumanSource(initialTicket, expected, provider);
    verifiedComments.push(sourceComment);
    const verdict = humanVerdict(decision.event);
    humanGate = { sourceCommentId: sourceComment.id, verdict, notes: [] };
    if (verdict === "question" || verdict === "unclear") {
      const published = await discoverDecisionComment(initialTicket, "question", expected, provider);
      verifiedComments.push(published);
      artifacts.push(commentArtifact(published, "question", expected));
    }
  }

  const finalTicket = await decisionProviderReadback(
    () => provider.readTicket(expected.ticket),
    "provider ticket disappeared during final readback",
  );
  assertDecisionTicket(finalTicket, expected.ticket);
  assertDecisionCommentMembership(verifiedComments, finalTicket, expected, provider.kind);
  if (verifiedChange) assertFinalDecisionChange(finalTicket, verifiedChange, expected);
  if (decision.event === "review-approved" || decision.event === "review-changes-requested") {
    assertFinalReviewChange(finalTicket, expected);
  }

  return {
    apiVersion: "agent-flow/v1alpha1",
    kind: "AgentReceipt",
    flowInstanceId: expected.flowInstanceId,
    attemptId: expected.attemptId,
    outcome,
    summary: DECISION_SUMMARIES[decision.event],
    artifacts,
    ...(humanGate ? { humanGate } : {}),
  };
}

async function discoverDecisionComment(
  ticket: ProviderTicketSnapshot,
  artifactKind: "assessment" | "plan" | "question",
  expected: DecisionExpectation,
  provider: ProviderAdapter,
): Promise<ProviderComment> {
  const expectedMarker = decisionMarker(expected, artifactKind);
  const fresh = ticket.comments.filter((comment) => isFreshEvidence(comment.createdAt, expected.startedAt));
  const sameAttempt = fresh.filter((comment) => attemptArtifact(comment.body, expected) !== null);
  if (sameAttempt.some((comment) => attemptArtifact(comment.body, expected) !== artifactKind)) {
    decisionTrust("fresh same-attempt comment marker has the wrong artifact kind");
  }

  const matches = fresh.filter((comment) => comment.body.split(/\r?\n/, 1)[0] === expectedMarker);
  if (matches.length === 0) {
    evidenceUnavailable(`${artifactKind} comment evidence is unavailable`);
  }
  if (matches.length > 1) decisionTrust("duplicate marked comment evidence was published");

  const discovered = matches[0]!;
  const published = await decisionProviderReadback(
    () => provider.readComment(expected.ticket, discovered.id),
    "marked comment disappeared during readback",
  );
  if (published.id !== discovered.id) decisionTrust("provider comment ID changed during readback");
  if (!sameCommentUrl(published.url, discovered.url, expected, provider.kind, discovered.id)) {
    decisionTrust("provider comment URL changed during readback");
  }
  if (published.body.split(/\r?\n/, 1)[0] !== expectedMarker) {
    decisionTrust("provider comment marker changed during readback");
  }
  if (!sameProviderComment(discovered, published, expected, provider.kind)) {
    decisionTrust("provider comment changed during readback");
  }
  if (published.body.split(/\r?\n/)[1]?.startsWith("<!-- agent-flow-review:")) {
    decisionTrust("non-review comment contains review metadata");
  }
  return published;
}

async function readDecisionChange(
  ticket: ProviderTicketSnapshot,
  expected: DecisionExpectation,
  provider: ProviderAdapter,
): Promise<NormalizedChangeRequest> {
  const linked = ticket.changeRequest;
  if (!linked) evidenceUnavailable("linked change request evidence is unavailable");
  assertChangeTicketIdentity(linked, expected.ticket);
  if (expected.pinnedChangeRequest && !sameChangeIdentity(linked, expected.pinnedChangeRequest)) {
    decisionTrust("linked change request identity does not match the pinned change request");
  }
  if (linked.state !== "open") decisionTrust("linked change request state is not open");
  if (!isFreshEvidence(linked.updatedAt, expected.startedAt)) {
    evidenceUnavailable("linked change request was not updated during the attempt");
  }

  const published = await decisionProviderReadback(
    () => provider.readChangeRequest(expected.ticket, linked.number),
    "linked change request disappeared during readback",
  );
  assertChangeTicketIdentity(published, expected.ticket);
  assertSameDecisionChange(linked, published);
  if (!isFreshEvidence(published.updatedAt, expected.startedAt)) {
    evidenceUnavailable("linked change request was not updated during the attempt");
  }
  return published;
}

async function readDecisionReview(
  ticket: ProviderTicketSnapshot,
  event: "review-approved" | "review-changes-requested",
  expected: DecisionExpectation,
  provider: ProviderAdapter,
): Promise<Awaited<ReturnType<ProviderAdapter["readReview"]>>> {
  const pinned = expected.pinnedChangeRequest;
  if (!pinned) decisionTrust("review decision requires a pinned change request");
  const linked = ticket.changeRequest;
  if (!linked) evidenceUnavailable("linked change request evidence is unavailable for review");
  assertChangeTicketIdentity(linked, expected.ticket);
  if (!sameChangeIdentity(linked, pinned)) {
    decisionTrust("linked change request identity does not match the pinned change request");
  }
  if (linked.headSha !== pinned.headSha) {
    decisionTrust("linked change request head SHA does not match the pinned head SHA");
  }
  if (linked.state !== "open") decisionTrust("linked change request state is not open for review");

  const reviewMarker = decisionMarker(expected, "review");
  const discovered = await decisionProviderRead(
    () => provider.findReview(expected.ticket, linked.number, reviewMarker),
    "provider review evidence could not be verified",
  );
  if (!discovered) evidenceUnavailable("provider review evidence is unavailable");
  if (!isFreshEvidence(discovered.submittedAt, expected.startedAt)) {
    evidenceUnavailable("provider review was not submitted during the attempt");
  }
  const published = await decisionProviderReadback(
    () => provider.readReview(expected.ticket, linked.number, discovered.id),
    "provider review disappeared during readback",
  );

  if (published.id !== discovered.id) decisionTrust("provider review ID changed during readback");
  if (published.url !== discovered.url) decisionTrust("provider review URL changed during readback");
  if (published.headSha !== pinned.headSha) {
    decisionTrust("provider review head SHA does not match the pinned head SHA");
  }
  const verdict = event === "review-approved" ? "approved" : "changes-requested";
  if (published.verdict !== verdict) {
    decisionTrust("provider review verdict does not match the decision event");
  }
  const lines = published.body.split(/\r?\n/);
  if (lines[0] !== reviewMarker) decisionTrust("provider review marker does not match the attempt");
  const metadata = `<!-- agent-flow-review:v1 head=${pinned.headSha} verdict=${verdict} -->`;
  if (lines[1] !== metadata) decisionTrust("provider review metadata does not match the logical verdict");
  if (!isFreshEvidence(published.submittedAt, expected.startedAt)) {
    evidenceUnavailable("provider review was not submitted during the attempt");
  }
  if (!sameReview(discovered, published)) decisionTrust("provider review changed during readback");
  return published;
}

async function readHumanSource(
  ticket: ProviderTicketSnapshot,
  expected: DecisionExpectation,
  provider: ProviderAdapter,
): Promise<ProviderComment> {
  const pinned = expected.sourceComment;
  if (!pinned) decisionTrust("human decision requires a pinned source comment");
  const published = await decisionProviderReadback(
    () => provider.readComment(expected.ticket, pinned.id),
    "human source comment disappeared during readback",
  );
  if (published.body.split(/\r?\n/, 1)[0]?.startsWith("<!-- agent-flow:")) {
    decisionTrust("human source comment must be unmarked");
  }
  if (!sameProviderComment(pinned, published, expected, provider.kind)) {
    decisionTrust("human source comment does not match the pinned source comment");
  }
  if (!ticket.comments.some((comment) => sameProviderComment(comment, published, expected, provider.kind))) {
    decisionTrust("human source comment does not belong to the expected ticket");
  }
  const permission = await decisionProviderReadback(
    () => provider.permission(expected.ticket.repository, published.actor),
    "human source permission could not be verified",
  );
  if (!AUTHORIZED_PERMISSIONS.has(permission)) {
    decisionTrust("human source actor lacks write permission");
  }
  return published;
}

function humanVerdict(event: AgentEventType): ReceiptHumanGate["verdict"] {
  switch (event) {
    case "human-approved":
    case "human-answer-accepted": return "approved";
    case "human-changes-requested": return "changes-requested";
    case "human-question": return "question";
    case "human-unclear":
    case "human-answer-unclear": return "unclear";
    case "human-cancelled":
    case "human-answer-cancelled": return "cancelled";
    default: return invalidDecision("decision event is not a human-input event");
  }
}

function commentArtifact(
  published: ProviderComment,
  artifactKind: "assessment" | "plan" | "question",
  expected: DecisionExpectation,
): ReceiptComment {
  return {
    kind: "comment",
    id: published.id,
    url: published.url,
    marker: decisionMarker(expected, artifactKind),
    artifactKind,
  };
}

function changeArtifact(published: NormalizedChangeRequest): ReceiptChangeRequest {
  return {
    kind: "change-request",
    number: published.number,
    url: published.url,
    headSha: published.headSha,
    state: published.state,
  };
}

function assertDecisionTicket(snapshot: ProviderTicketSnapshot, expected: TicketRef): void {
  if (!sameTicketRef(snapshot, expected)) {
    decisionTrust("provider ticket snapshot does not match the expected ticket");
  }
  if (!sameRepositoryIdentity(snapshot, expected)) {
    decisionTrust("provider repository snapshot does not match the expected repository");
  }
}

function sameTicketRef(snapshot: ProviderTicketSnapshot, expected: TicketRef): boolean {
  return snapshot.ref.provider === expected.provider
    && snapshot.ref.repository === expected.repository
    && snapshot.ref.number === expected.number;
}

function sameRepositoryIdentity(snapshot: ProviderTicketSnapshot, expected: TicketRef): boolean {
  return snapshot.repository.provider === expected.provider
    && snapshot.repository.name === expected.repository;
}

function assertDecisionCommentMembership(
  verified: ProviderComment[],
  ticket: ProviderTicketSnapshot,
  expected: DecisionExpectation,
  provider: ProviderAdapter["kind"],
): void {
  for (const published of verified) {
    const matches = ticket.comments.filter((candidate) =>
      sameProviderComment(candidate, published, expected, provider));
    if (matches.length !== 1) {
      decisionTrust("verified comment does not belong to the final expected ticket snapshot");
    }
  }
}

function sameProviderComment(
  left: ProviderComment,
  right: ProviderComment,
  expected: { ticket: TicketRef },
  provider: ProviderAdapter["kind"],
): boolean {
  return left.id === right.id
    && sameCommentUrl(left.url, right.url, expected, provider, left.id)
    && left.body === right.body
    && left.actor.login === right.actor.login
    && left.actor.providerId === right.actor.providerId
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}

function assertChangeTicketIdentity(change: NormalizedChangeRequest, ticket: TicketRef): void {
  if (change.provider !== ticket.provider || change.repository !== ticket.repository) {
    decisionTrust("linked change request identity does not match the expected ticket");
  }
}

function sameChangeIdentity(left: NormalizedChangeRequest, right: NormalizedChangeRequest): boolean {
  return left.provider === right.provider
    && left.repository === right.repository
    && left.number === right.number
    && left.url === right.url;
}

function assertSameDecisionChange(left: NormalizedChangeRequest, right: NormalizedChangeRequest): void {
  if (left.provider !== right.provider || left.repository !== right.repository || left.number !== right.number) {
    decisionTrust("change request identity changed during readback");
  }
  if (left.url !== right.url) decisionTrust("change request URL changed during readback");
  if (left.headSha !== right.headSha) decisionTrust("change request head SHA changed during readback");
  if (left.state !== right.state) decisionTrust("change request state changed during readback");
}

function assertFinalDecisionChange(
  ticket: ProviderTicketSnapshot,
  published: NormalizedChangeRequest,
  expected: DecisionExpectation,
): void {
  if (!ticket.changeRequest) decisionTrust("linked change request is missing from the final ticket snapshot");
  assertChangeTicketIdentity(ticket.changeRequest, expected.ticket);
  assertSameDecisionChange(ticket.changeRequest, published);
}

function assertFinalReviewChange(ticket: ProviderTicketSnapshot, expected: DecisionExpectation): void {
  const pinned = expected.pinnedChangeRequest!;
  if (!ticket.changeRequest) decisionTrust("linked change request is missing from the final review snapshot");
  if (!sameChangeIdentity(ticket.changeRequest, pinned)) {
    decisionTrust("linked change request identity changed during review readback");
  }
  if (ticket.changeRequest.headSha !== pinned.headSha) {
    decisionTrust("linked change request head SHA changed during review readback");
  }
  if (ticket.changeRequest.state !== "open") {
    decisionTrust("linked change request state changed during review readback");
  }
}

function sameReview(left: NormalizedReview, right: NormalizedReview): boolean {
  return left.id === right.id
    && left.url === right.url
    && left.actor.login === right.actor.login
    && left.actor.providerId === right.actor.providerId
    && left.submittedAt === right.submittedAt
    && left.headSha === right.headSha
    && left.verdict === right.verdict
    && left.body === right.body;
}

function decisionMarker(
  expected: DecisionExpectation,
  artifact: "assessment" | "plan" | "question" | "review",
): string {
  return `<!-- agent-flow:v1 flow=${expected.flowInstanceId} attempt=${expected.attemptId} artifact=${artifact} -->`;
}

function attemptArtifact(body: string, expected: DecisionExpectation): string | null {
  const line = body.split(/\r?\n/, 1)[0] ?? "";
  const prefix = `<!-- agent-flow:v1 flow=${expected.flowInstanceId} attempt=${expected.attemptId} artifact=`;
  return line.startsWith(prefix) && line.endsWith(" -->")
    ? line.slice(prefix.length, -4)
    : null;
}

function isFreshEvidence(timestamp: string, startedAt: string): boolean {
  const evidenceTime = Date.parse(timestamp);
  const startTime = Date.parse(startedAt);
  return Number.isFinite(evidenceTime) && Number.isFinite(startTime) && evidenceTime >= startTime;
}

async function decisionProviderRead<T>(
  operation: () => Promise<T>,
  trustMessage = "provider decision evidence could not be verified",
): Promise<T> {
  return decisionProviderOperation(operation, trustMessage, false);
}

async function decisionProviderReadback<T>(
  operation: () => Promise<T>,
  trustMessage: string,
): Promise<T> {
  return decisionProviderOperation(operation, trustMessage, true);
}

async function decisionProviderOperation<T>(
  operation: () => Promise<T>,
  trustMessage: string,
  missingIsTrustViolation: boolean,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DecisionError) throw error;
    if (error instanceof ProviderHttpError) {
      if (error.transient) throw new DecisionReadbackError();
      if (!missingIsTrustViolation && (error.status === 404 || error.status === 410)) {
        throw new DecisionEvidenceUnavailableError("provider decision evidence is unavailable");
      }
    }
    throw new DecisionTrustError(trustMessage);
  }
}

function invalidDecision(message: string): never {
  throw new InvalidDecisionError(message);
}

function evidenceUnavailable(message: string): never {
  throw new DecisionEvidenceUnavailableError(message);
}

function decisionTrust(message: string): never {
  throw new DecisionTrustError(message);
}

async function readBoundedDecision(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) invalidDecision("decision path is not a regular file");
    if (stat.size > MAX_DECISION_BYTES) invalidDecision("decision exceeds the maximum size");

    const bytes = Buffer.allocUnsafe(MAX_DECISION_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > MAX_DECISION_BYTES) invalidDecision("decision exceeds the maximum size");
    return bytes.subarray(0, offset).toString("utf8");
  } catch (error) {
    if (error instanceof InvalidDecisionError) throw error;
    invalidDecision("decision file could not be read");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  invalidDecision("decision file could not be read");
}

function sameCommentUrl(
  published: string,
  artifact: string,
  expected: { ticket: TicketRef },
  provider: ProviderAdapter["kind"],
  commentId: string,
): boolean {
  if (published === artifact) return true;
  if (provider !== "gitlab") return false;
  const canonical = normalizedGitLabCommentUrl(published, expected.ticket, commentId);
  return canonical !== null && canonical === normalizedGitLabCommentUrl(artifact, expected.ticket, commentId);
}

function normalizedGitLabCommentUrl(url: string, ticket: TicketRef, commentId: string): string | null {
  try {
    const parsed = new URL(url);
    if (url !== parsed.href || url.includes("?") || parsed.username || parsed.password
      || parsed.hash !== `#note_${commentId}`) return null;
    const repository = ticket.repository.split("/").map(encodeURIComponent).join("/");
    const issue = `/${repository}/-/issues/${ticket.number}`;
    const workItem = `/${repository}/-/work_items/${ticket.number}`;
    const suffix = parsed.pathname.endsWith(issue) ? issue : parsed.pathname.endsWith(workItem) ? workItem : null;
    if (!suffix) return null;
    return `${parsed.origin}${parsed.pathname.slice(0, -suffix.length)}${issue}${parsed.hash}`;
  } catch {
    return null;
  }
}
