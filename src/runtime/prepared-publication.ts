import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateDocument } from "../config/schema-validator.ts";
import type { AgentDecision, AttemptUsage } from "../config/types.ts";
import { ProviderHttpError } from "../provider/http.ts";
import { electOwner, parsePublication, renderPublication } from "../provider/publication.ts";
import type { ProviderAdapter } from "../provider/types.ts";
import { allowedAgentEvents } from "./agent-protocol.ts";
import { assertSafeFile } from "./filesystem.ts";
import { InvalidDecisionError, type DecisionExpectation } from "./receipts.ts";
import { readUsageJson, writeUsageJson } from "./usage-records.ts";
import { usageLine } from "./usage-annotation.ts";

interface PreparedPublication {
  version: 1;
  ticket: DecisionExpectation["ticket"];
  configRevision: string;
  controllerId: string;
  flowInstanceId: string;
  attemptId: string;
  event: AgentDecision["event"];
  body: string | null;
  publicationKeys: readonly string[];
  reusableCommentIds: readonly string[];
  usage?: AttemptUsage;
  status: "ready" | "writing" | "delivered";
}

export function needsPreparedComment(expected: DecisionExpectation, event: AgentDecision["event"]): boolean {
  return ["agent-needs-human", "human-question", "human-unclear", "human-answer-unclear"].includes(event)
    || (event === "agent-succeeded" && (["assessment", "plan", "diagnostic", "verification"].includes(expected.resultContract)
      || (expected.resultContract === "development" && !!expected.migration)));
}

