import path from "node:path";

import type { Context } from "@opencode/plugin/promise/plugin";

import {
  checkoutRootOf,
  isLinkedWorktreeOf,
  mainCheckoutOf,
  readGitLayout,
} from "../runtime/git-layout";
import { realPathOrNull as realPath } from "../runtime/physical-path";
import { companionLinkPath } from "../runtime/repo-local";
import type { CompanionContext } from "./companion-policy";
import { eventDirectory, openCodeRegisterDeps, type SessionEvent } from "./session-register";

export const ENTER_WORKTREE_TOOL = "mate_enter_worktree";
export const EXIT_WORKTREE_TOOL = "mate_exit_worktree";

/**
 * Why the session may not move into `target`, or null when `target` is a linked worktree
 * of the session's Working Repository whose Repository Link names the session's companion.
 */
export function enterWorktreeRefusal(context: CompanionContext, target: string): string | null {
  if (!context.repositoryPath) return "this session has no Working Repository";
  if (!path.isAbsolute(target)) return `${target} is not an absolute path`;
  const worktree = realPath(target);
  if (!worktree) return `${target} does not exist`;
  if (!isLinkedWorktreeOf(worktree, context.repositoryPath)) {
    // No `.git` of its own: a folder inside a checkout, not its root.
    return readGitLayout(worktree)
      ? `${target} is not a linked worktree of ${context.repositoryPath}`
      : `${target} is not the root of a Git worktree`;
  }
  const linked = realPath(companionLinkPath(worktree));
  if (!linked || linked !== realPath(context.companionPath)) {
    return `${target} is not linked to the companion ${context.companionPath}`;
  }
  return null;
}

interface FollowState {
  /** The worktree a session entered last. */
  followed: string | null;
  /** Sessions moved by following, with the worktree their note names. */
  notes: Map<string, string>;
  /** Follow moves in flight; a session's first request waits for its move. */
  moving: Map<string, Promise<void>>;
}

/**
 * Per main checkout, shared by the plugin's instances: OpenCode sets the plugin up once per
 * location, and a session's later tool calls run in its worktree's instance. Kept on
 * `globalThis` so a module loaded again in the same process shares it.
 */
const states: Map<string, FollowState> = ((globalThis as Record<symbol, unknown>)[
  Symbol.for("mate.opencode.followStates")
] ??= new Map<string, FollowState>()) as Map<string, FollowState>;

function stateOf(mainCheckout: string): FollowState {
  let state = states.get(mainCheckout);
  if (!state) {
    state = { followed: null, notes: new Map(), moving: new Map() };
    states.set(mainCheckout, state);
  }
  return state;
}

interface SystemText {
  type?: string;
  text?: string;
}

function followedNote(worktree: string, frameworkName: string): string {
  return `${frameworkName}: this session was moved into the worktree ${worktree}, the last one a session of this OpenCode server entered; it is the Working Repository. \`${EXIT_WORKTREE_TOOL}\` returns to the main checkout.`;
}

/** Appends to the last text part: the companion prompt keeps the system prompt one entry. */
function appendSystemNote(system: unknown[], note: string): void {
  const parts = system as SystemText[];
  if (parts.some((part) => part?.text?.includes(note))) return;
  const last = parts.at(-1);
  if (last?.type === "text" && typeof last.text === "string") last.text = `${last.text}\n\n${note}`;
  else system.push({ type: "text", text: note });
}

export interface EnterWorktreeDeps {
  /** Registered sessions were started by an editor in a directory it chose; they never follow. */
  registered: (sessionID: string) => Promise<boolean>;
}

/**
 * Registers `mate_enter_worktree` and `mate_exit_worktree`, which move the calling session
 * through the plugin's own client, which talks to the server that owns it. New root sessions
 * created in the main checkout follow the last entered worktree, held in memory only.
 * Returns the cleanup that ends the event subscription.
 */
