import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { parse, stringify } from "yaml";

import { errorMessage } from "../../runtime/error-message";
import { parseAnchor } from "../change-layout";

/**
 * The Workset record: `worksets/<id>.yaml` in the Companion Repository. It groups
 * the changes shipped together, names their Working Repositories, and holds the
 * stage only before any change exists; afterwards the stage is derived.
 */

export const WORKSETS_RELATIVE_DIR = "worksets";

/** The stages a person moves a Workset through before propose links its first change. */
export const PRE_PROPOSE_STAGES = ["clarify-intent", "explore", "ready"] as const;
export type PreProposeStage = (typeof PRE_PROPOSE_STAGES)[number];

export interface WorksetRecord {
  id: string;
  title: string;
  intent: string;
  repositories: string[];
  changes: string[];
  /** Meaningful only while `changes` is empty. */
  stage: PreProposeStage;
  createdAt: string;
  /** Fields this version does not know, kept so a write preserves them. */
  extra: Record<string, unknown>;
}

export interface WorksetProblem {
  /** Companion-relative path of the record. */
  path: string;
  reason: string;
}

export interface WorksetListing {
  worksets: WorksetRecord[];
  problems: WorksetProblem[];
}

const WORKSET_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const KNOWN_FIELDS = ["id", "title", "intent", "repositories", "changes", "stage", "createdAt"];

export class WorksetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorksetError";
  }
}

export function isWorksetId(id: string): boolean {
  return id.length <= 63 && WORKSET_ID.test(id);
}

export function isRepositoryIdentity(repository: string): boolean {
  return REPOSITORY.test(repository);
}

export function worksetsDirOf(companionPath: string): string {
  return path.join(companionPath, WORKSETS_RELATIVE_DIR);
}

function stringList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

/** Validates one parsed document against its file name; returns the record or the reason it is invalid. */
export function toWorksetRecord(fileId: string, document: unknown): WorksetRecord | string {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return "is not a mapping";
  }
  const raw = document as Record<string, unknown>;
  if (!isWorksetId(fileId)) return `file name ${fileId} is not a kebab-case identifier`;
  if (raw.id !== fileId)
    return `id ${JSON.stringify(raw.id)} does not match the file name ${fileId}`;
  const repositories = stringList(raw.repositories);
  if (repositories === null || repositories.length === 0) {
    return "repositories must list at least one org/repository";
  }
  const invalid = repositories.find((repository) => !isRepositoryIdentity(repository));
  if (invalid) return `repository ${JSON.stringify(invalid)} is not an org/repository name`;
  const changes = stringList(raw.changes);
  if (changes === null) return "changes must be a list of change names";
  const stage = raw.stage ?? "clarify-intent";
  if (!PRE_PROPOSE_STAGES.includes(stage as PreProposeStage)) {
    return `stage ${JSON.stringify(stage)} is not one of ${PRE_PROPOSE_STAGES.join(", ")}`;
  }
  const extra = Object.fromEntries(
    Object.entries(raw).filter(([key]) => !KNOWN_FIELDS.includes(key)),
  );
  return {
    id: fileId,
    title: typeof raw.title === "string" ? raw.title : fileId,
    intent: typeof raw.intent === "string" ? raw.intent : "",
    repositories,
    changes,
    stage: stage as PreProposeStage,
    createdAt:
      raw.createdAt instanceof Date
        ? raw.createdAt.toISOString()
        : typeof raw.createdAt === "string"
          ? raw.createdAt
          : "",
    extra,
  };
}

/** Every record, sorted by id; an unreadable one is a problem, never a reason to stop. */
export async function readWorksets(companionPath: string): Promise<WorksetListing> {
  const dir = worksetsDirOf(companionPath);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { worksets: [], problems: [] };
    throw error;
  }
  const read = await Promise.all(
    entries
      .filter((name) => name.endsWith(".yaml"))
      .toSorted()
      .map(async (entry): Promise<WorksetRecord | WorksetProblem> => {
        const relative = path.join(WORKSETS_RELATIVE_DIR, entry);
        try {
          const record = toWorksetRecord(
            entry.slice(0, -".yaml".length),
            parse(await fs.readFile(path.join(dir, entry), "utf8")),
          );
          return typeof record === "string" ? { path: relative, reason: record } : record;
        } catch (error) {
          return { path: relative, reason: `cannot be read: ${errorMessage(error)}` };
        }
      }),
  );
  return {
    worksets: read.filter((entry): entry is WorksetRecord => "id" in entry),
    problems: read.filter((entry): entry is WorksetProblem => !("id" in entry)),
  };
}

function documentOf(record: WorksetRecord): Record<string, unknown> {
  return {
    id: record.id,
    title: record.title,
    intent: record.intent,
    repositories: record.repositories,
    changes: record.changes,
    stage: record.stage,
    createdAt: record.createdAt,
    ...record.extra,
  };
}

