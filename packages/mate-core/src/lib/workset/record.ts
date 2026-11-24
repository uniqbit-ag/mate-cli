import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { parse, stringify } from "yaml";

import { errorMessage } from "../../runtime/error-message";
import { activeChanges, changeNameOf, locateChange, parseAnchor } from "../change-layout";
import { isJiraKey, normalizeJiraKey } from "../delivery/record";
import { scopedRepositories } from "../openspec-scopes";
import { deriveGroups, readChangeLinks } from "./groups";

/**
 * The Workset record: `.mate/scratchpad/<id>.yaml`, local to the companion checkout and
 * ignored by Git. It holds an idea (and a Service plugin's queue) before any change exists and
 * may list the changes proposed from it; it is never shared. Records in the legacy shared
 * `worksets/` folder are still read, and move to the scratchpad on their next write.
 */

export const WORKSETS_RELATIVE_DIR = ".mate/scratchpad";
/** Where earlier versions kept records, in the shared tree. */
export const LEGACY_WORKSETS_RELATIVE_DIR = "worksets";

/** The stages a person moves a Workset through before propose links its first change. */
export const PRE_PROPOSE_STAGES = ["clarify-intent", "explore", "ready"] as const;
export type PreProposeStage = (typeof PRE_PROPOSE_STAGES)[number];

export interface WorksetRecord {
  id: string;
  title: string;
  intent: string;
  /** Jira key that names the Workset's new Delivery Branch when no caller gives one. */
  ticket?: string;
  repositories: string[];
  changes: string[];
  /** Meaningful only while `changes` is empty. */
  stage: PreProposeStage;
  createdAt: string;
  /** When the Workset was started; absent while Later, which never runs by itself. */
  queuedAt?: string;
  /** Read from the legacy shared folder: its `queuedAt` may come from another machine. */
  legacy?: boolean;
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
const KNOWN_FIELDS = [
  "id",
  "title",
  "intent",
  "ticket",
  "repositories",
  "changes",
  "stage",
  "createdAt",
  "queuedAt",
];

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
  return path.join(companionPath, ...WORKSETS_RELATIVE_DIR.split("/"));
}

function legacyDirOf(companionPath: string): string {
  return path.join(companionPath, LEGACY_WORKSETS_RELATIVE_DIR);
}

// Ignores the folder itself, so a record is never trackable even before setup writes the
// managed `.gitignore` entry.
const SELF_IGNORE = "*\n";

function stringList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

/** A YAML timestamp as text: the parser yields a Date for an unquoted one. */
function timestampText(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : undefined;
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
  const queuedAt = timestampText(raw.queuedAt);
  if (queuedAt !== undefined && Number.isNaN(Date.parse(queuedAt))) {
    return "queuedAt must be a timestamp";
  }
  const ticket = raw.ticket ?? undefined;
  if (ticket !== undefined && (typeof ticket !== "string" || !isJiraKey(ticket))) {
    return "ticket must be a Jira key such as ABC-123";
  }
  const known = new Set(KNOWN_FIELDS);
  const extra = Object.fromEntries(Object.entries(raw).filter(([key]) => !known.has(key)));
  return {
    id: fileId,
    title: typeof raw.title === "string" ? raw.title : fileId,
    intent: typeof raw.intent === "string" ? raw.intent : "",
    ...(ticket !== undefined ? { ticket: normalizeJiraKey(ticket) } : {}),
    repositories,
    changes,
    stage: stage as PreProposeStage,
    createdAt: timestampText(raw.createdAt) ?? "",
    ...(queuedAt ? { queuedAt } : {}),
    extra,
  };
}

/** One record file: the record, or why it is not one. */
async function readWorksetFile(dir: string, id: string): Promise<WorksetRecord | string> {
  try {
    return toWorksetRecord(id, parse(await fs.readFile(path.join(dir, `${id}.yaml`), "utf8")));
  } catch (error) {
    return `cannot be read: ${errorMessage(error)}`;
  }
}

async function readDir(
  dir: string,
  relativeDir: string,
  legacy: boolean,
): Promise<(WorksetRecord | WorksetProblem)[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(
    entries
      .filter((name) => name.endsWith(".yaml"))
      .toSorted()
      .map(async (entry): Promise<WorksetRecord | WorksetProblem> => {
        const record = await readWorksetFile(dir, entry.slice(0, -".yaml".length));
        if (typeof record === "string") {
          return { path: path.posix.join(relativeDir, entry), reason: record };
        }
        return legacy ? { ...record, legacy: true } : record;
      }),
  );
}