export async function registerEnterWorktree(
  api: Context,
  context: CompanionContext,
  deps: EnterWorktreeDeps = { registered: openCodeRegisterDeps.registered },
): Promise<() => void> {
  const mainCheckout = context.repositoryPath ? mainCheckoutOf(context.repositoryPath) : null;
  const state = mainCheckout ? stateOf(mainCheckout) : null;

  await api.tool.transform((editor) => {
    editor.add({
      name: ENTER_WORKTREE_TOOL,
      description: `Move this session into a linked Git worktree of the Working Repository that ${context.frameworkName} created, such as the path \`${context.frameworkName} working worktree --enter\` reports. Later tool calls run there, and new sessions follow until \`${EXIT_WORKTREE_TOOL}\`.`,
      input: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path of the worktree." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      async execute(input, tool) {
        const target = (input as { path?: unknown } | undefined)?.path;
        const refusal =
          typeof target === "string"
            ? enterWorktreeRefusal(context, target)
            : "the path must be a string";
        if (refusal) {
          return {
            content: `Refused: ${refusal}. The session stays in ${context.repositoryPath}.`,
            metadata: { moved: false },
          };
        }
        const directory = realPath(target as string)!;
        await api.session.move({ sessionID: tool.sessionID, directory: directory as never });
        if (state) {
          state.followed = directory;
          state.notes.delete(tool.sessionID);
        }
        return {
          content: `Moved this session to ${directory}; it is now the Working Repository.`,
          metadata: { moved: true, directory },
        };
      },
    });
    editor.add({
      name: EXIT_WORKTREE_TOOL,
      description: `Move this session from a linked Git worktree back to the Working Repository's main checkout; new sessions stop following the worktree. The worktree stays.`,
      input: { type: "object", properties: {}, additionalProperties: false },
      async execute(_input, tool) {
        if (!mainCheckout || !state) {
          return {
            content: "Refused: this session has no Working Repository.",
            metadata: { moved: false },
          };
        }
        // Forget first: a failed lookup must still stop new sessions following.
        state.followed = null;
        state.notes.delete(tool.sessionID);
        const session = await api.session.get({ sessionID: tool.sessionID as never });
        const current = checkoutRootOf(session.location.directory);
        if (!current || !isLinkedWorktreeOf(current, mainCheckout)) {
          return {
            content: `This session is not in a linked worktree; it stays in ${session.location.directory}. New sessions no longer follow a worktree.`,
            metadata: { moved: false },
          };
        }
        await api.session.move({ sessionID: tool.sessionID, directory: mainCheckout as never });
        return {
          content: `Moved this session to ${mainCheckout}; it is now the Working Repository. ${current} stays.`,
          metadata: { moved: true, directory: mainCheckout },
        };
      },
    });
  });

  if (!mainCheckout || !state) return () => {};

  await api.session.hook("context", async (event) => {
    await state.moving.get(event.sessionID);
    const worktree = state.notes.get(event.sessionID);
    if (!worktree) return;
    const session = await api.session.get({ sessionID: event.sessionID }).catch(() => null);
    if (!session) return;
    // Left the worktree some other way, or the worktree is gone.
    if (checkoutRootOf(session.location.directory) !== worktree) {
      state.notes.delete(event.sessionID);
      return;
    }
    appendSystemNote(event.system, followedNote(worktree, context.frameworkName));
  });

  const follow = async (id: string) => {
    const worktree = state.followed;
    if (!worktree) return;
    if (enterWorktreeRefusal(context, worktree)) {
      if (state.followed === worktree) state.followed = null;
      return;
    }
    if (await deps.registered(id).catch(() => true)) return;
    // An exit or another enter during the lookup wins.
    if (state.followed !== worktree) return;
    await api.session.move({ sessionID: id as never, directory: worktree as never });
    state.notes.set(id, worktree);
  };

  /**
   * Only instances in the main checkout follow, each for sessions created at its own location,
   * so a server-wide stream moves a session once.
   */
  const location = realPath(api.location.directory);
  if (!location || checkoutRootOf(location) !== mainCheckout) return () => {};
  const controller = new AbortController();
  void (async () => {
    try {
      for await (const raw of api.event.subscribe({ signal: controller.signal })) {
        const event = raw as SessionEvent;
        const id = event.data?.sessionID;
        if (!id) continue;
        if (event.type === "session.created") {
          if (!state.followed || event.data?.parentID) continue;
          const directory = eventDirectory(event);
          if (!directory || realPath(directory) !== location) continue;
          // Not awaited: a slow move must not hold up later events.
          state.moving.set(
            id,
            follow(id)
              .catch(() => undefined)
              .finally(() => state.moving.delete(id)),
          );
        } else if (event.type === "session.deleted") {
          state.notes.delete(id);
        }
      }
    } catch {
      /* subscription closed: the location is shutting down */
    }
  })();

  return () => controller.abort();
}
