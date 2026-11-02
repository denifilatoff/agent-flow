import type { AttemptUsage } from "../config/types.ts";

export function usageLine(usage: AttemptUsage | undefined): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.totalTokens !== undefined) parts.push(`${usage.totalTokens.toLocaleString("en-US")} tokens`);
  if (usage.costUsd !== undefined && usage.costSource) {
    const amount = usage.costUsd > 0 && usage.costUsd < 0.01 ? "<$0.01" : `$${usage.costUsd.toFixed(2)}`;
    parts.push(`${amount} ${usage.costSource === "estimated" ? "estimated" : "harness estimate"}`);
  } else if (usage.costError) {
    parts.push("cost unavailable");
  }
  return parts.length ? `Usage: ${parts.join(" · ")}` : null;
}
