import os from "node:os";
import path from "node:path";

import type { Context } from "@opencode/plugin/promise/plugin";

import { syncCompanionUnattended, unattendedSyncStalenessLines } from "../runtime/companion-sync";
import type { ResolvedSession } from "../runtime/session-resolution";
import {
  checkToolCall,
  contentText,
  guardFailureMessage,
  landingPath,
  pathText,
  singleWrite,
  type GuardedToolCall,
  type GuardedWrite,
  type ToolGuardRefusal,
} from "../runtime/tool-guard";
import { readWrapStateSync } from "../runtime/wrap-state";
import type { CompanionContext } from "./companion-policy";

/** The Projection Root a session resolved from, when it is wrapped for OpenCode. */
export function repositoryWrappedForOpenCode(session: ResolvedSession): string | undefined {
  if (session.kind !== "projection") return undefined;
  const { repoRoot } = session.projection;
  return readWrapStateSync(repoRoot).runtimes.has("opencode") ? repoRoot : undefined;
}

/**
 * A launch has settled its Git question already, unless it is companion-scoped
 * with Git handling automatic: no repository prepare served it.
 */
function launchSettledGit(session: ResolvedSession): boolean {
  return (
    session.kind === "launch" && (session.scope === "repository" || !session.flags().gitAutoMode)
  );
}

/**
 * Keyed by companion so a double-loaded plugin repairs at most once per
 * session, which is the guarantee the spec asks for.
 */
const repairedCompanions = new Set<string>();

/**
 * A fetch at session start, for a location Session Prepare does not serve.
 * In a repository wrapped for OpenCode the plugin's background sync performs
 * the same unattended operation, so this one steps aside. Elsewhere it only
 * tries the companion lock: a held lock means another sync is already on it.
 * The launch gate comes first so a Managed Session does no Git work at all;
 * the consent gate is the operation's own.
 */
export async function repairCompanionGitOnce(context: CompanionContext): Promise<string[]> {
  if (!context.companionPath || launchSettledGit(context.session)) return [];
  if (repositoryWrappedForOpenCode(context.session)) return [];
  if (repairedCompanions.has(context.companionPath)) return [];
  repairedCompanions.add(context.companionPath);

  /**
   * Operator-facing only: a model told to run the command would run it
   * unattended. The V2 server API has no toast; the notes reach the operator
   * through the persisted record and the TUI's staleness lines.
   */
  return unattendedSyncStalenessLines(
    await syncCompanionUnattended(context.companionPath, { lock: "try" }),
    "opencode",
  );
}

/** Test seam: the once-per-session guard is process-wide by design. */
export function resetCompanionGitRepairGuard(): void {
  repairedCompanions.clear();
}

/**
 * OpenCode's config folders: Agent Runtime state, never Mate artifacts. Not
 * normalised: the Tool Guard follows each through its links.
 */
function openCodeStateRoots(env: Record<string, string | undefined>): string[] {
  const configHome = env.XDG_CONFIG_HOME || `${env.HOME || os.homedir()}${path.sep}.config`;
  const roots = [`${configHome}${path.sep}opencode`];
  if (env.OPENCODE_CONFIG_DIR) roots.push(env.OPENCODE_CONFIG_DIR);
  return roots;
}

const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
/**
 * Also matches the legacy `Move to File:`: OpenCode rejects it, so judging it
 * can only refuse a call that would fail anyway.
 */
