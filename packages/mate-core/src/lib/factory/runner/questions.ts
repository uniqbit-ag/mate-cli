import type { RunState } from "./state";

// Kept free of Node modules, so Studio's browser code can read a run's questions.

/** One question the agent asked, with the choices it offered. */
export interface AgentQuestion {
  question: string;
  /** Choices the agent offered, if the answer is one of a few. */
  options?: string[];
  /** The choice the agent would take. */
  recommended?: string;
}

/**
 * A waiting state's questions; a state written before questions were grouped holds one
 * question in its own fields.
 */
export function questionsOf(state: Extract<RunState, { state: "waiting" }>): AgentQuestion[] {
  if (Array.isArray(state.questions) && state.questions.length > 0) return state.questions;
  const single = state as unknown as AgentQuestion;
  return typeof single.question === "string" ? [single] : [];
}
