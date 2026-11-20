import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { CHANGES_RELATIVE_DIR } from "../change-layout";
import { DELIVERY_FILE, isJiraKey } from "../delivery/record";
import { readFrontmatter } from "../frontmatter";

/**
 * Worksets are derived, never stored: active changes that list each other in `dependsOn`,
 * or record the same Delivery Branch, or are listed by one local record, form one group.
 * A dependency recording a different Delivery Branch merges separately and stays apart.
 */

export interface ChangeLinks {
  name: string;
  dependsOn: readonly string[];
  /** Delivery Branches the change's `delivery.yaml` records, any repository. */
  branches: readonly string[];
}

export interface DerivedGroup {
  id: string;
  /** Members in dependency order. */
  members: string[];
  /** The local record that named the group, when one did. */
  record?: string;
  diagnostics: string[];
}

const WORKSET_BRANCH = /^workset\/(.+)$/;

/** The Workset id a `workset/[<ticket>-]<id>` branch carries, or null. */
export function worksetIdOfBranch(branch: string): string | null {
  const match = WORKSET_BRANCH.exec(branch);
  if (!match) return null;
  const rest = match[1]!;
  const ticket = /^([A-Z][A-Z0-9]+-\d+)-(.+)$/.exec(rest);
  return ticket && isJiraKey(ticket[1]!) ? ticket[2]! : rest;
}

function disjoint(a: readonly string[], b: readonly string[]): boolean {
  return a.length > 0 && b.length > 0 && !a.some((branch) => b.includes(branch));
}

/** Members ordered so each follows its in-group dependencies; ties by name. */
function dependencyOrder(members: readonly string[], links: Map<string, ChangeLinks>): string[] {
  const inGroup = new Set(members);
  const ordered: string[] = [];
  const placed = new Set<string>();
  const visit = (name: string, seen: Set<string>) => {
    if (placed.has(name) || seen.has(name)) return;
    seen.add(name);
    for (const dependency of [...(links.get(name)?.dependsOn ?? [])].toSorted()) {
      if (inGroup.has(dependency)) visit(dependency, seen);
    }
    placed.add(name);
    ordered.push(name);
  };
  for (const name of [...members].toSorted()) visit(name, new Set());
  return ordered;
}

/** Pure: groups active changes; `records` maps a local record id to the changes it lists. */
export function deriveGroups(
  changes: readonly ChangeLinks[],
  records: ReadonlyMap<string, readonly string[]> = new Map(),
): DerivedGroup[] {
  const links = new Map(changes.map((change) => [change.name, change]));
  const parent = new Map(changes.map((change) => [change.name, change.name]));
  const find = (name: string): string => {
    let root = name;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(name, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };

  for (const change of changes) {
    for (const dependency of change.dependsOn) {
      const other = links.get(dependency);
      if (other && !disjoint(change.branches, other.branches)) union(change.name, dependency);
    }
  }
  const byBranch = new Map<string, string>();
  for (const change of changes) {
    for (const branch of change.branches) {
      const first = byBranch.get(branch);
      if (first) union(first, change.name);
      else byBranch.set(branch, change.name);
    }
  }
  const recordOf = new Map<string, string[]>();
  for (const [id, listed] of [...records].toSorted(([a], [b]) => a.localeCompare(b))) {
    const active = listed.filter((name) => links.has(name));
    for (const name of active) recordOf.set(name, [...(recordOf.get(name) ?? []), id]);
    for (const name of active.slice(1)) union(active[0]!, name);
  }

  const groups = new Map<string, string[]>();
  for (const change of changes) {
    const root = find(change.name);
    groups.set(root, [...(groups.get(root) ?? []), change.name]);
  }
  return [...groups.values()]
    .map((members): DerivedGroup => {
      const ordered = dependencyOrder(members, links);
      const diagnostics: string[] = [];
      const recordIds = [...new Set(members.flatMap((name) => recordOf.get(name) ?? []))];
      if (recordIds.length > 1) {
        diagnostics.push(`listed by several Worksets: ${recordIds.join(", ")}`);
      }
      const branchIds = [
        ...new Set(
          members.flatMap((name) =>
            (links.get(name)?.branches ?? []).flatMap((branch) => {
              const id = worksetIdOfBranch(branch);
              return id ? [id] : [];
            }),
          ),
        ),
      ].toSorted();
      const id = branchIds[0] ?? recordIds[0] ?? ordered[0]!;
      return {
        id,
        members: ordered,
        ...(recordIds.length > 0 ? { record: recordIds[0]! } : {}),
        diagnostics,
      };
    })
    .toSorted((a, b) => a.id.localeCompare(b.id));
}

// Reading ------------------------------------------------------------------------------

/** `dependsOn` from the first planning artifact that exists, as proposing writes it. */
export function dependsOnFrom(sources: readonly (string | null)[]): string[] {
  for (const source of sources) {
    if (source === null) continue;
    const list = readFrontmatter(source)?.dependsOn;
    return Array.isArray(list)
      ? list.filter((value): value is string => typeof value === "string")
      : [];
  }
  return [];
}

/** Branches a `delivery.yaml` source records; unreadable content records none. */
export function branchesFrom(source: string | null): string[] {
  if (source === null) return [];
  try {
    const document = parse(source) as { deliveries?: unknown } | null;
    const deliveries = Array.isArray(document?.deliveries) ? document.deliveries : [];
    return deliveries.flatMap((entry) =>
      entry &&
      typeof entry === "object" &&
      typeof (entry as { branch?: unknown }).branch === "string"
        ? [(entry as { branch: string }).branch]
        : [],
    );
  } catch {
    return [];
  }
}

export const LINK_ARTIFACTS = ["proposal.md", "specs.md", "tasks.md"] as const;

async function readOptional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** The links of change `name` whose source folder is `dir`. */
export async function readFolderLinks(dir: string, name: string): Promise<ChangeLinks> {
  const [artifacts, delivery] = await Promise.all([
    Promise.all(LINK_ARTIFACTS.map((artifact) => readOptional(path.join(dir, artifact)))),
    readOptional(path.join(dir, DELIVERY_FILE)),
  ]);
  return { name, dependsOn: dependsOnFrom(artifacts), branches: branchesFrom(delivery) };
}

/** The links of one active change in the checkout. */
export function readChangeLinks(companionPath: string, name: string): Promise<ChangeLinks> {
  return readFolderLinks(path.join(companionPath, ...CHANGES_RELATIVE_DIR.split("/"), name), name);
}
