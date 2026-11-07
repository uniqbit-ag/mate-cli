import fs from "node:fs";
import path from "node:path";

import type { Context } from "@opencode/plugin/promise/plugin";
import { parse } from "yaml";

import {
  checkoutRootOf,
  isLinkedWorktreeOf,
  mainCheckoutOf,
  readGitLayout,
} from "../runtime/git-layout";
import { realPathOrNull as realPath } from "../runtime/physical-path";
import { companionLinkPath, repoLocalRegistryPath } from "../runtime/repo-local";
import {
  mirroredUmbrellaOf,
  umbrellaFolderOf,
  umbrellaMirroredBy,
} from "../runtime/umbrella-folder";
import type { CompanionContext } from "./companion-policy";
import { eventDirectory, openCodeRegisterDeps, type SessionEvent } from "./session-register";

export const ENTER_WORKTREE_TOOL = "mate_enter_worktree";
export const EXIT_WORKTREE_TOOL = "mate_exit_worktree";

/**
 * Why the session may not move into `target`, or null when `target` is a linked worktree
 * of the session's Working Repository, or its Umbrella Repository's mirrored worktree,
 * whose Repository Link names the session's companion.
 */
export function enterWorktreeRefusal(context: CompanionContext, target: string): string | null {
  if (!context.repositoryPath) return "this session has no Working Repository";
  if (!path.isAbsolute(target)) return `${target} is not an absolute path`;
  const worktree = realPath(target);
  if (!worktree) return `${target} does not exist`;
  if (umbrellaFolderOf(worktree) === worktree) {
    return mirroredWorktreeRefusal(context, target, worktree);
  }
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

/** The repository id `folder`'s repo-local link records for the companion; null without one. */
function linkedIdTo(folder: string, companion: string): string | null {
  try {
    const parsed = parse(fs.readFileSync(repoLocalRegistryPath(folder), "utf8")) as {
      companions?: { path?: unknown; repositoryId?: unknown }[];
    } | null;
    for (const pointer of Array.isArray(parsed?.companions) ? parsed.companions : []) {
      if (typeof pointer?.path !== "string" || typeof pointer.repositoryId !== "string") continue;
      if (realPath(pointer.path) === companion) return pointer.repositoryId;
    }
  } catch {
    // An unreadable link links nothing.
  }
  return null;
}

/**
 * Why the session may not move into the non-Git folder `worktree`, or null when it is
 * the session's Umbrella Repository's mirrored worktree, linked under the umbrella's id
 * to the session's companion.
 */
function mirroredWorktreeRefusal(
  context: CompanionContext,
  target: string,
  worktree: string,
): string | null {
  // A session already in a mirrored worktree moves between its umbrella's.
  const home = homeOf(context.repositoryPath!);
  if (!isWorktreeOf(worktree, home)) {
    return `${target} is not a mirrored worktree of ${context.repositoryPath}`;
  }
  const companion = realPath(context.companionPath);
  const id = companion ? linkedIdTo(worktree, companion) : null;
  if (!id || id !== linkedIdTo(home, companion!)) {
    return `${target} is not linked to the companion ${context.companionPath}`;
  }
  return null;
}

/**
 * Where a session at `repositoryPath` returns to: the main checkout, or for an Umbrella
 * Repository or its mirrored worktree, the umbrella.
 */
function homeOf(repositoryPath: string): string {
  const folder = realPath(repositoryPath);
  if (!folder || umbrellaFolderOf(folder) !== folder) return mainCheckoutOf(repositoryPath);
  const mirrored = mirroredUmbrellaOf(folder);
  const umbrella = mirrored ? realPath(mirrored) : null;
  return umbrella && umbrellaFolderOf(umbrella) === umbrella ? umbrella : folder;
}

/**
 * The umbrella folder or Git checkout holding `dir`; null outside both. A child checkout
 * of a mirrored worktree belongs to that worktree.
 */
function rootOf(dir: string): string | null {
  const real = realPath(dir);
  const umbrella = real ? umbrellaFolderOf(real) : null;
  if (umbrella) return umbrella;
  const checkout = checkoutRootOf(real ?? dir);
  const parent = checkout ? path.dirname(checkout) : null;
  return parent && umbrellaFolderOf(parent) === parent && umbrellaMirroredBy(parent)
    ? parent
    : checkout;
}

/** `root` is a linked Git worktree of `home`, or a mirrored worktree of the umbrella `home`. */
function isWorktreeOf(root: string, home: string): boolean {
  if (isLinkedWorktreeOf(root, home)) return true;
  const umbrella = mirroredUmbrellaOf(root);
  return !!umbrella && umbrellaFolderOf(root) === root && realPath(umbrella) === home;
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
 * Per home (main checkout or umbrella), shared by the plugin's instances: OpenCode sets the
 * plugin up once per location, and a session's later tool calls run in its worktree's
 * instance. Kept on `globalThis` so a module loaded again in the same process shares it.
 */
const states: Map<string, FollowState> = ((globalThis as Record<symbol, unknown>)[
  Symbol.for("mate.opencode.followStates")
] ??= new Map<string, FollowState>()) as Map<string, FollowState>;

function stateOf(home: string): FollowState {
  let state = states.get(home);
  if (!state) {
    state = { followed: null, notes: new Map(), moving: new Map() };
    states.set(home, state);
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
  const home = context.repositoryPath ? homeOf(context.repositoryPath) : null;
  const state = home ? stateOf(home) : null;

  await api.tool.transform((editor) => {
    editor.add({
      name: ENTER_WORKTREE_TOOL,
      description: `Move this session into a linked Git worktree of the Working Repository, or an Umbrella Repository's mirrored worktree, that ${context.frameworkName} created, such as the path \`${context.frameworkName} working worktree --enter\` reports. Later tool calls run there, and new sessions follow until \`${EXIT_WORKTREE_TOOL}\`.`,
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
      description: `Move this session from a linked Git worktree back to the Working Repository's main checkout, or from a mirrored worktree back to its Umbrella Repository; new sessions stop following the worktree. The worktree stays.`,
      input: { type: "object", properties: {}, additionalProperties: false },
      async execute(_input, tool) {
        if (!home || !state) {
          return {
            content: "Refused: this session has no Working Repository.",
            metadata: { moved: false },
          };
        }
        // Forget first: a failed lookup must still stop new sessions following.
        state.followed = null;
        state.notes.delete(tool.sessionID);
        const session = await api.session.get({ sessionID: tool.sessionID as never });
        const current = rootOf(session.location.directory);
        if (!current || !isWorktreeOf(current, home)) {
          return {
            content: `This session is not in a linked worktree; it stays in ${session.location.directory}. New sessions no longer follow a worktree.`,
            metadata: { moved: false },
          };
        }
        await api.session.move({ sessionID: tool.sessionID, directory: home as never });
        return {
          content: `Moved this session to ${home}; it is now the Working Repository. ${current} stays.`,
          metadata: { moved: true, directory: home },
        };
      },
    });
  });

  if (!home || !state) return () => {};

  await api.session.hook("context", async (event) => {
    await state.moving.get(event.sessionID);
    const worktree = state.notes.get(event.sessionID);
    if (!worktree) return;
    const session = await api.session.get({ sessionID: event.sessionID }).catch(() => null);
    if (!session) return;
    // Left the worktree some other way, or the worktree is gone.
    if (rootOf(session.location.directory) !== worktree) {
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
   * Only instances at home follow, each for sessions created at its own location,
   * so a server-wide stream moves a session once.
   */
  const location = realPath(api.location.directory);
  if (!location || rootOf(location) !== home) return () => {};
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
