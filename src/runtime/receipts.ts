import { open } from "node:fs/promises";

import { validateDocument } from "../config/schema-validator.ts";
import type {
  AgentReceipt,
  ReceiptArtifact,
  ReceiptChangeRequest,
  ReceiptComment,
  ReceiptReview,
  ResultContract,
} from "../config/types.js";
import type {
  NormalizedChangeRequest,
  ProviderAdapter,
  ProviderComment,
  ProviderTicketSnapshot,
  TicketRef,
} from "../provider/types.js";

const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_ERROR_MESSAGE = 240;
const AUTHORIZED_PERMISSIONS = new Set(["write", "maintain", "admin"]);

export interface ReceiptExpectation {
  flowInstanceId: string;
  attemptId: string;
  resultContract: ResultContract;
  ticket: TicketRef;
  pinnedHeadSha: string | null;
}

export class InvalidReceiptError extends Error {
  readonly code = "INVALID_RECEIPT";
  readonly retryable = false;

  constructor(message: string) {
    super(message.slice(0, MAX_ERROR_MESSAGE));
    this.name = "InvalidReceiptError";
  }
}

export async function readAndVerifyReceipt(
  path: string,
  expected: ReceiptExpectation,
  provider: ProviderAdapter,
  cancelled: boolean,
): Promise<AgentReceipt> {
  if (cancelled) invalid("cancelled attempt cannot accept a receipt");
  if (provider.kind !== expected.ticket.provider) invalid("provider does not match the expected ticket");

  const source = await readBoundedReceipt(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    invalid("receipt contains invalid JSON");
  }

  let receipt: AgentReceipt;
  try {
    receipt = validateDocument<AgentReceipt>("AgentReceipt", parsed);
  } catch {
    invalid("receipt does not match the AgentReceipt schema");
  }

  if (receipt.flowInstanceId !== expected.flowInstanceId) invalid("receipt flow instance ID does not match");
  if (receipt.attemptId !== expected.attemptId) invalid("receipt attempt ID does not match");

  assertUniqueArtifacts(receipt.artifacts);
  assertResultContract(receipt, expected.resultContract);

  const verifiedComments: ProviderComment[] = [];
  for (const artifact of receipt.artifacts) {
    if (artifact.kind === "comment") {
      verifiedComments.push(await verifyComment(artifact, expected, provider));
    }
  }

  let development: { artifact: ReceiptChangeRequest; published: NormalizedChangeRequest } | null = null;
  if (receipt.outcome === "succeeded" && expected.resultContract === "development") {
    const artifact = receipt.artifacts[0] as ReceiptChangeRequest;
    const published = await providerRead(() =>
      provider.readChangeRequest(expected.ticket, artifact.number));
    assertChange(artifact, published, expected.ticket);
    development = { artifact, published };
  }

  let reviewedChange: NormalizedChangeRequest | null = null;
  if (receipt.outcome === "succeeded" && expected.resultContract === "review") {
    const artifact = receipt.artifacts[0] as ReceiptReview;
    if (expected.pinnedHeadSha === null) invalid("review requires a pinned head SHA");
    if (artifact.headSha !== expected.pinnedHeadSha) invalid("review head SHA does not match the pinned head SHA");
    const linked = await readLinkedChange(expected, provider);
    if (linked.headSha !== expected.pinnedHeadSha) invalid("linked change request head SHA does not match the pinned head SHA");
    if (linked.state !== "open") invalid("linked change request state is not open for review");
    const published = await providerRead(() =>
      provider.readReview(expected.ticket, linked.number, artifact.id));
    assertReview(artifact, published, expected);
    reviewedChange = linked;
  }

  if (receipt.humanGate) {
    verifiedComments.push(await verifyHumanGate(receipt, expected, provider));
  }

  if (verifiedComments.length > 0 || development || reviewedChange) {
    const finalTicket = await providerRead(() => provider.readTicket(expected.ticket));
    assertTicketSnapshot(finalTicket, expected.ticket);
    assertCommentMembership(verifiedComments, finalTicket.comments);

    if (development) {
      const linked = requireLinkedChange(finalTicket, expected.ticket);
      assertChange(development.artifact, linked, expected.ticket);
      assertSameChange(linked, development.published);
    }

    if (reviewedChange) {
      const linked = requireLinkedChange(finalTicket, expected.ticket);
      assertSameChange(linked, reviewedChange);
      if (linked.state !== "open") invalid("linked change request state is not open for review");
      if (linked.headSha !== expected.pinnedHeadSha) {
        invalid("linked change request head SHA does not match the pinned head SHA");
      }
    }
  }
  return receipt;
}

