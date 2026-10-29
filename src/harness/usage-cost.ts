import type { AttemptUsage } from "../config/types.ts";

// Reviewed 2026-10-29. USD per million tokens, standard first-party global requests <=200k context.
// Source: https://platform.claude.com/docs/en/about-claude/pricing
export const PRICING_VERSION = "2026-10-29.1";
const rates: Readonly<Record<string, readonly number[]>> = {
  "claude-haiku-4-5-20251001": [1, 5, 0.1, 1.25, 2],
  "claude-sonnet-4-6": [3, 15, 0.3, 3.75, 6],
};
export interface PriceableModel {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreation5mTokens?: number;
  cacheCreation1hTokens?: number;
  tier?: string;
  geography?: string;
  contextWindow?: number;
}

export function resolveUsageCost(usage: AttemptUsage, models: PriceableModel[]): AttemptUsage {
  if (typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) && usage.costUsd >= 0
    && usage.costSource === "harness") return usage;
  if (!models.length) return usage;
  let costUsd = 0;
  for (const model of models) {
    const rate = rates[model.model];
    const tokens = [model.inputTokens, model.outputTokens, model.cacheReadInputTokens,
      model.cacheCreation5mTokens, model.cacheCreation1hTokens];
    if (!rate || model.tier !== "standard" || model.geography !== "global"
      || !model.contextWindow || model.contextWindow > 200000
      || !tokens.every((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) return usage;
    costUsd += tokens.reduce<number>((total, value, index) => total + value! * rate[index]!, 0) / 1000000;
  }
  return Number.isFinite(costUsd) ? { ...usage, costUsd, costSource: "estimated" } : usage;
}
