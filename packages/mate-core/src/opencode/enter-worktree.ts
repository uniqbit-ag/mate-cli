import path from "node:path";

import type { Context } from "@opencode/plugin/promise/plugin";

import { isLinkedWorktreeOf, readGitLayout } from "../runtime/git-layout";
import { realPathOrNull as realPath } from "../runtime/physical-path";
import { companionLinkPath } from "../runtime/repo-local";
import type { CompanionContext } from "./companion-policy";

export const ENTER_WORKTREE_TOOL = "mate_enter_worktree";

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

/** Moves the calling session through the plugin's own client, which talks to the server that owns it. */
export async function registerEnterWorktree(
  api: Context,
  context: CompanionContext,
): Promise<void> {
  await api.tool.transform((editor) => {
    editor.add({
      name: ENTER_WORKTREE_TOOL,
      description: `Move this session into a linked Git worktree of the Working Repository that ${context.frameworkName} created, such as the path \`${context.frameworkName} working worktree --enter\` reports. Later tool calls run there.`,
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
        return {
          content: `Moved this session to ${directory}; it is now the Working Repository.`,
          metadata: { moved: true, directory },
        };
      },
    });
  });
}