function isRecord(entry: WorksetRecord | WorksetProblem): entry is WorksetRecord {
  return "id" in entry;
}

/**
 * Every record, sorted by id; an unreadable one is a problem, never a reason to stop. A
 * scratchpad record wins over a legacy one with the same id.
 */
export async function readWorksets(companionPath: string): Promise<WorksetListing> {
  const [current, legacy] = await Promise.all([
    readDir(worksetsDirOf(companionPath), WORKSETS_RELATIVE_DIR, false),
    readDir(legacyDirOf(companionPath), LEGACY_WORKSETS_RELATIVE_DIR, true),
  ]);
  const ids = new Set(current.filter(isRecord).map((record) => record.id));
  const moved = legacy.filter(isRecord).filter((record) => !ids.has(record.id));
  return {
    worksets: [...current.filter(isRecord), ...moved].toSorted((a, b) => a.id.localeCompare(b.id)),
    problems: [...current, ...legacy].filter((entry): entry is WorksetProblem => !isRecord(entry)),
  };
}

/** The valid record with this id; undefined when missing or unreadable. */
export async function findWorkset(
  companionPath: string,
  id: string,
): Promise<WorksetRecord | undefined> {
  // Reads only this record's file; an id that is no file name has none.
  if (!isWorksetId(id)) return undefined;
  const record = await readWorksetFile(worksetsDirOf(companionPath), id);
  if (typeof record !== "string") return record;
  const legacy = await readWorksetFile(legacyDirOf(companionPath), id);
  return typeof legacy === "string" ? undefined : { ...legacy, legacy: true };
}

export type WorksetResolution =
  | { id: string; implicit: boolean; diagnostics: string[] }
  | { id: null; diagnostics: string[] };

function problemDiagnostics(problems: WorksetProblem[]): string[] {
  return problems.map((problem) => `${problem.path}: ${problem.reason}`);
}

function listsChange(record: WorksetRecord, change: string): boolean {
  return record.changes.some((entry) => changeNameOf(entry) === changeNameOf(change));
}

/** Checks branch ownership for an explicit Workset without inferring change membership. */
export async function resolveWorksetBranch(
  companionPath: string,
  id: string,
  repository?: string,
): Promise<WorksetResolution> {
  const listing = await readWorksets(companionPath);
  return resolveWorksetIdentity(companionPath, id, false, repository, listing);
}

async function resolveWorksetIdentity(
  companionPath: string,
  id: string,
  implicit: boolean,
  repository: string | undefined,
  { worksets, problems }: WorksetListing,
): Promise<WorksetResolution> {
  const diagnostics = problemDiagnostics(problems);
  if (diagnostics.length) return { id: null, diagnostics };
  const explicit = worksets.find((record) => record.id === id);
  const standalone = await locateChange(companionPath, id);
  if (explicit && standalone && !worksets.some((record) => listsChange(record, id))) {
    const repositories = await scopedRepositories(standalone.dir);
    const overlaps = explicit.repositories.some(
      (owner) =>
        (!repository || owner.toLowerCase() === repository.toLowerCase()) &&
        (repositories.length === 0 ||
          repositories.some((candidate) => candidate.toLowerCase() === owner.toLowerCase())),
    );
    if (overlaps) {
      return {
        id: null,
        diagnostics: [
          `Workset ${id} and standalone change ${id} collide${repository ? ` in ${repository}` : ""}; select a branch explicitly or repair the identities.`,
        ],
      };
    }
  }
  return { id, implicit, diagnostics };
}

/**
 * The derived Workset of an active change no record lists: its `dependsOn` and branch group,
 * grouped with the records as the Work inventory groups it.
 */
async function derivedWorksetOf(
  companionPath: string,
  change: string,
  worksets: readonly WorksetRecord[],
): Promise<{ id: string; implicit: boolean }> {
  const names = await activeChanges(companionPath).catch(() => [] as string[]);
  if (!names.includes(change)) return { id: change, implicit: true };
  const links = await Promise.all(names.map((name) => readChangeLinks(companionPath, name)));
  const records = new Map(
    worksets.map((record) => [record.id, record.changes.map(changeNameOf)] as const),
  );
  const group = deriveGroups(links, records).find((candidate) =>
    candidate.members.includes(change),
  );
  if (!group) return { id: change, implicit: true };
  // A group named by the record listing its other members is that record's Workset.
  return { id: group.id, implicit: group.record !== group.id };
}

