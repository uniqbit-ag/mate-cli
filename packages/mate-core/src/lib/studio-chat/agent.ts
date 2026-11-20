import type { UIMessage, UIMessageChunk } from "ai";

/**
 * Studio's Analysis chat behind one seam: the route and the view depend only on this, so a
 * hosted backend can replace the local Claude Code harness without changing either.
 */

export interface ChatTurnRequest {
  /** The registered Companion Repository the conversation is about. */
  companionPath: string;
  /** The whole conversation, oldest first; the last message is the person's new question. */
  messages: UIMessage[];
  /** Aborted when the client leaves, the turn times out, or Studio stops. */
  signal: AbortSignal;
  /** The agent runtime the turn runs on; Claude Code when absent. */
  harness?: ChatHarness;
  /** One of the harness's `CHAT_MODELS`; the harness's default when absent. */
  model?: ChatModel;
  /** How hard the model thinks; the model's default when absent. */
  effort?: ChatEffort;
}

/** Stable starts of the turn failures a chat credential fixes; the view offers to set one. */
export const CHAT_NO_CREDENTIAL = "Studio Chat has no Claude credential";
export const CHAT_CREDENTIAL_REJECTED = "The chat credential was rejected";
export const CHAT_NO_LOGIN = "Claude Code has no local login on this machine";

export function isCredentialFailure(text: string): boolean {
  return [CHAT_NO_CREDENTIAL, CHAT_CREDENTIAL_REJECTED, CHAT_NO_LOGIN].some((start) =>
    text.startsWith(start),
  );
}

/** Agent runtimes the chat backend can drive. */
export type ChatHarness = "claude-code" | "opencode";

/**
 * Harnesses a turn may ask for; the first is the default. OpenCode is held back: its 1.19.5
 * server loads the companion's `.opencode` plugins despite `OPENCODE_DISABLE_PROJECT_CONFIG`,
 * so its turns would not be read-only.
 */
export const CHAT_HARNESSES: readonly ChatHarness[] = ["claude-code"];

/** A model's id as its harness takes it: a Claude Code alias, or OpenCode's `provider/model`. */
export type ChatModel = string;

export interface ChatModelChoice {
  id: ChatModel;
  name: string;
  description: string;
  /** Takes no effort setting; its turns run without one. */
  effortless?: boolean;
}

export const CHAT_HARNESS_NAMES: Readonly<Record<ChatHarness, string>> = {
  "claude-code": "Claude Code",
  opencode: "OpenCode",
};

/** Each harness's models; the first is its default. */
export const CHAT_MODELS: Readonly<Record<ChatHarness, readonly ChatModelChoice[]>> = {
  "claude-code": [
    { id: "sonnet", name: "Sonnet", description: "Careful answers at a good pace" },
    { id: "opus", name: "Opus", description: "Most capable, for hard questions; slower" },
    { id: "haiku", name: "Haiku", description: "Fastest, for quick lookups", effortless: true },
  ],
  opencode: [
    {
      id: "anthropic/claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      description: "Anthropic, with ANTHROPIC_API_KEY",
    },
    {
      id: "anthropic/claude-opus-5-5",
      name: "Claude Opus 5.5",
      description: "Anthropic's most capable; slower",
    },
    {
      id: "openai/gpt-6.1-sol",
      name: "GPT-6.1 Sol",
      description: "OpenAI, with OPENAI_API_KEY or an OpenCode login",
    },
    {
      id: "google/gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      description: "Google, with GOOGLE_GENERATIVE_AI_API_KEY",
    },
  ],
};

/** The harness's model `id`; `undefined` when the harness offers no such model. */
export function chatModel(harness: ChatHarness, id: ChatModel): ChatModelChoice | undefined {
  return CHAT_MODELS[harness].find((model) => model.id === id);
}

/** Thinking effort a turn can ask for; the middle one is the default. */
export const CHAT_EFFORTS = ["low", "medium", "high"] as const;
export type ChatEffort = (typeof CHAT_EFFORTS)[number];

export interface ChatAgent {
  /** One read-only turn over the conversation; nothing is kept once it ends. */
  turn(request: ChatTurnRequest): ReadableStream<UIMessageChunk>;
}

/** Characters of earlier turns replayed into a prompt; the newest are kept. */
export const CHAT_HISTORY_BUDGET = 40_000;
const CUT_MARK = "[…] ";

/** A message's text parts joined; tool steps and other parts are not replayed. */
export function messageText(message: UIMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
}

/**
 * The prompt for a stateless turn: earlier user and assistant text as a bounded transcript,
 * newest kept within `budget`, then the new question. `null` when the last message is not a
 * question from the person.
 */
export function renderPrompt(messages: UIMessage[], budget = CHAT_HISTORY_BUDGET): string | null {
  const last = messages.at(-1);
  const question = last?.role === "user" ? messageText(last) : "";
  if (!question) return null;
  const kept = keptHistory(messages.slice(0, -1), budget);
  if (kept.length === 0) return question;
  return [
    "Earlier in this conversation (oldest first; older turns may be left out):",
    "<conversation>",
    kept.join("\n\n"),
    "</conversation>",
    "",
    "The new question:",
    question,
  ].join("\n");
}

/** Characters of `messages` the next question replays, out of `CHAT_HISTORY_BUDGET`. */
export function replayedChars(messages: UIMessage[]): number {
  return keptHistory(messages, CHAT_HISTORY_BUDGET).reduce((sum, entry) => sum + entry.length, 0);
}

/** The user and assistant text of `history` as transcript entries, oldest first, newest kept within `budget`. */
function keptHistory(history: UIMessage[], budget: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const message of history.toReversed()) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = messageText(message);
    if (!text) continue;
    const label = `${message.role === "user" ? "User" : "Assistant"}: `;
    const entry = `${label}${text}`;
    if (used + entry.length > budget) {
      // Cut, not dropped: one long answer must not remove the whole history. Its end is
      // kept, being nearest the new question.
      const room = budget - used - label.length - CUT_MARK.length;
      if (room > 0) kept.push(`${label}${CUT_MARK}${text.slice(-room)}`);
      break;
    }
    kept.push(entry);
    used += entry.length;
  }
  return kept.toReversed();
}
