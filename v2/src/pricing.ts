import type { Usage } from './types.ts';

/** USD per million tokens. Anthropic first-party list prices; override in config when they change. */
export interface ModelPrice { input: number; output: number; cacheRead: number; cacheWrite: number }

export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
};

export function estimateCostUsd(
  model: string,
  usage: Pick<Usage, 'inputTokens' | 'cachedInputTokens' | 'cacheCreationTokens' | 'outputTokens'>,
  prices: Record<string, ModelPrice> = DEFAULT_PRICES,
): number | null {
  const price = prices[model];
  if (!price) return null;
  const perTok = (n: number, usdPerM: number) => (n * usdPerM) / 1_000_000;
  const total = perTok(usage.inputTokens, price.input) + perTok(usage.cachedInputTokens, price.cacheRead)
    + perTok(usage.cacheCreationTokens, price.cacheWrite) + perTok(usage.outputTokens, price.output);
  return Math.round(total * 1e6) / 1e6;
}

export interface ReviewBudget { maxInputTokens: number; maxOutputTokens: number; maxCostUsd: number }

/** The reason a running review must stop now, or null while it is within budget. Checked after every model call. */
export function overBudget(usage: Usage, budget: ReviewBudget): string | null {
  // New text only. A tool loop re-reads the whole conversation from cache on every turn; counting those re-reads
  // stopped ordinary reviews at about twenty turns. Their cost is real but small, and maxCostUsd bounds it.
  const input = usage.inputTokens + usage.cacheCreationTokens;
  if (input > budget.maxInputTokens) return `new input tokens ${input} exceed the review budget of ${budget.maxInputTokens}`;
  if (usage.outputTokens > budget.maxOutputTokens) return `output tokens ${usage.outputTokens} exceed the review budget of ${budget.maxOutputTokens}`;
  if (usage.estimatedCostUsd !== null && usage.estimatedCostUsd > budget.maxCostUsd) {
    return `estimated cost $${usage.estimatedCostUsd.toFixed(2)} exceeds the review budget of $${budget.maxCostUsd.toFixed(2)}`;
  }
  return null;
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, toolCalls: 0, modelCalls: 0, wallMs: 0, estimatedCostUsd: null });
