import fs from "node:fs/promises";
import path from "node:path";

export interface OpenChange {
  name: string;
  done: number;
  total: number;
  /** `proposal.md`, else `tasks.md`; absent when the change has neither. */
  file?: string;
  /** Delivery Branch its `delivery.yaml` records for this repository. */
  deliveryBranch?: string;
}

interface Delivery {
  repository?: string;
  branch?: string;
}

/** The `deliveries` list of a `delivery.yaml`; only flat `key: value` entries are read. */
export function parseDeliveries(yaml: string): Delivery[] {
  const deliveries: Delivery[] = [];
  let inList = false;
  for (const line of yaml.split("\n")) {
    if (/^deliveries:\s*$/.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    if (/^\S/.test(line)) break;
    const entry = /^\s*(-\s+)?(\w+):\s*(.*?)\s*$/.exec(line);
    if (!entry) continue;
    if (entry[1] || deliveries.length === 0) deliveries.push({});
    const value = entry[3]!.replace(/^["']|["']$/g, "");
    const current = deliveries.at(-1)!;
    if (entry[2] === "repository") current.repository = value;
    if (entry[2] === "branch") current.branch = value;
  }
  return deliveries;
}

/**
 * This repository's Delivery Branch: the entry naming it, else the only entry.
 * Repository ids compare case-insensitively, as GitHub slugs do.
 */
export function deliveryBranchFor(
  deliveries: Delivery[],
  repositoryId: string | null,
): string | undefined {
  const own = repositoryId
    ? deliveries.find((entry) => entry.repository?.toLowerCase() === repositoryId.toLowerCase())
    : undefined;
  return (own ?? (deliveries.length === 1 ? deliveries[0] : undefined))?.branch || undefined;
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

/** Every task checked, and at least one task. */
export function readyToArchive(change: Pick<OpenChange, "done" | "total">): boolean {
  return change.total > 0 && change.done === change.total;
}

async function readIfExists(file: string): Promise<string | undefined> {
  return fs.readFile(file, "utf8").catch(() => undefined);
}

/** Active changes of the companion linked at `<repo>/.mate/companion`. */
export async function readOpenChanges(
  repoRoot: string,
  repositoryId: string | null = null,
): Promise<OpenChanges> {
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
        const delivery = await readIfExists(path.join(dir, "delivery.yaml"));
        const deliveryBranch = delivery
          ? deliveryBranchFor(parseDeliveries(delivery), repositoryId)
          : undefined;
        return {
          name: entry.name,
          ...countTasks(tasks ?? ""),
          ...(file ? { file } : {}),
          ...(deliveryBranch ? { deliveryBranch } : {}),
        };
      }),
  );
  // oxlint-disable-next-line unicorn/no-array-sort -- engines.vscode 1.85 runs Node 18, which lacks toSorted
  return { linked: true, changes: changes.sort((a, b) => a.name.localeCompare(b.name)) };
}
