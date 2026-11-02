import type { AttemptUsage } from "../config/types.ts";

export function usageLine(usage: AttemptUsage | undefined): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.totalTokens !== undefined) parts.push(`${usage.totalTokens.toLocaleString("en-US")} tokens`);
  if (usage.costUsd !== undefined && usage.costSource) {
    parts.push(`$${usage.costUsd.toFixed(2)} ${usage.costSource === "estimated" ? "estimated" : "harness estimate"}`);
  }
  return parts.length ? `Usage: ${parts.join(" · ")}` : null;
}
