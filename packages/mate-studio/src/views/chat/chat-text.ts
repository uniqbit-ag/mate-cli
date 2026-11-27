import { getToolName, isToolUIPart, type UIMessage } from "ai";

/** Questions offered on an empty conversation; each sends as it reads. */
export const CHAT_SUGGESTIONS = [
  "Which capabilities does this companion describe?",
  "What changed in the last archived changes?",
  "Which changes are still open, and what do they plan?",
] as const;

const SUMMARY_CHARS = 80;

/** The element a question's timeline tick scrolls to. */
export const questionAnchor = (id: string) => `chat-question-${id}`;

/** `text` on one line, cut to `max` characters with an ellipsis. */
export function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** What a tool worked on: its input's first text value, one line and short (a path or a pattern). */
export function toolTarget(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const first = Object.values(input).find((value) => typeof value === "string");
  return oneLine(first ?? "", SUMMARY_CHARS);
}

/** `items` cut into runs of consecutive items with the same key, in order. */
export function runsOf<T>(items: readonly T[], key: (item: T) => string): T[][] {
  const runs: T[][] = [];
  for (const item of items) {
    const last = runs.at(-1);
    if (last && key(last[0]!) === key(item)) last.push(item);
    else runs.push([item]);
  }
  return runs;
}

/** A batch of one tool's steps, named by what they did. */
export function batchLabel(tool: string, count: number): string {
  if (tool === "read") return `Read ${count} files`;
  if (tool === "grep") return `Searched ${count} patterns`;
  if (tool === "glob") return `Listed ${count} file patterns`;
  return `${tool} ×${count}`;
}

/** One line for a folded run of steps: how many, of which tools, and how many failed. */
export function stepSummary(steps: { name: string; failed: boolean }[]): string {
  const counts = new Map<string, number>();
  for (const { name } of steps) counts.set(name, (counts.get(name) ?? 0) + 1);
  const tools = [...counts].map(([name, count]) => `${name} ${count}`).join(", ");
  const failed = steps.filter((step) => step.failed).length;
  return [`${steps.length} steps`, tools, failed ? `${failed} failed` : ""]
    .filter(Boolean)
    .join(" · ");
}

/** Bounds on what a request carries: the server replays at most 40,000 characters of history. */
const SENT_MESSAGES = 40;
const SENT_CHARS = 64_000;

/**
 * The messages a request sends: text parts only, since the server replays no tool output,
 * and the newest within the bounds, so a long conversation never outgrows the request limits.
 */
export function sentMessages(messages: UIMessage[]): UIMessage[] {
  const sent: UIMessage[] = [];
  let chars = 0;
  for (const message of messages.toReversed()) {
    const parts = message.parts.filter((part) => part.type === "text");
    if (parts.length === 0) continue;
    chars += parts.reduce((sum, part) => sum + part.text.length, 0);
    // The newest message always goes, so the server, not the window, refuses an oversized question.
    if (sent.length > 0 && (sent.length >= SENT_MESSAGES || chars > SENT_CHARS)) break;
    sent.push({ ...message, parts });
  }
  return sent.toReversed();
}

/**
 * `target` as a path inside the companion, without a leading `./`; `null` when it leads
 * outside, so it is never offered as a Vault file. `roots` are the companion's path as
 * registered and with links followed, since the agent may report either.
 */
export function companionFile(target: string, roots: readonly string[]): string | null {
  let file = target.trim().replace(/\\/g, "/");
  if (file.startsWith("/")) {
    const base = roots
      .map((root) => root.replace(/\\/g, "/").replace(/\/+$/, ""))
      .find((root) => root && file.startsWith(`${root}/`));
    if (!base) return null;
    file = file.slice(base.length + 1);
  }
  file = file.replace(/^(?:\.\/)+/, "");
  if (!file || file.split("/").some((segment) => segment === ".." || segment === "")) return null;
  return file;
}

/** The files an answer read, in the order it first read them, as paths inside the companion. */
export function readFiles(message: UIMessage, roots: readonly string[]): string[] {
  const files = new Set<string>();
  for (const part of message.parts) {
    if (!isToolUIPart(part) || getToolName(part).toLowerCase() !== "read") continue;
    if (part.state !== "output-available") continue;
    const input = part.input as { file_path?: unknown } | undefined;
    const file =
      typeof input?.file_path === "string" ? companionFile(input.file_path, roots) : null;
    if (file) files.add(file);
  }
  return [...files];
}

/** A failed request's reason: the server's `{ reason }`, or the stream's own error text. */
export function failureText(error: Error): string {
  try {
    const parsed = JSON.parse(error.message) as { reason?: unknown };
    if (typeof parsed.reason === "string") return parsed.reason;
  } catch {
    // Not a JSON body: the message is the reason.
  }
  return error.message || "the chat failed";
}