async function writeTemp(dir: string, record: WorksetRecord): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${record.id}.${randomBytes(4).toString("hex")}.tmp`);
  await fs.writeFile(temp, stringify(documentOf(record)), "utf8");
  return temp;
}

export interface NewWorkset {
  id: string;
  title: string;
  intent: string;
  repository: string;
}

/** Writes a new record at stage Clarify intent; an existing identifier is refused and nothing is written. */
export async function createWorkset(
  companionPath: string,
  input: NewWorkset,
  now: () => Date = () => new Date(),
): Promise<WorksetRecord> {
  if (!isWorksetId(input.id)) {
    throw new WorksetError(
      `Workset identifier ${JSON.stringify(input.id)} is not a kebab-case name`,
    );
  }
  if (!isRepositoryIdentity(input.repository)) {
    throw new WorksetError(`${JSON.stringify(input.repository)} is not an org/repository name`);
  }
  const record: WorksetRecord = {
    id: input.id,
    title: input.title.trim() || input.id,
    intent: input.intent.trim(),
    repositories: [input.repository],
    changes: [],
    stage: "clarify-intent",
    createdAt: now().toISOString(),
    extra: {},
  };
  const dir = worksetsDirOf(companionPath);
  const temp = await writeTemp(dir, record);
  try {
    // A hard link never replaces an existing file, so two creates cannot both win.
    await fs.link(temp, path.join(dir, `${record.id}.yaml`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new WorksetError(`a Workset ${record.id} already exists`);
    }
    throw error;
  } finally {
    await fs.rm(temp, { force: true });
  }
  return record;
}

/** Replaces a record atomically, keeping fields this version does not know. */
export async function writeWorkset(companionPath: string, record: WorksetRecord): Promise<void> {
  const dir = worksetsDirOf(companionPath);
  const temp = await writeTemp(dir, record);
  await fs.rename(temp, path.join(dir, `${record.id}.yaml`));
}

const NEXT_STAGE: Partial<Record<PreProposeStage, PreProposeStage>> = {
  "clarify-intent": "explore",
  explore: "ready",
};

/** Clarify intent → Explore change → ready, and only while no change is linked. */
export async function advanceWorkset(companionPath: string, id: string): Promise<WorksetRecord> {
  if (!isWorksetId(id)) {
    throw new WorksetError(`Workset identifier ${JSON.stringify(id)} is not a kebab-case name`);
  }
  const { worksets, problems } = await readWorksets(companionPath);
  const record = worksets.find((workset) => workset.id === id);
  if (!record) {
    const problem = problems.find(
      (entry) => entry.path === path.join(WORKSETS_RELATIVE_DIR, `${id}.yaml`),
    );
    throw new WorksetError(problem ? `${problem.path} ${problem.reason}` : `no Workset ${id}`);
  }
  if (record.changes.length > 0) {
    throw new WorksetError(`Workset ${id} has linked changes; its stage follows them`);
  }
  const next = NEXT_STAGE[record.stage];
  if (!next)
    throw new WorksetError(`Workset ${id} is ready for propose; it advances no further by hand`);
  const advanced = { ...record, stage: next };
  await writeWorkset(companionPath, advanced);
  return advanced;
}

/** Where a linked change name resolves. */
export type LinkedChange =
  | { name: string; kind: "active" }
  | { name: string; kind: "archived"; anchor: string }
  | { name: string; kind: "missing" }
  | { name: string; kind: "conflict"; worksets: string[] };

/**
 * Resolves each Workset's change names to active changes or the newest archive of that
 * name. A name several Worksets claim is a conflict for each of them and counts for none.
 */
export function resolveLinkedChanges(
  worksets: WorksetRecord[],
  active: readonly string[],
  archiveAnchors: readonly string[],
): Map<string, LinkedChange[]> {
  const claimedBy = new Map<string, string[]>();
  for (const workset of worksets) {
    for (const name of new Set(workset.changes)) {
      claimedBy.set(name, [...(claimedBy.get(name) ?? []), workset.id]);
    }
  }
  const activeSet = new Set(active);
  const newestArchive = new Map<string, string>();
  for (const anchor of archiveAnchors.toSorted()) {
    const parsed = parseAnchor(anchor);
    if (parsed) newestArchive.set(parsed.name, anchor);
  }
  return new Map(
    worksets.map((workset) => [
      workset.id,
      [...new Set(workset.changes)].map((name): LinkedChange => {
        const claimants = claimedBy.get(name) ?? [];
        if (claimants.length > 1) return { name, kind: "conflict", worksets: claimants };
        if (activeSet.has(name)) return { name, kind: "active" };
        const anchor = newestArchive.get(name);
        return anchor ? { name, kind: "archived", anchor } : { name, kind: "missing" };
      }),
    ]),
  );
}
