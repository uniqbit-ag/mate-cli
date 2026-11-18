import fs from "node:fs/promises";
import path from "node:path";

import {
  type archiveAnchors,
  archiveDirOf,
  changesDirOf,
  parseAnchor,
  SPECS_RELATIVE_DIR,
} from "../../../lib/change-layout";
import { companionTicketFormat, type TicketFormat } from "../../../lib/delivery/branches";
import { readDeliveryRecord } from "../../../lib/delivery/record";
import { hasUnsubmittedWork } from "../../../lib/delivery/staging/submit";
import {
  loadWorkflow,
  WORKFLOW_FILE,
  type Workflow,
  type WorkflowProblem,
  type WorkflowVerdict,
} from "../../../lib/workflow/declaration";
import {
  type LinkedRepositoryCatalog,
  linkedRepositoryCatalog,
  type RepositorySourceKind,
} from "../../../lib/workset/repositories";
import type { readWorksets, WorksetProblem } from "../../../lib/workset/record";
import type { WorksetStageId, WorksetTurn } from "../../../lib/workset/stage";
import {
  readWorksetStages,
  type WorksetStageSources,
  type WorksetWithStage,
} from "../../../lib/workset/stages";
import { readSubmittedFolders } from "../../../runtime/companion-git-state";
import { errorMessage } from "../../../runtime/error-message";
import {
  pendingSubmittedChanges,
  type PendingSubmittedChange,
} from "../../../runtime/pending-records";
import { canonicalSpecsFor, discoverArchives } from "../artifact/pending/discovery";
import { defaultGitOps } from "../artifact/finish/git";
import { readSpecScopes } from "./areas";
import { collectSkillInventory, type StudioSkillInventory } from "./mate-inventory";
import {
  listChanges,
  listSpecs,
  readAllChangeStatus,
  validateAll,
  type OpenSpecFailure,
  type OpenSpecValidationItem,
} from "./openspec-cli";
import { readWorkflowTopology, type WorkflowTopology } from "./topology";

export interface StudioChangeArtifact {
  id: string;
  status?: string;
}

export interface StudioChange {
  name: string;
  completedTasks?: number;
  totalTasks?: number;
  status?: string;
  lastModified?: string;
  schemaName?: string;
  artifacts: StudioChangeArtifact[];
  valid?: boolean;
  issueCount?: number;
  /**
   * A submitted change of this name awaits publication, and this folder holds work it lacks:
   * another change of that name, or edits made since it was submitted.
   */
  unsubmitted?: true;
  /** The Delivery Path stages its Delivery Record holds as done, by id. */
  stagesDone?: string[];
  /** Its Delivery Record says it was withdrawn: it is at no stage. */
  dropped?: true;
}

/** One repository/Area pair a spec binds; at least one of the two is set. */
export interface StudioSpecScope {
  /** `org/repository`, or the value the spec names when it matches no linked repository. */
  repository?: string;
  area?: string;
}

export interface StudioSpec {
  capability: string;
  requirementCount?: number;
  /** Sorted by repository, pairs without one last, then by Area. */
  scopes: StudioSpecScope[];
  valid?: boolean;
  issueCount?: number;
}

/** A dated archive whose owned paths are committed: published state. */
export interface StudioShippedChange {
  /** Change name without the date prefix. */
  name: string;
  /** Dated archive directory name, e.g. `2026-09-07-acme`. */
  anchor: string;
  /** Archive date, `YYYY-MM-DD`. */
  archivedOn: string;
  /** Capability ids the archive's delta specs name. */
  specs: string[];
  /** False for archives without a `proposal.md`, e.g. `mate-minimal` ones. */
  hasProposal: boolean;
}

/** A submitted change awaiting publication on the pending branch, as last fetched. */
export type StudioSubmittedChange = PendingSubmittedChange;

/** One Workset card: the record plus its derived stage. */
export interface StudioWorkset {
  id: string;
  title: string;
  intent: string;
  repositories: string[];
  changes: string[];
  stage: WorksetStageId;
  stageLabel: string;
  turn: WorksetTurn;
  problems: string[];
  /** When it was started; absent while Later. */
  queuedAt?: string;
}

