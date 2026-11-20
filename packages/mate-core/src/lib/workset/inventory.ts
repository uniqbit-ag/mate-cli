import path from "node:path";

import {
  activeChanges as listActiveChanges,
  archiveAnchors as listArchiveAnchors,
  changeNameOf,
  changesDirOf,
  parseAnchor,
} from "../change-layout";
import { scopedRepositories } from "../openspec-scopes";
import { type ChangeLinks, deriveGroups, readChangeLinks } from "./groups";
import {
  isRepositoryIdentity,
  isWorksetId,
  type LinkedChange,
  readWorksets,
  type WorksetListing,
  type WorksetRecord,
} from "./record";

/**
 * The normalized Work read model: Scratchpad records plus the Worksets derived from active
 * changes (see `groups.ts`). Reading writes nothing.
 */

export interface ActiveChangeScope {
  name: string;
  /** Scoped `org/repository` identities; `null` when the change's scopes cannot be read. */
  repositories: string[] | null;
}

export interface InventoryInput {
  listing: WorksetListing;
  activeChanges: ActiveChangeScope[];
  links: ChangeLinks[];
  archiveAnchors: readonly string[];
}

export interface InventoryWorkset {
  id: string;
  /** True when no local record names it. */
  implicit: boolean;
  /** The local record, or the projection standing in for one. */
  record: WorksetRecord;
  members: LinkedChange[];
  diagnostics: string[];
  /** False while a diagnostic blocks execution, sharing and claims. */
  actionable: boolean;
}

export interface WorkInventory {
  worksets: InventoryWorkset[];
  /** Diagnostics that concern no single Workset. */
  diagnostics: string[];
}

/** Names of the Workset's active members. */
export function activeMembers(entry: InventoryWorkset): string[] {
  return entry.members.filter((member) => member.kind === "active").map((member) => member.name);
}

/** The record standing in for a derived Workset that no local record names. */
export function implicitRecord(
  id: string,
  members: string[],
  repositories: string[],
): WorksetRecord {
  return {
    id,
    title: id,
    intent: "",
    repositories,
    changes: members,
    stage: "ready",
    createdAt: "",
    extra: {},
  };
}

function scopeDiagnostics(change: ActiveChangeScope): string[] {
  if (change.repositories === null) return [`the scopes of ${change.name} cannot be read`];
  if (change.repositories.length === 0) return [`${change.name} names no scoped repository`];
  const invalid = change.repositories.find((repository) => !isRepositoryIdentity(repository));
  return invalid
    ? [`${change.name} scopes ${JSON.stringify(invalid)}, which is no org/repository`]
    : [];
}

