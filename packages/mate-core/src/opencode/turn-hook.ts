/**
 * The turn hook in OpenCode: notes the step a prompt or the `skill` tool starts and each
 * `mate workflow done` the shell tool runs, and when a turn succeeds decides as the Claude
 * `Stop` hook does. Where that hook blocks, it sends the session one synthetic message and
 * resumes it. Records nothing; any failure leaves the session alone.
 */
import fs from "node:fs";
import path from "node:path";

import type { Context } from "@opencode/plugin/promise/plugin";

import { changesDirOf, isChangeName } from "../lib/change-layout";
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
import { readWorkflow, submitType, type Workflow } from "../runtime/workflow/declaration";
import { templateRoot } from "../runtime/workflow/globs";

// The plugin entry reaches mate-core only through `runtime/` and `opencode/`.
export { spawnNextHandoff } from "../runtime/workflow/next-handoff-process";

export const HANDOFF_CHECK = "Mate hand-off check";

export interface TurnHookDeps {
  companionPath: string;
  nextHandoff: NextHandoff;
  workflow?: (companionPath: string) => Workflow | null;
  /** Whether `name` is a change folder of the companion; of the type submit handles by default. */
  isChange?: (name: string) => boolean;
  env?: Record<string, string | undefined>;
}

/** A session's turn; a new prompt replaces it, which is how a running check sees one. */
interface SessionTurn {
  turn: Turn;
  prompt: string;
  sentBack: boolean;
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

/** Whether `name` has a change folder of the type `workflow`'s submit handles. */
function changeFolderExists(companionPath: string, workflow: Workflow | null, name: string) {
  if (!isChangeName(name)) return false;
  const declared = workflow ? submitType(workflow) : undefined;
  const dir = declared
    ? path.join(companionPath, ...templateRoot(declared.change).split("/"), name)
    : path.join(changesDirOf(companionPath), name);
  return fs.existsSync(dir);
}

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
  const workflow =
    deps.workflow ??
    ((companion: string) => {
      const read = readWorkflow(companion);
      return read.ok ? read.workflow : null;
    });
  const isChange =
    deps.isChange ??
    ((name: string) => changeFolderExists(deps.companionPath, workflow(deps.companionPath), name));

  const turns = new Map<string, SessionTurn>();
  /** Undelivered user prompts per session. */
  const queued = new Map<string, Set<string>>();

  await api.session.hook("prompt", (event) => {
    const prompt = promptText(event.prompt);
    turns.set(event.sessionID, { turn: startTurn(prompt), prompt, sentBack: false });
  });

  await api.tool.hook("execute.after", (event) => {
    const entry = turns.get(event.sessionID);
    if (!entry || event.status !== "completed") return;
    const input = record(event.input);
    if (SHELL_TOOLS.has(event.tool)) {
      entry.turn = noteShell(entry.turn, text(input.command));
    } else if (event.tool === "skill") {
      // The tool takes no arguments: the change is the prompt's first word naming one.
      const skill = text(input.id).split(":").at(-1) ?? "";
      const change = entry.prompt.split(/[\s"'`]+/).find((word) => word && isChange(word)) ?? "";
      entry.turn = noteSkill(entry.turn, skill, change);
    }
  });

  const check = async (sessionID: string) => {
    const entry = turns.get(sessionID);
    if (!entry) return;
    // A prompt sent meanwhile started a new turn, which is checked when it ends.
    const finish = () => {
      if (turns.get(sessionID) === entry) turns.delete(sessionID);
    };
    const { turn } = entry;
    const declared = workflow(deps.companionPath);
    if (!declared || (!turn.step && turn.reports.length === 0)) return finish();
    // One plugin instance per session, never a subagent's.
    const session = await api.session.get({ sessionID });
    if (session.parentID || session.location?.directory !== directory) return finish();
    const verdict = await finishTurn(turn, {
      workflow: declared,
      again: entry.sentBack,
      runtime: "opencode",
      response: async () =>
        turnResponse((await api.session.context({ sessionID })) as unknown as ContextMessage[]),
      fetchHandoff: async (query) => deps.nextHandoff(query.change, directory, query.after),
    });
    if (verdict.kind !== "sendBack") return finish();
    // Read now, not when the turn ended: the check runs beside the event loop.
    if ((queued.get(sessionID)?.size ?? 0) > 0 || turns.get(sessionID) !== entry) return;
    entry.sentBack = true;
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