export interface StudioCompanionPayload {
  companionPath: string;
  changes: StudioChange[];
  specs: StudioSpec[];
  /** Newest first. */
  shipped: StudioShippedChange[];
  /** Submitted changes awaiting publication, the user's own first. */
  submitted?: StudioSubmittedChange[];
  /** Flattened names retained for the workflow's skill-availability check. */
  skills?: string[];
  skillInventory?: StudioSkillInventory;
  topology: WorkflowTopology | null;
  worksets: StudioWorkset[];
  /** `org/repository` identities linked to the companion: what a new Workset may name. */
  linkedRepositories: string[];
  /** Where each of those comes from, so only the list's own can be removed in Studio. */
  repositorySources?: Record<string, RepositorySourceKind>;
  /** Each repository's Git token key, `host/org` of its clone URL, matched against stored token keys. */
  repositoryKeys?: Record<string, string>;
  /** The companion's ticket setting; the Outcome form offers a Ticket field only for `jira`. */
  ticketFormat: TicketFormat;
  /** Records that could not be read, by path and reason. */
  worksetProblems: WorksetProblem[];
  /**
   * The companion's resolved Delivery Path: its declared stages, or the built-in default without
   * a declaration. Null when the declaration is invalid; {@link workflowProblems} then says why.
   * Absent from a payload built before stages could be declared: the built-in default.
   */
  workflow?: Workflow | null;
  /** The problems of an invalid `.mate/config/workflow.yaml`, by key path. */
  workflowProblems?: WorkflowProblem[];
  warnings: string[];
}

export interface StudioCompanionError {
  error: { companionPath: string; reason: string };
}

export type StudioCompanionResponse = StudioCompanionPayload | StudioCompanionError;

export interface CompanionPayloadDeps {
  listChanges?: typeof listChanges;
  listSpecs?: typeof listSpecs;
  readAllChangeStatus?: typeof readAllChangeStatus;
  validateAll?: typeof validateAll;
  readWorkflowTopology?: typeof readWorkflowTopology;
  readSpecScopes?: typeof readSpecScopes;
  collectSkillInventory?: typeof collectSkillInventory;
  discoverArchives?: typeof discoverArchives;
  canonicalSpecsFor?: typeof canonicalSpecsFor;
  /** Porcelain paths with uncommitted changes; throws when status cannot be read. */
  readUncommittedPaths?: (companionPath: string) => Promise<string[]>;
  hasArchivedProposal?: (companionPath: string, anchor: string) => Promise<boolean>;
  readWorksets?: typeof readWorksets;
  linkedRepositoryCatalog?: typeof linkedRepositoryCatalog;
  ticketFormat?: typeof companionTicketFormat;
  archiveAnchors?: typeof archiveAnchors;
  /** Whether an archive's Publication Merge Gate is open: merged, not applicable, or legacy. */
  archiveMergeSettled?: (companionPath: string, anchor: string) => Promise<boolean>;
  /** How a Workset's submitted changes are read for its stage; lib's local readers by default. */
  submittedStages?: Pick<WorksetStageSources, "activeDelivery" | "submittedChanges">;
  /** Submitted changes on the last fetched pending branch; local Git only. */
  submittedChanges?: (
    companionPath: string,
  ) => StudioSubmittedChange[] | Promise<StudioSubmittedChange[]>;
  /** Whether a local change holds work its submitted namesake lacks. */
  hasUnsubmittedWork?: (companionPath: string, change: string) => Promise<boolean>;
  loadWorkflow?: typeof loadWorkflow;
}

async function submittedChanges(companionPath: string): Promise<StudioSubmittedChange[]> {
  const changes = await pendingSubmittedChanges(companionPath, readSubmittedFolders(companionPath));
  return changes.toSorted((a, b) => Number(b.mine) - Number(a.mine));
}

function describe(failure: OpenSpecFailure): string {
  return `${failure.command}: ${failure.reason}`;
}

function validationOf(
  items: OpenSpecValidationItem[] | undefined,
  id: string,
  type: string,
): { valid?: boolean; issueCount?: number } {
  const item = items?.find((entry) => entry.id === id && (entry.type ?? type) === type);
  if (!item || item.valid === undefined) return {};
  return { valid: item.valid, issueCount: item.issues?.length ?? 0 };
}

async function readUncommittedPaths(companionPath: string): Promise<string[]> {
  return defaultGitOps(companionPath).changedPaths();
}

async function hasArchivedProposal(companionPath: string, anchor: string): Promise<boolean> {
  // Entry names only; archived file contents are never read.
  const entries = await fs
    .readdir(path.join(archiveDirOf(companionPath), anchor))
    .catch((): string[] => []);
  return entries.includes("proposal.md");
}

const CANONICAL_SPEC = new RegExp(`^${SPECS_RELATIVE_DIR}/(.+)/spec\\.md$`);

