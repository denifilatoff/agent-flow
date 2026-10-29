import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateDocument } from "../config/schema-validator.ts";
import type { AgentReceipt } from "../config/types.ts";
import type { ProviderAdapter, TicketRef } from "../provider/types.ts";
import { parsePublication } from "../provider/publication.ts";
import { assertCanonicalUuid, assertSafeDirectory } from "./filesystem.ts";
import { annotateUsage, usageTarget } from "./usage-annotation.ts";
import { readUsageJson, writeUsageJson } from "./usage-records.ts";

interface Delivery {
  version: 1; controllerId: string; ticket: TicketRef; attemptId: string; commentId: string;
  status: "pending" | "delivered";
}
const cursors = new Map<string, number>();

export async function queueUsageDelivery(root: string, ticket: TicketRef, controllerId: string,
  receipt: AgentReceipt): Promise<boolean> {
  const target = usageTarget(receipt);
  if (!target) return false;
  const marker = parsePublication(target.marker);
  if (marker.kind !== "current" || marker.metadata.controller !== controllerId) return false;
  const delivery: Delivery = { version: 1, controllerId, ticket, attemptId: receipt.attemptId,
    commentId: target.id, status: "pending" };
  await writeUsageJson(root, "usage-delivery.json", delivery);
  return true;
}

export async function deliverUsageRecord(root: string, ref: TicketRef, controllerId: string,
  flowId: string, attemptId: string, provider: ProviderAdapter, canWrite: () => boolean = () => true): Promise<void> {
  if (!canWrite()) return;
  const pending = await readUsageJson(root, "usage-delivery.json") as Delivery;
  if (pending?.version !== 1 || pending.status !== "pending" || pending.controllerId !== controllerId
    || pending.attemptId !== attemptId || !isDeepStrictEqual(pending.ticket, ref)) return;
  const receipt = validateDocument<AgentReceipt>("AgentReceipt", await readUsageJson(root, "receipt.json"));
  if (receipt.attemptId !== attemptId || receipt.flowInstanceId !== flowId) return;
  const target = usageTarget(receipt);
  if (!target || pending.commentId !== target.id) return;
  const marker = parsePublication(target.marker);
  if (marker.kind !== "current" || marker.metadata.controller !== controllerId) return;
  await annotateUsage(provider, ref, receipt, canWrite);
  if (canWrite()) await writeUsageJson(root, "usage-delivery.json", { ...pending, status: "delivered" });
}

/** Disposable delivery work is independent of stage outcome and never launches a harness. */
export async function retryUsageDeliveries(data: string, ref: TicketRef, controllerId: string,
  flowId: string, provider: ProviderAdapter, canWrite: () => boolean = () => true): Promise<void> {
  if (!canWrite()) return;
  assertCanonicalUuid(flowId, "usage flow ID");
  const directory = await assertSafeDirectory(data, join(data, "sessions", flowId), "usage flow sessions");
  const names: string[] = [];
  for await (const entry of await opendir(directory)) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) names.push(entry.name);
    if (names.length >= 4096) break;
  }
  names.sort();
  const start = (cursors.get(directory) ?? 0) % Math.max(1, names.length);
  const limit = Math.min(32, names.length);
  for (let offset = 0; offset < limit && canWrite(); offset++) {
    const name = names[(start + offset) % names.length]!;
    try {
      assertCanonicalUuid(name, "usage attempt ID");
      const root = await assertSafeDirectory(data, join(directory, name), "usage attempt session");
      await deliverUsageRecord(root, ref, controllerId, flowId, name, provider, canWrite);
    } catch { /* Missing, malformed and transient telemetry cannot block reconciliation. */ }
  }
  cursors.set(directory, start + limit);
}
