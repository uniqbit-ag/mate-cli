import { createServerFn } from "@tanstack/react-start";
import {
  COMPANION_DIGEST_PATTERN,
  FRICTION_VIEW_DAYS,
  frictionViewDays,
  type FrictionView,
  type FrictionViewDays,
} from "@uniqbit/mate-core/studio";

interface FrictionInput {
  companion: string;
  days: FrictionViewDays;
}

export function validateFrictionInput(input: FrictionInput): FrictionInput {
  if (typeof input?.companion !== "string" || !COMPANION_DIGEST_PATTERN.test(input.companion))
    throw new Error("No registered companion was selected");
  const days = frictionViewDays(input.days);
  if (!days) throw new Error(`The friction period is one of ${FRICTION_VIEW_DAYS.join(", ")} days`);
  return { companion: input.companion, days };
}

export function validateRecordingInput(input: { recording: boolean }): { recording: boolean } {
  if (typeof input?.recording !== "boolean") throw new Error("Recording is on or off");
  return { recording: input.recording };
}

export const getFriction = createServerFn({ method: "GET" })
  .validator(validateFrictionInput)
  .handler(({ data, context }): Promise<FrictionView> =>
    context.studio.friction(data.companion, { days: data.days }),
  );

/** A write by method, so core's guard asks for Studio's own page and the token; no `--writable`. */
export const setFrictionRecording = createServerFn({ method: "POST" })
  .validator(validateRecordingInput)
  .handler(({ data, context }) => context.studio.setFrictionRecording(data.recording));
