import { nonnegative } from "./records";
import type { UsageCost } from "./types";

/** USD per million tokens: input, output, 5m write, 1h write, read. No runtime fetch. */
const rates: Record<string, readonly [number, number, number, number, number]> = {
  "claude-haiku-4-5": [1, 5, 1.25, 2, 0.1],
  "claude-haiku-4-5-20251001": [1, 5, 1.25, 2, 0.1],
  "claude-sonnet-4-5": [3, 15, 3.75, 6, 0.3],
  "claude-sonnet-4-5-20250929": [3, 15, 3.75, 6, 0.3],
  "claude-sonnet-4-6": [3, 15, 3.75, 6, 0.3],
  "claude-opus-4-5": [5, 25, 6.25, 10, 0.5],
  "claude-opus-4-5-20251101": [5, 25, 6.25, 10, 0.5],
  "claude-opus-4-6": [5, 25, 6.25, 10, 0.5],
  "claude-opus-4-6-20260205": [5, 25, 6.25, 10, 0.5],
  "claude-opus-4-7": [5, 25, 6.25, 10, 0.5],
  "claude-opus-4-7-20260416": [5, 25, 6.25, 10, 0.5],
  "claude-opus-4-8": [5, 25, 6.25, 10, 0.5],
  "claude-opus-5": [5, 25, 6.25, 10, 0.5],
  "claude-opus-5-5": [4, 20, 5, 8, 0.2],
  "claude-sonnet-5": [2, 10, 2.5, 4, 0.2],
  "claude-sonnet-5-5": [2, 10, 2.5, 4, 0.1],
  "claude-haiku-5-5": [0.1, 0.5, 0.125, 0.2, 0.01],
  "claude-fable-5": [10, 50, 12.5, 20, 1],
  "claude-fable-5-1": [10, 50, 12.5, 20, 0.25],
  "claude-mythos-5": [10, 50, 12.5, 20, 1],
  "claude-mythos-5-1": [10, 50, 12.5, 20, 0.25],
  "claude-mythos-preview": [10, 50, 12.5, 20, 1],
};

export const CLAUDE_PRICING_DETAIL =
  "API token costs: reported costs or model-specific LiteLLM API rates (2026-11-07).";

const rateFor = (model: string) => (Object.hasOwn(rates, model) ? rates[model] : undefined);

const optionalCount = (value: unknown) => (value === undefined ? 0 : nonnegative(value));

/**
 * ccusage auto-mode formula, not its grouped CLI output. Snapshot:
 * https://github.com/BerriAI/litellm/blob/268bc0345c53409342a6da56a96134034040aabe/model_prices_and_context_window.json
 * Unknown models/counts never inherit a guessed rate. Stored cost takes precedence in the adapter.
 */
export function estimateClaudeCost(
  model: string,
  usage: Record<string, unknown>,
): UsageCost | undefined {
  const rate = rateFor(model);
  if (!rate) return;
  const input = nonnegative(usage.input_tokens);
  const output = nonnegative(usage.output_tokens);
  const read = optionalCount(usage.cache_read_input_tokens);
  const creation = usage.cache_creation;
  if (
    creation !== undefined &&
    (!creation || typeof creation !== "object" || Array.isArray(creation))
  )
    return;
  const breakdown = creation as Record<string, unknown> | undefined;
  const hour = optionalCount(breakdown?.ephemeral_1h_input_tokens);
  const total = optionalCount(usage.cache_creation_input_tokens);
  const five = optionalCount(breakdown ? breakdown.ephemeral_5m_input_tokens : total);
  if (input === null || output === null || read === null || hour === null || five === null) return;
  if (
    usage.cache_creation_input_tokens !== undefined &&
    (total === null || (breakdown && total !== five + hour))
  )
    return;
  const amount =
    (input * rate[0] + output * rate[1] + five * rate[2] + hour * rate[3] + read * rate[4]) /
    1_000_000;
  return Number.isFinite(amount) ? { amount, currency: "USD", basis: "estimated" } : undefined;
}