/** Resolves membership and branch ownership; malformed records never imply standalone work. */
export async function resolveWorksetOf(
  companionPath: string,
  change: string,
  repository?: string,
): Promise<WorksetResolution> {
  const listing = await readWorksets(companionPath);
  const members = listing.worksets.filter((record) => listsChange(record, change));
  if (members.length > 1) {
    return {
      id: null,
      diagnostics: [
        `Change ${change} belongs to several Worksets: ${members.map((record) => record.id).join(", ")}.`,
        ...problemDiagnostics(listing.problems),
      ],
    };
  }
  if (members[0])
    return resolveWorksetIdentity(companionPath, members[0].id, false, repository, listing);
  const derived = await derivedWorksetOf(companionPath, changeNameOf(change), listing.worksets);
  return resolveWorksetIdentity(companionPath, derived.id, derived.implicit, repository, listing);
}

function documentOf(record: WorksetRecord): Record<string, unknown> {
  return {
    id: record.id,
    title: record.title,
    intent: record.intent,
    ...(record.ticket ? { ticket: record.ticket } : {}),
    repositories: record.repositories,
    changes: record.changes,
    stage: record.stage,
    createdAt: record.createdAt,
    ...(record.queuedAt ? { queuedAt: record.queuedAt } : {}),
    ...record.extra,
  };
}

async function writeTemp(dir: string, record: WorksetRecord): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, ".gitignore"), SELF_IGNORE, { flag: "wx" }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const temp = path.join(dir, `.${record.id}.${randomBytes(4).toString("hex")}.tmp`);
  await fs.writeFile(temp, stringify(documentOf(record)), "utf8");
  return temp;
}

