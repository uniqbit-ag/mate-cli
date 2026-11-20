import type { StudioWorkCard, WorkActionId, WorkBucket } from "@uniqbit/mate-core/studio";

/** Labels of the actions a card offers, in the order they are shown. */
export const ACTION_LABELS: Partial<Record<WorkActionId, string>> = {
  share: "Share",
  claim: "Claim",
  "start-manual": "Continue manually",
  dispatch: "Start in local factory",
  release: "Release",
  park: "Park proposal",
  "move-to-later": "Move to later",
};

/** Accepted actions only; a refused one names its reason in the card's notes instead. */
export function acceptedActions(card: StudioWorkCard): WorkActionId[] {
  return (Object.keys(ACTION_LABELS) as WorkActionId[]).filter(
    (action) => card.actions[action] === null,
  );
}

/** A drop's action: the button it stands for, confirmed in the same dialog. */
export type DropAction = Extract<
  WorkActionId,
  "share" | "release" | "claim" | "park" | "move-to-later"
>;

/**
 * Where a card may be dropped and what each drop asks for: Remote work shares it (or releases
 * your claim), Local work claims it, Scratchpad parks a factory start. Accepted actions only.
 */
export function dropTargetsOf(card: StudioWorkCard): Partial<Record<WorkBucket, DropAction>> {
  const first = (...actions: DropAction[]) =>
    actions.find((action) => card.actions[action] === null);
  const targets: Partial<Record<WorkBucket, DropAction>> = {};
  if (card.bucket === "local") {
    const remote = card.claim.kind === "mine" ? first("release") : first("share");
    if (remote) targets.remote = remote;
  }
  if (card.bucket === "remote" && first("claim")) targets.local = "claim";
  if (card.bucket !== "scratchpad") {
    const later = first("park", "move-to-later");
    if (later) targets.scratchpad = later;
  }
  return targets;
}

/** A drop's action in words, completing "Drop to …". */
export const DROP_VERBS: Record<DropAction, string> = {
  share: "share it",
  release: "release your claim",
  claim: "claim it",
  park: "park its proposal",
  "move-to-later": "move it to later",
};