/** Pure: builds the inventory from what was read. */
export function buildInventory(input: InventoryInput): WorkInventory {
  const { listing } = input;
  const active = new Map(input.activeChanges.map((change) => [change.name, change]));
  const newestArchive = new Map<string, string>();
  for (const anchor of input.archiveAnchors.toSorted()) {
    const parsed = parseAnchor(anchor);
    if (parsed) newestArchive.set(parsed.name, anchor);
  }
  const records = new Map(listing.worksets.map((record) => [record.id, record]));
  const listedBy = new Map(
    listing.worksets.map((record) => [record.id, record.changes.map(changeNameOf)] as const),
  );
  const groups = deriveGroups(
    input.links.filter((links) => active.has(links.name)),
    listedBy,
  );
  // A record listing an active change belongs to that change's group, which names any rival.
  const grouped = new Set(
    [...listedBy].filter(([, names]) => names.some((name) => active.has(name))).map(([id]) => id),
  );
  const unreadable = listing.problems.length > 0;
  const entries: InventoryWorkset[] = [];

  for (const group of groups) {
    const record = group.record ? records.get(group.record) : undefined;
    const members: LinkedChange[] = group.members.map((name) => ({ name, kind: "active" }));
    // Archived changes a record still lists keep counting for its stage.
    for (const name of listedBy.get(group.record ?? "") ?? []) {
      if (active.has(name)) continue;
      const anchor = newestArchive.get(name);
      members.push(anchor ? { name, kind: "archived", anchor } : { name, kind: "missing" });
    }
    const scopes = group.members.map((name) => active.get(name)!);
    const repositories = [
      ...new Set(scopes.flatMap((scope) => scope.repositories ?? [])),
    ].toSorted();
    const diagnostics = [...group.diagnostics, ...scopes.flatMap(scopeDiagnostics)];
    if (!isWorksetId(group.id)) {
      diagnostics.push(`${group.id} is not a kebab-case name and cannot name a Workset`);
    }
    if (!record && records.has(group.id)) {
      diagnostics.push(
        `Scratchpad idea ${group.id} and change ${group.id} collide; rename one of them`,
      );
    }
    if (unreadable && !record) {
      // A broken record may list these changes; acting on them alone could split a group.
      diagnostics.push("some Scratchpad records cannot be read, so grouping is uncertain");
    }
    entries.push({
      id: group.id,
      implicit: !record,
      record: record ?? implicitRecord(group.id, group.members, repositories),
      members,
      diagnostics,
      actionable: diagnostics.length === 0,
    });
  }

  for (const record of listing.worksets) {
    if (grouped.has(record.id)) continue;
    // An idea, or a record whose changes are all archived.
    const members = record.changes.map(changeNameOf).map((name): LinkedChange => {
      const anchor = newestArchive.get(name);
      return anchor ? { name, kind: "archived", anchor } : { name, kind: "missing" };
    });
    const diagnostics = members
      .filter((member) => member.kind === "missing")
      .map((member) => `${member.name} is neither active nor archived`);
    entries.push({
      id: record.id,
      implicit: false,
      record,
      members,
      diagnostics,
      actionable: diagnostics.length === 0,
    });
  }

  const seen = new Map<string, number>();
  for (const entry of entries) seen.set(entry.id, (seen.get(entry.id) ?? 0) + 1);
  for (const entry of entries) {
    if ((seen.get(entry.id) ?? 0) > 1) {
      entry.diagnostics.push(`another Workset is also named ${entry.id}`);
      entry.actionable = false;
    }
  }
  return {
    worksets: entries.toSorted((a, b) => a.id.localeCompare(b.id)),
    diagnostics: listing.problems.map((problem) => `${problem.path}: ${problem.reason}`),
  };
}

export interface InventorySources {
  readWorksets?: typeof readWorksets;
  activeChanges?: (companionPath: string) => Promise<string[]>;
  archiveAnchors?: (companionPath: string) => Promise<string[]>;
  scopedRepositories?: (changeDir: string) => Promise<string[]>;
  readChangeLinks?: typeof readChangeLinks;
}

/** Reads the companion and builds its inventory; writes nothing. */
export async function readWorkInventory(
  companionPath: string,
  sources: InventorySources = {},
): Promise<WorkInventory> {
  const [listing, names, anchors] = await Promise.all([
    (sources.readWorksets ?? readWorksets)(companionPath),
    (sources.activeChanges ?? listActiveChanges)(companionPath),
    (sources.archiveAnchors ?? listArchiveAnchors)(companionPath),
  ]);
  const scopes = sources.scopedRepositories ?? scopedRepositories;
  const readLinks = sources.readChangeLinks ?? readChangeLinks;
  const [activeChanges, links] = await Promise.all([
    Promise.all(
      names.map(async (name): Promise<ActiveChangeScope> => {
        try {
          return {
            name,
            repositories: await scopes(path.join(changesDirOf(companionPath), name)),
          };
        } catch {
          return { name, repositories: null };
        }
      }),
    ),
    Promise.all(names.map((name) => readLinks(companionPath, name))),
  ]);
  return buildInventory({ listing, activeChanges, links, archiveAnchors: anchors });
}
