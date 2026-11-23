import { createServerFn } from "@tanstack/react-start";
import {
  COMPANION_DIGEST_PATTERN,
  FRICTION_VIEW_DAYS,
  frictionViewDays,
  MARK_STATES,
  type FrictionMarkResult,
  type FrictionView,
  type FrictionViewDays,
  type MarkState,
} from "@uniqbit/mate-core/studio";

import { oneOf } from "../lib/search";

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

export const getFrictionRecording = createServerFn({ method: "GET" }).handler(
  ({ context }): Promise<{ recording: boolean }> => context.studio.frictionRecording(),
);

export const setFrictionRecording = createServerFn({ method: "POST" })
  .validator(validateRecordingInput)
  .handler(({ data, context }) => context.studio.setFrictionRecording(data.recording));

export interface FrictionMarkInput {
  /** A fingerprint or a Free Report's id. */
  target: string;
  state: MarkState;
  note?: string;
  link?: string;
}

const optionalText = (value: unknown, name: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`The ${name} is text`);
  return value;
};

function validateMarkInput(input: FrictionMarkInput): FrictionMarkInput {
  if (typeof input?.target !== "string" || input.target === "")
    throw new Error("A mark names a fingerprint or a report");
  const state = oneOf(MARK_STATES, input.state);
  if (!state) throw new Error(`A mark sets one of ${MARK_STATES.join(", ")}`);
  return {
    target: input.target,
    state,
    note: optionalText(input.note, "note"),
    link: optionalText(input.link, "link"),
  };
}

export const markFriction = createServerFn({ method: "POST" })
  .validator(validateMarkInput)
  .handler(({ data, context }): Promise<FrictionMarkResult> =>
    context.studio.markFriction(data.target, data.state, { note: data.note, link: data.link }),
  );
