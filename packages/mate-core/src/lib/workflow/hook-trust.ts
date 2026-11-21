import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { companionGit } from "../../runtime/companion-git";
import { withPathLock } from "../../runtime/companion-lock";
import { mateHome } from "../../runtime/runtime-directory";
import { writeAtomic } from "../../runtime/write-atomic";
import type { Workflow } from "./declaration";

/**
 * Trust in the `run:` commands a companion's workflow declares. Anyone who can push to the
 * companion can change them, so submit and publication run one only after the developer
 * approved it on this machine with `mate workflow trust`. Approval is per companion checkout,
 * type, hook and command text: an edited command, or the same text in another companion, needs
 * approving again. A script the command calls is trusted with it.
 */

export type HookName = "check" | "apply" | "validate";

/** A `run:` command of a declared artifact type. */
export interface DeclaredCommand {
  type: string;
  hook: HookName;
  run: string;
}

/** A command as approved: in the companion {@link companionIdentity} names. */
export interface ScopedCommand extends DeclaredCommand {
  companion: string;
}

const HOOKS: readonly HookName[] = ["check", "apply", "validate"];

/** Every `run:` command `workflow` declares, by type and hook. */
export function declaredCommands(workflow: Workflow): DeclaredCommand[] {
  return workflow.artifacts.flatMap((type) =>
    HOOKS.flatMap((hook) => {
      const declared = type.hooks[hook];
      return declared && "run" in declared ? [{ type: type.name, hook, run: declared.run }] : [];
    }),
  );
}

/**
 * The companion checkout `dir` belongs to: its shared Git directory, the same for the temporary
 * worktrees publication works in. `dir` itself when it is no Git checkout.
 */
export async function companionIdentity(dir: string): Promise<string> {
  const result = await companionGit(dir, { prompt: "never" }).run([
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const common = result.status === 0 ? result.stdout.trim() : "";
  return fs.realpath(common || dir).catch(() => path.resolve(common || dir));
}

/** Where approvals are kept: per user, outside every companion. */
export function trustFilePath(homeDir?: string): string {
  return path.join(mateHome(homeDir), "trusted-hooks.json");
}

const digest = (command: ScopedCommand): string =>
  createHash("sha256")
    .update(JSON.stringify([command.companion, command.type, command.hook, command.run]))
    .digest("hex");

/** The approved commands' digests; none for a missing or unreadable file. */
async function readTrusted(homeDir?: string): Promise<Set<string>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(trustFilePath(homeDir), "utf8"));
    const commands = (parsed as { commands?: unknown }).commands;
    return new Set(
      Array.isArray(commands) ? commands.filter((entry) => typeof entry === "string") : [],
    );
  } catch {
    return new Set();
  }
}

/** Whether a command was approved, against the approvals as read once. */
export type TrustedCommands = (command: ScopedCommand) => boolean;

export async function trustedCommands(homeDir?: string): Promise<TrustedCommands> {
  const trusted = await readTrusted(homeDir);
  return (command) => trusted.has(digest(command));
}

export async function isCommandTrusted(command: ScopedCommand, homeDir?: string): Promise<boolean> {
  return (await trustedCommands(homeDir))(command);
}

/** Approves `commands` on this machine, keeping earlier approvals, also a concurrent run's. */
export async function trustCommands(
  commands: readonly ScopedCommand[],
  homeDir?: string,
): Promise<void> {
  const file = trustFilePath(homeDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const locked = await withPathLock("trusted-hooks", file, { homeDir }, async () => {
    const trusted = await readTrusted(homeDir);
    for (const command of commands) trusted.add(digest(command));
    const content = `${JSON.stringify({ version: 2, commands: [...trusted].toSorted() }, null, 2)}\n`;
    await writeAtomic(file, content, 0o600);
  });
  if (!locked.acquired) throw new Error(`${file} is locked by another run; try again`);
}