/** `openspec/specs/acme/billing/spec.md` → `acme/billing`; other paths are dropped. */
function capabilityIdsOf(specPaths: string[]): string[] {
  return specPaths.flatMap((specPath) => {
    const id = CANONICAL_SPEC.exec(specPath)?.[1];
    return id ? [id] : [];
  });
}

/** Code-unit order, as anchors are sorted on disk; dated anchors so sort newest first. */
function byAnchorDescending(a: StudioShippedChange, b: StudioShippedChange): number {
  if (a.anchor === b.anchor) return 0;
  return a.anchor < b.anchor ? 1 : -1;
}

/** Committed (published) archives with their parsed anchors, in discovery order. */
async function committedArchives(
  companionPath: string,
  deps: CompanionPayloadDeps,
): Promise<{ anchor: string; name: string; date: string }[]> {
  const uncommitted = await (deps.readUncommittedPaths ?? readUncommittedPaths)(companionPath);
  const archives = await (deps.discoverArchives ?? discoverArchives)(companionPath, uncommitted);
  return archives.flatMap((archive) => {
    const anchor = parseAnchor(archive.anchor);
    if (archive.state !== "committed" || !anchor) return [];
    return [{ anchor: archive.anchor, name: anchor.name, date: anchor.date }];
  });
}

/** Committed archives, newest first. Shares pending's discovery so the two never disagree. */
async function collectShipped(
  companionPath: string,
  deps: CompanionPayloadDeps,
): Promise<StudioShippedChange[]> {
  const specsFor = deps.canonicalSpecsFor ?? canonicalSpecsFor;
  const proposalOf = deps.hasArchivedProposal ?? hasArchivedProposal;
  const shipped = await Promise.all(
    (await committedArchives(companionPath, deps)).map((archive) =>
      Promise.all([
        specsFor(companionPath, archive.anchor),
        proposalOf(companionPath, archive.anchor),
      ]).then(([specPaths, hasProposal]) => ({
        name: archive.name,
        anchor: archive.anchor,
        archivedOn: archive.date,
        specs: capabilityIdsOf(specPaths),
        hasProposal,
      })),
    ),
  );
  return shipped.toSorted(byAnchorDescending);
}

/** The stage readers a caller overrode; absent ones fall back to lib's defaults. */
function stageSourceOverrides(
  deps: CompanionPayloadDeps,
): Omit<WorksetStageSources, "activeChanges" | "publishedAnchors"> {
  return {
    readWorksets: deps.readWorksets,
    archiveAnchors: deps.archiveAnchors,
    archiveMergeSettled: deps.archiveMergeSettled,
    ...deps.submittedStages,
  };
}

/**
 * A companion's Worksets with their derived stages, read on their own: for callers such as
 * the factory runner that need stages without assembling the whole payload.
 */
export async function readCompanionWorksetStages(
  companionPath: string,
  deps: CompanionPayloadDeps = {},
): Promise<{ worksets: WorksetWithStage[]; problems: WorksetProblem[] }> {
  return readWorksetStages(companionPath, {
    activeChanges: async () => {
      const [list, status] = await Promise.all([
        (deps.listChanges ?? listChanges)(companionPath),
        (deps.readAllChangeStatus ?? readAllChangeStatus)(companionPath),
      ]);
      if (!list.ok) throw new Error(describe(list.failure));
      if (!status.ok) throw new Error(describe(status.failure));
      const artifactsOf = new Map(
        (status.value.changes ?? []).map((entry) => [entry.changeName, entry.artifacts ?? []]),
      );
      return (list.value.changes ?? []).map((change) => ({
        name: change.name,
        artifacts: (artifactsOf.get(change.name) ?? []).map((artifact) => ({
          id: artifact.id,
          ...(artifact.status === undefined ? {} : { status: artifact.status }),
        })),
        ...(change.completedTasks === undefined ? {} : { completedTasks: change.completedTasks }),
      }));
    },
    // As in the payload: unreadable archives count as none published, never as an error.
    publishedAnchors: async () =>
      (await committedArchives(companionPath, deps).catch(() => [])).map(
        (archive) => archive.anchor,
      ),
    ...stageSourceOverrides(deps),
  });
}

/**
 * Worksets with their derived stages, from the changes and archives this payload already
 * collected.
 */