export interface NewWorkset {
  id: string;
  title: string;
  intent: string;
  repository: string;
  /** Starts the Workset at once; otherwise it is Later. */
  start?: boolean;
  /** A Jira key, already validated and normalised. */
  ticket?: string;
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
  const createdAt = now().toISOString();
  const record: WorksetRecord = {
    id: input.id,
    title: input.title.trim() || input.id,
    intent: input.intent.trim(),
    ...(input.ticket ? { ticket: input.ticket } : {}),
    repositories: [input.repository],
    changes: [],
    stage: "clarify-intent",
    createdAt,
    ...(input.start ? { queuedAt: createdAt } : {}),
    extra: {},
  };
  if (await findWorkset(companionPath, record.id)) {
    throw new WorksetError(`a Workset ${record.id} already exists`);
  }
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

const ID_LIMIT = 63;

/**
 * An identifier from a title: kebab-case, cut to the limit, then `-2`, `-3`, … while taken.
 * `null` when the title has no letter or digit.
 */
export function worksetIdFor(title: string, taken: ReadonlySet<string>): string | null {
  const base = title
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    // Accents only: `ü` is `u` plus a combining mark.
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) return null;
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? "" : `-${n}`;
    const id = `${base.slice(0, ID_LIMIT - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(id)) return id;
  }
}

const TITLE_LIMIT = 72;

/** An Outcome's title: its text's first sentence or line, cut at a word boundary. */
export function outcomeTitle(text: string): string {
  const first =
    text
      .trim()
      .split(/\n|(?<=[.!?])\s/)[0]
      ?.trim()
      .replace(/[.!?]+$/, "") ?? "";
  if (first.length <= TITLE_LIMIT) return first;
  const cut = first.slice(0, TITLE_LIMIT + 1);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut.slice(0, TITLE_LIMIT)).trim();
}

export interface NewOutcome {
  /** What the person wants, in their words; becomes the intent. */
  text: string;
  /** Required when the companion links several Working Repositories. */
  repository?: string;
  /** Starts it at once; otherwise it is Later. */
  start?: boolean;
  /** Optional Jira key naming the Workset's Delivery Branch; empty means none. */
  ticket?: string;
}

/** Active change names and the ids of the Worksets derived from them; a new idea avoids both. */
async function derivedIds(companionPath: string): Promise<string[]> {
  const names = await activeChanges(companionPath).catch(() => [] as string[]);
  const links = await Promise.all(
    names.map((name) =>
      readChangeLinks(companionPath, name).catch(() => ({ name, dependsOn: [], branches: [] })),
    ),
  );
  return [...names, ...deriveGroups(links).map((group) => group.id)];
}

/** Creates a Workset from an outcome text; identifier and title are derived, the repository defaults to the only linked one. */
export async function createOutcome(
  companionPath: string,
  input: NewOutcome,
  linkedRepositories: readonly string[],
  now: () => Date = () => new Date(),
): Promise<WorksetRecord> {
  const repository =
    input.repository?.trim() ||
    (linkedRepositories.length === 1 ? linkedRepositories[0] : undefined);
  if (!repository) {
    throw new WorksetError(
      linkedRepositories.length === 0
        ? "link a Working Repository to this companion first"
        : "choose the Working Repository for this outcome",
    );
  }
  if (!linkedRepositories.includes(repository)) {
    throw new WorksetError(`${repository} is not linked to this companion`);
  }
  const ticket = input.ticket?.trim() || undefined;
  if (ticket !== undefined && !isJiraKey(ticket)) {
    throw new WorksetError(`ticket ${JSON.stringify(ticket)} is not a Jira key such as ABC-123`);
  }
  const [{ worksets, problems }, derived] = await Promise.all([
    readWorksets(companionPath),
    derivedIds(companionPath),
  ]);
  const taken = new Set([
    ...worksets.map((workset) => workset.id),
    ...problems.map((problem) => path.basename(problem.path, ".yaml")),
    ...derived,
  ]);
  const title = outcomeTitle(input.text);
  const id = worksetIdFor(title, taken);
  if (!id) throw new WorksetError(`the outcome ${JSON.stringify(input.text)} gives no title`);
  return createWorkset(
    companionPath,
    {
      id,
      title,
      intent: input.text,
      repository,
      ...(input.start ? { start: true } : {}),
      ...(ticket ? { ticket: normalizeJiraKey(ticket) } : {}),
    },
    now,
  );
}

/**
 * Replaces a record atomically in the scratchpad, keeping fields this version does not
 * know. A legacy record moves: its shared copy is removed once the local one is written. Its
 * start may come from another machine, so it moves unstarted unless `started` vouches for it.
 */
export async function writeWorkset(
  companionPath: string,
  record: WorksetRecord,
  options: { started?: boolean } = {},
): Promise<void> {
  const dir = worksetsDirOf(companionPath);
  const { legacy, ...local } = record;
  const { queuedAt: _queuedAt, ...unstarted } = local;
  const temp = await writeTemp(dir, legacy && !options.started ? unstarted : local);
  await fs.rename(temp, path.join(dir, `${record.id}.yaml`));
  if (legacy) {
    await fs.rm(path.join(legacyDirOf(companionPath), `${record.id}.yaml`), { force: true });
  }
}

/** Deletes a Workset's record; a record already gone is no error. */
export async function removeWorkset(companionPath: string, id: string): Promise<void> {
  if (!isWorksetId(id)) {
    throw new WorksetError(`Workset identifier ${JSON.stringify(id)} is not a kebab-case name`);
  }
  await Promise.all(
    [worksetsDirOf(companionPath), legacyDirOf(companionPath)].map((dir) =>
      fs.rm(path.join(dir, `${id}.yaml`), { force: true }),
    ),
  );
}

const NEXT_STAGE: Partial<Record<PreProposeStage, PreProposeStage>> = {
  "clarify-intent": "explore",
  explore: "ready",
};

/** Clarify intent → Explore change → ready, and only while no change is linked. */
export async function advanceWorkset(companionPath: string, id: string): Promise<WorksetRecord> {
  const record = await recordFor(companionPath, id);
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

async function recordFor(companionPath: string, id: string): Promise<WorksetRecord> {
  if (!isWorksetId(id)) {
    throw new WorksetError(`Workset identifier ${JSON.stringify(id)} is not a kebab-case name`);
  }
  const { worksets, problems } = await readWorksets(companionPath);
  const record = worksets.find((workset) => workset.id === id);
  if (record) return record;
  const problem = problems.find((entry) => path.posix.basename(entry.path) === `${id}.yaml`);
  throw new WorksetError(problem ? `${problem.path} ${problem.reason}` : `no Workset ${id}`);
}

/**
 * Starts a Workset, stamping `queuedAt` (kept when already started), or makes it Later
 * again, which clears it.
 */
export async function setWorksetStarted(
  companionPath: string,
  id: string,
  started: boolean,
  now: () => Date = () => new Date(),
): Promise<WorksetRecord> {
  const record = await recordFor(companionPath, id);
  const { queuedAt: _queuedAt, legacy, ...rest } = record;
  // Fields of earlier factory versions; dropped so they cannot mislead a reader.
  const { lane: _lane, priority: _priority, ...extra } = record.extra;
  const next: WorksetRecord = started
    ? { ...rest, extra, queuedAt: record.queuedAt ?? now().toISOString() }
    : { ...rest, extra };
  await writeWorkset(companionPath, legacy ? { ...next, legacy } : next, { started });
  // Written to the scratchpad, so no longer legacy.
  return next;
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
