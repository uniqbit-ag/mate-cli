import { findAction, type SpecActionOffer } from "@uniqbit/mate-core/studio";

import type { CompanionViewData } from "../server/views";

/** Spec offers as the view renders them: prompts rebuilt from core's action list. */
export function specOffers(data: CompanionViewData): SpecActionOffer[] {
  return (data.actions ?? []).flatMap(({ id, runAgents, copyAgents }) => {
    const action = findAction(id);
    return action ? [{ action, runAgents, copyAgents }] : [];
  });
}