async function readBoundedReceipt(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) invalid("receipt path is not a regular file");
    if (stat.size > MAX_RECEIPT_BYTES) invalid("receipt exceeds the maximum size");

    const bytes = Buffer.allocUnsafe(MAX_RECEIPT_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > MAX_RECEIPT_BYTES) invalid("receipt exceeds the maximum size");
    return bytes.subarray(0, offset).toString("utf8");
  } catch (error) {
    if (error instanceof InvalidReceiptError) throw error;
    invalid("receipt file could not be read");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  invalid("receipt file could not be read");
}

function assertUniqueArtifacts(artifacts: ReceiptArtifact[]): void {
  const identities = new Set<string>();
  const urls = new Set<string>();
  for (const artifact of artifacts) {
    const identity = artifact.kind === "change-request"
      ? `${artifact.kind}:${artifact.number}`
      : `${artifact.kind}:${artifact.id}`;
    if (identities.has(identity) || urls.has(artifact.url)) invalid("receipt contains a duplicate artifact identity");
    identities.add(identity);
    urls.add(artifact.url);
  }
}

function assertResultContract(receipt: AgentReceipt, contract: ResultContract): void {
  if (receipt.outcome === "failed") {
    if (receipt.humanGate) invalid("failed receipt cannot contain a human gate");
    if (receipt.artifacts.length > 1
      || receipt.artifacts.some((artifact) => artifact.kind !== "comment" || artifact.artifactKind !== "diagnostic")) {
      invalid("failed receipt may contain only one diagnostic artifact");
    }
    return;
  }

  if (receipt.error) invalid("non-failed receipt cannot contain an error");
  if (receipt.outcome === "needs-human") {
    if (receipt.humanGate || !isAgentContract(contract)) {
      invalid("needs-human receipt is valid only for an agent result contract");
    }
    assertOnlyComment(receipt, "question");
    return;
  }

  switch (contract) {
    case "assessment": assertOnlyComment(receipt, "assessment"); break;
    case "plan": assertOnlyComment(receipt, "plan"); break;
    case "development":
      if (receipt.humanGate
        || receipt.artifacts.length !== 1
        || receipt.artifacts[0]?.kind !== "change-request") {
        invalid("development success requires exactly one change request artifact");
      }
      break;
    case "review":
      if (receipt.humanGate
        || receipt.artifacts.length !== 1
        || receipt.artifacts[0]?.kind !== "review") {
        invalid("review success requires exactly one review artifact");
      }
      break;
    case "human-gate":
      if (!receipt.humanGate
        || receipt.artifacts.length > 1
        || receipt.artifacts.some((artifact) => artifact.kind !== "comment" || artifact.artifactKind !== "question")) {
        invalid("human-gate success requires one human gate and a valid question artifact set");
      }
      if ((receipt.humanGate.verdict === "approved"
        || receipt.humanGate.verdict === "changes-requested"
        || receipt.humanGate.verdict === "cancelled")
        ? receipt.artifacts.length !== 0
        : receipt.artifacts.length !== 1) {
        invalid("human-gate question does not match its verdict");
      }
      break;
    case "none":
      if (receipt.humanGate || receipt.artifacts.length !== 0) {
        invalid("none success cannot contain a primary artifact");
      }
      break;
  }
}

function assertOnlyComment(
  receipt: AgentReceipt,
  artifactKind: ReceiptComment["artifactKind"],
): void {
  if (receipt.humanGate
    || receipt.artifacts.length !== 1
    || receipt.artifacts[0]?.kind !== "comment"
    || receipt.artifacts[0].artifactKind !== artifactKind) {
    invalid(`${artifactKind} result requires exactly one ${artifactKind} comment artifact`);
  }
}

function isAgentContract(contract: ResultContract): boolean {
  return contract === "assessment" || contract === "plan" || contract === "development" || contract === "review";
}

async function verifyComment(
  artifact: ReceiptComment,
  expected: ReceiptExpectation,
  provider: ProviderAdapter,
): Promise<ProviderComment> {
  const expectedMarker = marker(expected, artifact.artifactKind);
  if (artifact.marker !== expectedMarker) invalid("receipt comment marker does not match its artifact kind");
  const published = await providerRead(() => provider.readComment(expected.ticket, artifact.id));
  if (published.id !== artifact.id) invalid("provider comment ID does not match the receipt");
  if (published.url !== artifact.url) invalid("provider comment URL does not match the receipt");
  const lines = published.body.split(/\r?\n/);
  if (lines[0] !== expectedMarker) invalid("provider comment marker does not match the receipt");
  if (lines[1]?.startsWith("<!-- agent-flow-review:")) {
    invalid("non-review comment contains review metadata");
  }
  return published;
}

async function readLinkedChange(
  expected: ReceiptExpectation,
  provider: ProviderAdapter,
): Promise<NormalizedChangeRequest> {
  const ticket = await providerRead(() => provider.readTicket(expected.ticket));
  assertTicketSnapshot(ticket, expected.ticket);
  return requireLinkedChange(ticket, expected.ticket);
}