export async function freezePreparedPublication(root: string, expected: DecisionExpectation,
  usage: AttemptUsage | undefined): Promise<void> {
  try { await readPreparedPublication(root, expected); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let decision: AgentDecision;
  try { decision = validateDocument<AgentDecision>("AgentDecision", await readUsageJson(root, "decision.json")); }
  catch { throw new InvalidDecisionError("decision does not match the AgentDecision schema"); }
  if (!allowedAgentEvents(expected.flow, expected.stateId, expected.mode).includes(decision.event)) {
    throw new InvalidDecisionError("decision event is not allowed by the pinned flow state");
  }
  let body: string | null = null;
  if (needsPreparedComment(expected, decision.event)) {
    try {
      const path = await assertSafeFile(root, join(root, "prepared-comment.txt"), "prepared comment");
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let text: string;
      try {
        if ((await file.stat()).size > 60_000) throw new InvalidDecisionError("prepared comment is too large");
        text = (await file.readFile("utf8")).trim();
      } finally { await file.close(); }
      if (!text || /<!--\s*agent-flow/i.test(text)) throw new InvalidDecisionError("prepared comment text is invalid");
      if (expected.resultContract === "verification" && decision.event === "agent-succeeded"
        && text.split(/\r?\n/)[0] !== "BUG RECEIPT · VERIFIED") {
        throw new InvalidDecisionError("prepared verification must begin with BUG RECEIPT · VERIFIED");
      }
      const marker = renderPublication({ config: expected.configRevision, controller: expected.controllerId });
      const line = usageLine(usage);
      const resultMarker = decision.event === "agent-succeeded"
        && (["assessment", "plan", "diagnostic"].includes(expected.resultContract)
          || (expected.resultContract === "development" && !!expected.migration))
        ? `\n<!-- agent-flow-result:v1 state=${expected.stateId} -->` : "";
      body = `${marker}\n${text}${resultMarker}\n\n<!-- agent-flow-attempt:v1 attempt=${expected.attemptId} -->${line ? `\n${line}` : ""}`;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (body === null && needsPreparedComment(expected, decision.event) && !expected.reusableCommentIds?.length) {
    throw new InvalidDecisionError("final stage comment text was not prepared and no reusable result is available");
  }
  await writeUsageJson(root, "prepared-publication.json", { version: 1, ticket: expected.ticket,
    configRevision: expected.configRevision, controllerId: expected.controllerId, flowInstanceId: expected.flowInstanceId,
    attemptId: expected.attemptId, event: decision.event, body, publicationKeys: expected.publicationKeys,
    reusableCommentIds: expected.reusableCommentIds ?? [], ...(usage ? { usage } : {}), status: "ready" });
}

export async function readPreparedPublication(root: string, expected: DecisionExpectation): Promise<PreparedPublication> {
  const value = await readUsageJson(root, "prepared-publication.json") as PreparedPublication;
  if (value?.version !== 1 || !isDeepStrictEqual(value.ticket, expected.ticket)
    || value.configRevision !== expected.configRevision || value.controllerId !== expected.controllerId
    || value.flowInstanceId !== expected.flowInstanceId || value.attemptId !== expected.attemptId
    || !Array.isArray(value.publicationKeys) || value.publicationKeys.some((key) => typeof key !== "string")
    || !Array.isArray(value.reusableCommentIds) || value.reusableCommentIds.some((id) => typeof id !== "string")
    || !["ready", "writing", "delivered"].includes(value.status)
    || (value.body !== null && (typeof value.body !== "string" || value.body.length > 65_000))) {
    throw new Error("prepared publication identity is invalid");
  }
  validateDocument("AgentDecision", { event: value.event });
  if (!allowedAgentEvents(expected.flow, expected.stateId, expected.mode).includes(value.event)) {
    throw new InvalidDecisionError("retained decision is not allowed by the pinned flow state");
  }
  const decision = validateDocument<AgentDecision>("AgentDecision", await readUsageJson(root, "decision.json"));
  if (decision.event !== value.event) throw new InvalidDecisionError("prepared decision changed after completion");
  if (value.body !== null) {
    const marker = parsePublication(value.body);
    if (!needsPreparedComment(expected, value.event) || marker.kind !== "current"
      || marker.metadata.config !== expected.configRevision || marker.metadata.controller !== expected.controllerId
      || !value.body.includes(`<!-- agent-flow-attempt:v1 attempt=${expected.attemptId} -->`)) {
      throw new Error("prepared comment metadata is invalid");
    }
  }
  if (value.usage) validateDocument("AgentReceipt", { apiVersion: "agent-flow/v1alpha1", kind: "AgentReceipt",
    flowInstanceId: value.flowInstanceId, attemptId: value.attemptId, outcome: "failed", summary: "Prepared accounting.",
    artifacts: [], error: { code: "PREPARED", message: "Pending delivery." }, usage: value.usage });
  return value;
}

/** Retained completed work is delivered independently of model execution. Never edit a published comment. */
export async function deliverPreparedPublication(root: string, expected: DecisionExpectation, provider: ProviderAdapter,
  canWrite: () => boolean = () => true): Promise<AttemptUsage | undefined> {
  const value = await readPreparedPublication(root, expected);
  if (value.body === null) return value.usage;
  if (!canWrite() || provider.kind !== expected.ticket.provider) throw new Error("publication is not active");
  const ticket = await provider.readTicket(expected.ticket, expected.activationLabel);
  if (!isDeepStrictEqual(ticket.ref, expected.ticket) || !ticket.open || !ticket.activation.present) {
    throw new Error("publication ticket is not active");
  }
  const identifier = `<!-- agent-flow-attempt:v1 attempt=${expected.attemptId} -->`;
  const matches = ticket.comments.filter((comment) => comment.body.includes(identifier));
  if (matches.length > 1 || (matches.length === 1 && matches[0]!.body !== value.body)) {
    throw new Error("prepared publication evidence is ambiguous");
  }
  const owner = electOwner(ticket.comments.flatMap((comment) => {
    const marker = parsePublication(comment.body);
    if (marker.kind !== "current" || (expected.activatedAt
      && Date.parse(comment.createdAt) < Date.parse(expected.activatedAt))) return [];
    return [{ key: comment.id, createdAt: comment.createdAt, metadata: marker.metadata }];
  }));
  const migrationOwner = expected.migration?.owner;
  const retainedOwner = migrationOwner && owner
    && JSON.parse(migrationOwner.key)[3] === "comment" && JSON.parse(migrationOwner.key)[4] === owner.key
    && owner.metadata.config === migrationOwner.config;
  if (owner && (owner.metadata.controller !== expected.controllerId
    || (expected.migration ? !retainedOwner : owner.metadata.config !== expected.configRevision))) {
    throw new Error("publication ownership changed");
  }
  let comment = matches[0];
  if (!comment) {
    if (value.status !== "ready") throw new Error("uncertain publication requires provider reconciliation");
    if (!canWrite()) throw new Error("publication was cancelled");
    await writeUsageJson(root, "prepared-publication.json", { ...value, status: "writing" });
    try { comment = await provider.createComment(expected.ticket, value.body); }
    catch (error) {
      // Explicit client rejection did not create a comment. Transport/server failures remain uncertain.
      if (error instanceof ProviderHttpError && [400, 401, 403, 404, 422, 429].includes(error.status ?? 0)) {
        await writeUsageJson(root, "prepared-publication.json", value);
      }
      throw error;
    }
  }
  const readback = await provider.readComment(expected.ticket, comment.id);
  if (readback.id !== comment.id || readback.url !== comment.url || readback.body !== value.body) {
    throw new Error("prepared publication readback is uncertain");
  }
  await writeUsageJson(root, "prepared-publication.json", { ...value, status: "delivered" });
  return value.usage;
}
