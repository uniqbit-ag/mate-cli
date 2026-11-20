import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { mateHome } from "../../runtime/runtime-directory";
import type { Workflow } from "./declaration";

/**
 * Trust in the `run:` commands a companion's workflow declares. Anyone who can push to the
 * companion can change them, so submit and publication run one only after the developer
 * approved it on this machine with `mate workflow trust`. Approval is per command text: an
 * edited command needs approving again. A script the command calls is trusted with it.
 */

export type HookName = "check" | "apply" | "validate";

/** A `run:` command of a declared artifact type. */
export interface DeclaredCommand {
  type: string;
  hook: HookName;
  run: string;
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

/** Where approvals are kept: per user, outside every companion. */
export function trustFilePath(homeDir?: string): string {
  return path.join(mateHome(homeDir), "trusted-hooks.json");
}

const digest = (run: string): string => createHash("sha256").update(run).digest("hex");

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

export async function isCommandTrusted(run: string, homeDir?: string): Promise<boolean> {
  return (await readTrusted(homeDir)).has(digest(run));
}

/** Approves `runs` on this machine, keeping earlier approvals. */
export async function trustCommands(runs: readonly string[], homeDir?: string): Promise<void> {
  const trusted = await readTrusted(homeDir);
  for (const run of runs) trusted.add(digest(run));
  const file = trustFilePath(homeDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const content = `${JSON.stringify({ version: 1, commands: [...trusted].toSorted() }, null, 2)}\n`;
  await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  await fs.rename(temporary, file);
}