function assertTicketSnapshot(snapshot: ProviderTicketSnapshot, expected: TicketRef): void {
  if (snapshot.ref.provider !== expected.provider
    || snapshot.ref.repository !== expected.repository
    || snapshot.ref.number !== expected.number) {
    invalid("provider ticket snapshot does not match the expected ticket");
  }
  if (snapshot.repository.provider !== expected.provider
    || snapshot.repository.name !== expected.repository) {
    invalid("provider repository snapshot does not match the expected ticket");
  }
}

function requireLinkedChange(
  ticket: ProviderTicketSnapshot,
  expected: TicketRef,
): NormalizedChangeRequest {
  if (!ticket.changeRequest) invalid("ticket does not have one linked change request");
  const linked = ticket.changeRequest;
  if (linked.provider !== expected.provider) invalid("linked change request provider does not match the ticket");
  if (linked.repository !== expected.repository) invalid("linked change request repository does not match the ticket");
  return linked;
}

function assertChange(
  artifact: ReceiptChangeRequest,
  published: NormalizedChangeRequest,
  expected: TicketRef,
): void {
  if (published.provider !== expected.provider) invalid("change request provider does not match the ticket");
  if (published.repository !== expected.repository) invalid("change request repository does not match the ticket");
  if (published.number !== artifact.number) invalid("change request number does not match the receipt");
  if (published.url !== artifact.url) invalid("change request URL does not match the receipt");
  if (published.headSha !== artifact.headSha) invalid("change request head SHA does not match the receipt");
  if (published.state !== artifact.state) invalid("change request state does not match the receipt");
}

function assertSameChange(left: NormalizedChangeRequest, right: NormalizedChangeRequest): void {
  if (left.provider !== right.provider
    || left.repository !== right.repository
    || left.number !== right.number
    || left.url !== right.url
    || left.headSha !== right.headSha
    || left.state !== right.state) {
    invalid("linked change request changed during receipt verification");
  }
}

function assertCommentMembership(
  verified: ProviderComment[],
  ticketComments: ProviderComment[],
): void {
  for (const comment of verified) {
    const matches = ticketComments.filter((candidate) =>
      candidate.id === comment.id
      && candidate.url === comment.url
      && candidate.body === comment.body
      && candidate.actor.login === comment.actor.login
      && candidate.actor.providerId === comment.actor.providerId
      && candidate.createdAt === comment.createdAt
      && candidate.updatedAt === comment.updatedAt);
    if (matches.length !== 1) invalid("verified comment does not belong to the expected ticket");
  }
}

function assertReview(
  artifact: ReceiptReview,
  published: Awaited<ReturnType<ProviderAdapter["readReview"]>>,
  expected: ReceiptExpectation,
): void {
  if (published.id !== artifact.id) invalid("provider review ID does not match the receipt");
  if (published.url !== artifact.url) invalid("provider review URL does not match the receipt");
  if (published.headSha !== artifact.headSha || published.headSha !== expected.pinnedHeadSha) {
    invalid("provider review head SHA does not match the pinned head SHA");
  }
  if (published.verdict !== artifact.verdict) invalid("provider review verdict does not match the receipt");

  const lines = published.body.split(/\r?\n/);
  if (lines[0] !== marker(expected, "review")) invalid("provider review marker does not match the receipt");
  const metadata = `<!-- agent-flow-review:v1 head=${artifact.headSha} verdict=${artifact.verdict} -->`;
  if (lines[1] !== metadata) invalid("provider review metadata does not match the receipt");
}

async function verifyHumanGate(
  receipt: AgentReceipt,
  expected: ReceiptExpectation,
  provider: ProviderAdapter,
): Promise<ProviderComment> {
  const gate = receipt.humanGate!;
  const source = await providerRead(() => provider.readComment(expected.ticket, gate.sourceCommentId));
  if (source.id !== gate.sourceCommentId) invalid("human-gate source comment ID does not match");
  if (source.body.split(/\r?\n/, 1)[0]?.startsWith("<!-- agent-flow:")) {
    invalid("human-gate source comment must be unmarked");
  }
  const permission = await providerRead(() => provider.permission(expected.ticket.repository, source.actor));
  if (!AUTHORIZED_PERMISSIONS.has(permission)) invalid("human-gate source actor lacks write permission");
  return source;
}

async function providerRead<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof InvalidReceiptError) throw error;
    invalid("provider publication could not be verified");
  }
}

function marker(expected: ReceiptExpectation, artifactKind: ReceiptComment["artifactKind"]): string {
  return `<!-- agent-flow:v1 flow=${expected.flowInstanceId} attempt=${expected.attemptId} artifact=${artifactKind} -->`;
}

function invalid(message: string): never {
  throw new InvalidReceiptError(message);
}
