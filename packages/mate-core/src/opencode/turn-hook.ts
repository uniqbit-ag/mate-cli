/**
 * The turn hook in OpenCode: notes the step a prompt or the `skill` tool starts and each
 * `mate workflow done` the shell tool runs, and when a turn succeeds decides as the Claude
 * `Stop` hook does. Where that hook blocks, it sends the session one synthetic message and
 * resumes it. Records nothing; any failure leaves the session alone.
 */
import type { Context } from "@opencode/plugin/promise/plugin";

import { changeFolderNames, changeFolders } from "../runtime/workflow/change-folders";
import type { NextHandoff } from "../runtime/workflow/next-handoff-process";
import {
  finishTurn,
  noteShell,
  noteSkill,
  startTurn,
  turnHooksEnabled,
  type Turn,
} from "../runtime/workflow/turn";
import { record, text } from "../runtime/json-fields";
import {
  defaultWorkflow,
  readWorkflow,
  type WorkflowVerdict,
} from "../runtime/workflow/declaration";

// The plugin entry reaches mate-core only through `runtime/` and `opencode/`.
export { spawnNextHandoff } from "../runtime/workflow/next-handoff-process";

export const HANDOFF_CHECK = "Mate hand-off check";

export interface TurnHookDeps {
  companionPath: string;
  nextHandoff: NextHandoff;
  readWorkflow?: (companionPath: string) => WorkflowVerdict;
  /** The names of the companion's change folders; as `mate workflow next` finds them by default. */
  workNames?: () => Promise<string[]>;
  env?: Record<string, string | undefined>;
}

/** A session's turn; a new prompt replaces it, which is how a running check sees one. */
interface SessionTurn {
  turn: Turn;
  prompt: string;
  sentBack: boolean;
  /** The tool notes still being taken; a note that fails is dropped. */
  noting: Promise<void>;
  /** The workflow declaration, read once per turn when first needed; a send-back reads it again. */
  declared?: WorkflowVerdict;
}

interface TurnEvent {
  type?: string;
  data?: {
    sessionID?: string;
    inboxID?: string;
    item?: { type?: string };
  };
}

interface ContextMessage {
  type?: string;
  content?: { type?: string; text?: unknown }[];
}

const SHELL_TOOLS = new Set(["shell", "bash"]);

/** The text a prompt carries; OpenCode quotes a `run` message. */
function promptText(prompt: unknown): string {
  return text(record(prompt).text).replace(/^"([\s\S]*)"$/, "$1");
}

/** The assistant text after the last user or synthetic message: the finished turn's response. */
export function turnResponse(messages: readonly ContextMessage[]): string {
  const start = messages.findLastIndex((m) => m.type === "user" || m.type === "synthetic");
  return messages
    .slice(start + 1)
    .filter((m) => m.type === "assistant")
    .flatMap((m) => (m.content ?? []).filter((part) => part.type === "text"))
    .map((part) => text(part.text))
    .join("\n");
}

/**
 * Registers the turn hook; returns the cleanup that ends its event subscription. Hooks fire for
 * this location's sessions only, so only a session with noted state is ever checked.
 */
export async function registerTurnHook(api: Context, deps: TurnHookDeps): Promise<() => void> {
  const env = deps.env ?? process.env;
  if (!turnHooksEnabled(env)) return () => {};
  const directory = api.location.directory;
  const read = deps.readWorkflow ?? readWorkflow;
  const declaredFor = (entry: SessionTurn) => (entry.declared ??= read(deps.companionPath));
  const workNames = (entry: SessionTurn): Promise<string[]> => {
    if (deps.workNames) return deps.workNames();
    const declared = declaredFor(entry);
    const folders = changeFolders(declared.ok ? declared.workflow : defaultWorkflow());
    return changeFolderNames(deps.companionPath, folders);
  };

  const turns = new Map<string, SessionTurn>();
  /** Undelivered user prompts per session. */
  const queued = new Map<string, Set<string>>();

  await api.session.hook("prompt", (event) => {
    const prompt = promptText(event.prompt);
    turns.set(event.sessionID, {
      turn: startTurn(prompt),
      prompt,
      sentBack: false,
      noting: Promise.resolve(),
    });
  });

  /** The first word of `prompt` naming existing work; empty when none does. */
  const changeIn = async (entry: SessionTurn): Promise<string> => {
    const names = new Set(await workNames(entry));
    return entry.prompt.split(/[\s"'`]+/).find((word) => word && names.has(word)) ?? "";
  };

  await api.tool.hook("execute.after", async (event) => {
    const entry = turns.get(event.sessionID);
    if (!entry || event.status !== "completed") return;
    const input = record(event.input);
    // Chained, so notes keep the tools' order and the turn's check waits for them.
    entry.noting = entry.noting
      .then(async () => {
        if (SHELL_TOOLS.has(event.tool)) {
          entry.turn = noteShell(entry.turn, text(input.command));
        } else if (event.tool === "skill") {
          // The tool takes no arguments: the change is the prompt's first word naming one.
          const skill = text(input.id).split(":").at(-1) ?? "";
          entry.turn = noteSkill(entry.turn, skill, await changeIn(entry));
        }
      })
      .catch(() => {});
    await entry.noting;
  });

  const check = async (sessionID: string) => {
    const entry = turns.get(sessionID);
    if (!entry) return;
    // A prompt sent meanwhile started a new turn, which is checked when it ends.
    const finish = () => {
      if (turns.get(sessionID) === entry) turns.delete(sessionID);
    };
    await entry.noting;
    const verdict = await finishTurn(
      entry.turn,
      {
        companionPath: deps.companionPath,
        again: entry.sentBack,
        runtime: "opencode",
        response: async () =>
          turnResponse((await api.session.context({ sessionID })) as unknown as ContextMessage[]),
        fetchHandoff: async (query) => deps.nextHandoff(query.change, directory, query.after),
        // One plugin instance per session, never a subagent's.
        judges: async () => {
          const session = await api.session.get({ sessionID });
          return !session.parentID && session.location?.directory === directory;
        },
      },
      { readWorkflow: () => declaredFor(entry) },
    );
    if (verdict.kind !== "sendBack") return finish();
    // Read now, not when the turn ended: the check runs beside the event loop.
    if ((queued.get(sessionID)?.size ?? 0) > 0 || turns.get(sessionID) !== entry) return;
    entry.sentBack = true;
    entry.declared = undefined;
    await api.session.synthetic({
      sessionID,
      text: verdict.reason,
      description: HANDOFF_CHECK,
      resume: true,
    });
  };

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const raw of api.event.subscribe({ signal: controller.signal })) {
        const event = raw as TurnEvent;
        const id = event.data?.sessionID;
        if (!id) continue;
        if (event.type === "session.inbox.enqueued" && event.data?.item?.type === "user") {
          const inbox = event.data.inboxID;
          if (inbox) queued.set(id, (queued.get(id) ?? new Set()).add(inbox));
        } else if (event.type === "session.inbox.delivered" && event.data?.inboxID) {
          queued.get(id)?.delete(event.data.inboxID);
        } else if (event.type === "session.execution.succeeded") {
          // Not awaited: a prompt queued while `mate workflow next` runs must still be seen.
          void check(id).catch(() => {});
        } else if (
          event.type?.startsWith("session.execution.") &&
          event.type !== "session.execution.started"
        ) {
          // A failed or interrupted turn is the user's to handle.
          turns.delete(id);
        } else if (event.type === "session.deleted") {
          turns.delete(id);
          queued.delete(id);
        }
      }
    } catch {
      /* subscription closed: the location is shutting down */
    }
  })();
  return () => controller.abort();
}
