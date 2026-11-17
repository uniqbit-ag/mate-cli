import type { Runtime } from "./sessions";

/** Sidebar change actions: a skill started with a first-turn prompt. Mirrors Studio's actions. */

/** Lowercase letters, digits and hyphens, so a name can never carry shell syntax or a flag. */
export const SUBJECT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type ChangeAction = "archive" | "publish";

export const CHANGE_ACTIONS: Record<
  ChangeAction,
  { skill: string; opencode: (name: string) => string }
> = {
  archive: {
    skill: "mate-archive-change",
    opencode: (name) => `Use the mate-archive-change skill on change ${name}.`,
  },
  publish: {
    skill: "mate-publish-artifact",
    opencode: (name) => `Use the mate-publish-artifact skill to publish ${name}.`,
  },
};

/** The action's first-turn prompt, or null when `name` fails {@link SUBJECT_PATTERN}. */
export function actionPrompt(action: ChangeAction, runtime: Runtime, name: string): string | null {
  if (!SUBJECT_PATTERN.test(name)) return null;
  const { skill, opencode } = CHANGE_ACTIONS[action];
  return runtime === "claude" ? `/${skill} ${name}` : opencode(name);
}
