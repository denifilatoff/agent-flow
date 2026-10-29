import type { AgentReceipt, AttemptUsage, ReceiptComment } from "../config/types.ts";
import type { ProviderAdapter, TicketRef } from "../provider/types.ts";
import { parsePublication } from "../provider/publication.ts";

export function usageLine(usage: AttemptUsage | undefined): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.totalTokens !== undefined) parts.push(`${usage.totalTokens.toLocaleString("en-US")} tokens`);
  if (usage.costUsd !== undefined && usage.costSource) {
    parts.push(`$${usage.costUsd.toFixed(2)} ${usage.costSource === "estimated" ? "estimated" : "harness estimate"}`);
  }
  return parts.length ? `Usage: ${parts.join(" · ")}` : null;
}

export function usageTarget(receipt: AgentReceipt): ReceiptComment | null {
  const comments = receipt.artifacts.filter((artifact): artifact is ReceiptComment => artifact.kind === "comment");
  if (comments.length !== 1 || comments[0]!.artifactKind === "review" || !usageLine(receipt.usage)) return null;
  return comments[0]!;
}

/** Caller supplies only a controller-verified receipt and retains delivery metadata before editing. */
export async function annotateUsage(provider: ProviderAdapter, ref: TicketRef, receipt: AgentReceipt,
  canWrite: () => boolean = () => true): Promise<void> {
  const target = usageTarget(receipt);
  if (!target || provider.kind !== ref.provider || !canWrite()) return;
  const comment = await provider.readComment(ref, target.id);
  if (comment.id !== target.id || comment.url !== target.url || !comment.body.split(/\r?\n/).includes(target.marker)) return;
  const publication = parsePublication(comment.body);
  if (publication.kind !== "current" || parsePublication(target.marker).kind !== "current") return;
  const identifier = `<!-- agent-flow-usage:v1 attempt=${receipt.attemptId} -->`;
  const line = usageLine(receipt.usage)!;
  const lines = comment.body.split("\n");
  const matches = lines.flatMap((value, index) => value === identifier ? [index] : []);
  if (matches.length > 1) return;
  let body: string;
  if (matches.length) {
    const index = matches[0]!;
    if (!lines[index + 1]?.startsWith("Usage: ")) return;
    if (lines[index + 1] === line) return;
    lines[index + 1] = line; body = lines.join("\n");
  } else body = `${comment.body}\n\n${identifier}\n${line}`;
  if (!canWrite()) return;
  await provider.updateComment(ref, target.id, body);
  const readback = await provider.readComment(ref, target.id);
  if (readback.id !== target.id || readback.url !== target.url || readback.body !== body) {
    throw new Error("usage annotation readback is uncertain");
  }
}