async function collectWorksets(
  companionPath: string,
  changes: StudioChange[],
  shipped: StudioShippedChange[],
  deps: CompanionPayloadDeps,
): Promise<{ worksets: StudioWorkset[]; problems: WorksetProblem[] }> {
  const { worksets, problems } = await readWorksetStages(companionPath, {
    activeChanges: async () => changes,
    publishedAnchors: async () => shipped.map((change) => change.anchor),
    ...stageSourceOverrides(deps),
  });
  return {
    worksets: worksets.map(({ record, derived }) => ({
      id: record.id,
      title: record.title,
      intent: record.intent,
      repositories: record.repositories,
      changes: record.changes,
      stage: derived.stage,
      stageLabel: derived.label,
      turn: derived.turn,
      problems: derived.problems,
      ...(record.queuedAt ? { queuedAt: record.queuedAt } : {}),
    })),
    problems,
  };
}

/**
 * One Companion Repository's studio payload. Change and spec collection is
 * load-bearing — its failure becomes the error payload — while topology,
 * validation, skills, and shipped changes degrade to warnings so a companion missing one of them
 * still renders.
 */
export async function assembleCompanionPayload(
  companionPath: string,
  deps: CompanionPayloadDeps = {},
): Promise<StudioCompanionResponse> {
  const collectChanges = deps.listChanges ?? listChanges;
  const collectSpecs = deps.listSpecs ?? listSpecs;
  const collectStatus = deps.readAllChangeStatus ?? readAllChangeStatus;
  const collectValidation = deps.validateAll ?? validateAll;
  const collectTopology = deps.readWorkflowTopology ?? readWorkflowTopology;
  const collectScopes = deps.readSpecScopes ?? readSpecScopes;
  const collectSkills = deps.collectSkillInventory ?? collectSkillInventory;
  // Started now: spec scopes need its registry IDs, and it runs alongside the OpenSpec reads.
  const linked = (deps.linkedRepositoryCatalog ?? linkedRepositoryCatalog)(companionPath).then(
    (catalog) => ({ catalog }),
    (error: unknown) => ({ error }),
  );

  const [changeList, specList, status, validation, topology, skillInventory, shipped] =
    await Promise.all([
      collectChanges(companionPath),
      collectSpecs(companionPath),
      collectStatus(companionPath),
      collectValidation(companionPath),
      collectTopology(companionPath),
      collectSkills(companionPath).then(
        (skills) => ({ skills }),
        (error: unknown) => ({ error }),
      ),
      collectShipped(companionPath, deps).then(
        (changes) => ({ changes }),
        (error: unknown) => ({ error }),
      ),
    ]);

  for (const required of [changeList, specList, status]) {
    if (!required.ok) {
      return { error: { companionPath, reason: describe(required.failure) } };
    }
  }
  if (!changeList.ok || !specList.ok || !status.ok) {
    return { error: { companionPath, reason: "companion state could not be collected" } };
  }

  const warnings: string[] = [];
  if (!topology.ok) warnings.push(describe(topology.failure));
  if (!validation.ok) warnings.push(describe(validation.failure));
  if ("error" in skillInventory) {
    warnings.push(`Mate skill inventory: ${errorMessage(skillInventory.error)}`);
  }
  if ("error" in shipped) {
    warnings.push(`shipped changes: ${errorMessage(shipped.error)}`);
  }
  const validationItems = validation.ok ? validation.value.items : undefined;
  let submitted: StudioSubmittedChange[] = [];
  try {
    submitted = await (deps.submittedChanges ?? submittedChanges)(companionPath);
  } catch (error) {
    warnings.push(`submitted changes: ${errorMessage(error)}`);
  }

  const statusByChange = new Map(
    (status.value.changes ?? []).map((entry) => [entry.changeName, entry]),
  );

  const awaiting = new Set(submitted.map((change) => change.name));
  const unsubmitted = new Set<string>();
  for (const { name } of changeList.value.changes ?? []) {
    if (!awaiting.has(name)) continue;
    const work = deps.hasUnsubmittedWork ?? hasUnsubmittedWork;
    // oxlint-disable-next-line no-await-in-loop -- only local changes that are also submitted
    if (await work(companionPath, name).catch(() => false)) unsubmitted.add(name);
  }

  const verdict = await (deps.loadWorkflow ?? loadWorkflow)(companionPath).catch(
    (error: unknown): WorkflowVerdict => ({
      ok: false,
      file: WORKFLOW_FILE,
      problems: [{ path: "", message: errorMessage(error) }],
    }),
  );
  if (verdict.ok) {
    warnings.push(...verdict.workflow.warnings.map((warning) => `${WORKFLOW_FILE}: ${warning}`));
  } else {
    warnings.push(
      `${WORKFLOW_FILE} is invalid, so the built-in Delivery Path is shown and no stage runs: ${verdict.problems
        .map((problem) => `${problem.path ? `${problem.path}: ` : ""}${problem.message}`)
        .join("; ")}`,
    );
  }

  const planningRoot =
    (status.value.changes ?? []).find((entry) => entry.planningHome?.root)?.planningHome?.root ??
    companionPath;
  // Recorded progress; a record that cannot be read leaves the change to inference.
  const records = new Map(
    await Promise.all(
      (changeList.value.changes ?? []).map(
        async ({ name }) =>
          [
            name,
            await readDeliveryRecord(path.join(changesDirOf(planningRoot), name)).catch(() => null),
          ] as const,
      ),
    ),
  );

  const changes: StudioChange[] = (changeList.value.changes ?? []).map((change) => {
    const changeStatus = statusByChange.get(change.name);
    const record = records.get(change.name);
    const stagesDone = Object.keys(record?.stages ?? {});
    return {
      name: change.name,
      ...(change.completedTasks === undefined ? {} : { completedTasks: change.completedTasks }),
      ...(change.totalTasks === undefined ? {} : { totalTasks: change.totalTasks }),
      ...(change.status === undefined ? {} : { status: change.status }),
      ...(change.lastModified === undefined ? {} : { lastModified: change.lastModified }),
      ...(changeStatus?.schemaName ? { schemaName: changeStatus.schemaName } : {}),
      artifacts: (changeStatus?.artifacts ?? []).map((artifact) => ({
        id: artifact.id,
        ...(artifact.status === undefined ? {} : { status: artifact.status }),
      })),
      ...validationOf(validationItems, change.name, "change"),
      ...(unsubmitted.has(change.name) ? { unsubmitted: true as const } : {}),
      ...(stagesDone.length > 0 ? { stagesDone } : {}),
      ...(record?.state === "dropped" ? { dropped: true as const } : {}),
    };
  });

  const specsRoot = path.join(planningRoot, "openspec", "specs");

  const linkedResult = await linked;
  if ("error" in linkedResult) {
    warnings.push(`linked repositories: ${errorMessage(linkedResult.error)}`);
  }
  const catalog: LinkedRepositoryCatalog =
    "catalog" in linkedResult
      ? linkedResult.catalog
      : { identities: [], aliases: new Map(), kinds: new Map(), keys: new Map(), problem: null };
  if (catalog.problem) warnings.push(catalog.problem);

  const specs: StudioSpec[] = await Promise.all(
    (specList.value.specs ?? []).map(async (spec) => ({
      capability: spec.id,
      ...(spec.requirementCount === undefined ? {} : { requirementCount: spec.requirementCount }),
      scopes: await collectScopes(specsRoot, spec.id, undefined, catalog.aliases),
      ...validationOf(validationItems, spec.id, "spec"),
    })),
  );

  const shippedChanges = "changes" in shipped ? shipped.changes : [];
  const [worksets, ticketFormat] = await Promise.all([
    collectWorksets(companionPath, changes, shippedChanges, deps).catch((error: unknown) => {
      warnings.push(`worksets: ${errorMessage(error)}`);
      return { worksets: [], problems: [] };
    }),
    (deps.ticketFormat ?? companionTicketFormat)(companionPath).catch(
      (error: unknown): TicketFormat => {
        warnings.push(`ticket setting: ${errorMessage(error)}`);
        return "none";
      },
    ),
  ]);

  return {
    companionPath,
    changes,
    specs,
    shipped: shippedChanges,
    submitted,
    skills:
      "skills" in skillInventory
        ? [
            ...new Set([
              ...skillInventory.skills.claude,
              ...skillInventory.skills.opencode,
              ...skillInventory.skills.agents,
            ]),
          ].toSorted()
        : [],
    skillInventory:
      "skills" in skillInventory ? skillInventory.skills : { claude: [], opencode: [], agents: [] },
    topology: topology.ok ? topology.value : null,
    worksets: worksets.worksets,
    linkedRepositories: catalog.identities,
    repositorySources: Object.fromEntries(catalog.kinds),
    repositoryKeys: Object.fromEntries(catalog.keys),
    ticketFormat,
    worksetProblems: worksets.problems,
    workflow: verdict.ok ? verdict.workflow : null,
    ...(verdict.ok ? {} : { workflowProblems: verdict.problems }),
    warnings,
  };
}
