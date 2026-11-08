import { createServerFn } from "@tanstack/react-start";
import {
  COMPANION_DIGEST_PATTERN,
  type UsageRequest,
  type UsageResponse,
} from "@uniqbit/mate-core/studio";

export function validateUsageInput(
  input: UsageRequest & { companion: string },
): UsageRequest & { companion: string } {
  if (
    !input ||
    typeof input.companion !== "string" ||
    !COMPANION_DIGEST_PATTERN.test(input.companion)
  )
    throw new Error("No registered companion was selected");
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 365)
    throw new Error("Invalid usage period");
  if (input.refresh !== undefined && typeof input.refresh !== "boolean")
    throw new Error("Invalid refresh request");
  return { companion: input.companion, days: input.days, refresh: input.refresh === true };
}

export const getUsage = createServerFn({ method: "GET" })
  .validator(validateUsageInput)
  .handler(async ({ data, context }): Promise<UsageResponse> =>
    context.studio.usage(data.companion, { days: data.days, refresh: data.refresh }),
  );
