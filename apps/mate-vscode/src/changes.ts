import fs from "node:fs/promises";
import path from "node:path";

export interface OpenChange {
  name: string;
  done: number;
  total: number;
  /** `proposal.md`, else `tasks.md`; absent when the change has neither. */
  file?: string;
}

export type OpenChanges = { linked: false } | { linked: true; changes: OpenChange[] };

export function countTasks(tasks: string): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const match of tasks.matchAll(/^\s*[-*] \[([ xX])\]/gm)) {
    total += 1;
    if (match[1] !== " ") done += 1;
  }
  return { done, total };
}

async function readIfExists(file: string): Promise<string | undefined> {
  return fs.readFile(file, "utf8").catch(() => undefined);
}

/** Active changes of the companion linked at `<repo>/.mate/companion`. */
export async function readOpenChanges(repoRoot: string): Promise<OpenChanges> {
  const companion = path.join(repoRoot, ".mate", "companion");
  if (!(await fs.stat(companion).catch(() => null))) return { linked: false };

  const changesDir = path.join(companion, "openspec", "changes");
  const entries = await fs.readdir(changesDir, { withFileTypes: true }).catch(() => []);
  const changes = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== "archive")
      .map(async (entry): Promise<OpenChange> => {
        const dir = path.join(changesDir, entry.name);
        const tasksFile = path.join(dir, "tasks.md");
        const tasks = await readIfExists(tasksFile);
        const proposal = path.join(dir, "proposal.md");
        let file: string | undefined;
        if ((await readIfExists(proposal)) !== undefined) file = proposal;
        else if (tasks !== undefined) file = tasksFile;
        return {
          name: entry.name,
          ...countTasks(tasks ?? ""),
          ...(file ? { file } : {}),
        };
      }),
  );
  // oxlint-disable-next-line unicorn/no-array-sort -- engines.vscode 1.85 runs Node 18, which lacks toSorted
  return { linked: true, changes: changes.sort((a, b) => a.name.localeCompare(b.name)) };
}