const MOVE_TO = /^\*\*\* Move to(?: File)?:(.*)$/;
/** OpenCode unwraps a patch sent as a heredoc (`cat <<'EOF' … EOF`) before parsing it. */
const PATCH_HEREDOC = /^(?:cat\s+)?<<(['"]?)(\w+)\1\s*\n([\s\S]*?)\n\2\s*$/;

function isSectionStart(line: string): boolean {
  return (
    line === "*** End Patch" ||
    line.startsWith(ADD_FILE) ||
    line.startsWith(DELETE_FILE) ||
    line.startsWith(UPDATE_FILE)
  );
}

/**
 * What a patch writes, per file, with its added `+` lines, parsed as OpenCode
 * parses it: inside an update's hunks a header counts only at line start, so a
 * context line (` *** Update File: x`) stays content. A move edits its source
 * and creates its destination, and a delete counts as an edit, so the secret
 * and fork checks see every file touched. A malformed patch is still read:
 * OpenCode refuses it, so judging it is harmless.
 */
export function patchWrites(patchText: string): PatchWrite[] {
  return readPatch(patchText).map(({ movedFrom: _movedFrom, ...write }) => write);
}

type PatchWrite = Omit<GuardedWrite, "movedFrom">;

/** {@link patchWrites}, with a move's destination naming the file it moves. */
function readPatch(patchText: string): GuardedWrite[] {
  const trimmed = patchText.trim();
  const lines = (PATCH_HEREDOC.exec(trimmed)?.[3] ?? trimmed)
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const writes: GuardedWrite[] = [];

  const addedLines = (start: number, isEnd: (line: string) => boolean) => {
    const added: string[] = [];
    let index = start;
    for (; index < lines.length && !isEnd(lines[index]); index++) {
      if (lines[index].startsWith("+")) added.push(lines[index].slice(1));
    }
    return { content: added.join("\n"), next: index };
  };

  let index = 0;
  while (index < lines.length) {
    const header = lines[index].trim();
    if (header.startsWith(ADD_FILE)) {
      const body = addedLines(index + 1, (line) => isSectionStart(line.trim()));
      writes.push({
        path: header.slice(ADD_FILE.length).trim(),
        content: body.content,
        mode: "create",
      });
      index = body.next;
    } else if (header.startsWith(DELETE_FILE)) {
      writes.push({ path: header.slice(DELETE_FILE.length).trim(), content: "", mode: "edit" });
      index++;
    } else if (header.startsWith(UPDATE_FILE)) {
      const source = header.slice(UPDATE_FILE.length).trim();
      let next = index + 1;
      while (lines[next]?.trimEnd() === "*** End of File") next++;
      const destination = MOVE_TO.exec(lines[next]?.trimEnd() ?? "")?.[1].trim();
      if (destination !== undefined) next++;
      const hunks = addedLines(next, (line) => isSectionStart(line.trimEnd()));
      if (destination) {
        writes.push({ path: source, content: "", mode: "edit" });
        writes.push({
          path: destination,
          content: hunks.content,
          mode: "create",
          movedFrom: source,
        });
      } else {
        writes.push({ path: source, content: hunks.content, mode: "edit" });
      }
      index = hunks.next;
    } else {
      // `*** Begin Patch`, `*** End Patch`, `*** Environment ID:` and stray lines.
      index++;
    }
  }
  return writes;
}

/**
 * A move's destination holds the added lines of every section touching its
 * source or destination: OpenCode writes the whole updated file there, so an
 * earlier section's line kept as context lands in it too. Spellings match when
 * they resolve or land alike against `directory`.
 */
function patchWritesWithMovedContent(patchText: string, directory: string): GuardedWrite[] {
  const writes = readPatch(patchText);
  const keys = new Map<string, string[]>();
  const identities = (spelling: string) => {
    let known = keys.get(spelling);
    if (!known) {
      known = [path.resolve(directory, spelling), landingPath(spelling, directory)];
      keys.set(spelling, known);
    }
    return known;
  };
  const touches = (spelling: string | undefined, ends: string[]) =>
    spelling !== undefined && identities(spelling).some((key) => ends.includes(key));
  return writes.map((write) => {
    if (write.movedFrom === undefined) return write;
    const ends = [...identities(write.movedFrom), ...identities(write.path)];
    const content = writes
      .filter((other) => touches(other.path, ends) || touches(other.movedFrom, ends))
      .map((other) => other.content)
      .filter(Boolean)
      .join("\n");
    return { ...write, content };
  });
}

/** OpenCode tool inputs in the Tool Guard's shape; null for a tool it does not guard. */
function openCodeToolCall(
  tool: string,
  args: Record<string, unknown>,
  directory: string,
): GuardedToolCall | null {
  switch (tool) {
    case "read":
      return { kind: "read", paths: [pathText(args.filePath)] };
    case "write":
      return singleWrite(args.filePath, contentText(args.content), "create");
    case "edit":
      return singleWrite(args.filePath, contentText(args.newString), "edit");
    case "apply_patch":
      return {
        kind: "write",
        writes: patchWritesWithMovedContent(pathText(args.patchText), directory),
      };
    case "bash":
      return { kind: "shell", command: pathText(args.command) };
    case "grep":
      return {
        kind: "search",
        paths: [pathText(args.path)],
        globs: [pathText(args.include)],
      };
    default:
      return null;
  }
}

/** OpenCode adapter of the Tool Guard (`runtime/tool-guard.ts`); verdicts are the guard's. */
export async function guardToolInput(
  context: CompanionContext,
  tool: string,
  input: unknown,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  let refusal: ToolGuardRefusal | null;
  try {
    const call = openCodeToolCall(
      tool,
      (input ?? {}) as Record<string, unknown>,
      context.repositoryPath || process.cwd(),
    );
    if (!call) return;
    refusal = await checkToolCall(call, {
      companionPath: context.companionPath,
      repositoryPath: context.repositoryPath,
      runtimeStateRoots: openCodeStateRoots(env),
      launch: context.session.kind === "launch",
    });
  } catch (error) {
    // OpenCode blocks a call whose hook throws.
    throw new Error(guardFailureMessage(error), { cause: error });
  }
  if (refusal) throw new Error(refusal.message);
}

/**
 * Registers the companion guardrails on an OpenCode V2 plugin context.
 * The caller resolves `context` and skips this when no companion resolved;
 * `env` is the launch environment the caller decided to trust.
 */
export async function registerCompanionHooks(
  api: Context,
  context: CompanionContext,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  /**
   * Anything escaping the repair would cost the session every guardrail
   * below to save a synchronization that is optional by design.
   */
  await repairCompanionGitOnce(context).catch(() => []);

  await api.tool.hook("execute.before", (event) =>
    guardToolInput(context, event.tool, event.input, env),
  );
}
