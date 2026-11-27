import type { DynamicToolUIPart, ToolUIPart } from "ai";

export type ToolPart = ToolUIPart | DynamicToolUIPart;

/** True when a step ended without a result. */
export function stepFailed(state: ToolPart["state"]): boolean {
  return state === "output-error" || state === "output-denied";
}
