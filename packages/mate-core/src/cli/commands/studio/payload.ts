import fs from "node:fs/promises";
import path from "node:path";

import {
  archiveAnchors,
  archiveDirOf,
  parseAnchor,
  SPECS_RELATIVE_DIR,
} from "../../../lib/change-layout";
import { isPublishable, readDeliveryState } from "../../../lib/delivery/record";
import { linkedRepositoryIdentities } from "../../../lib/workset/repositories";
import {
  readWorksets,
  resolveLinkedChanges,
  type WorksetProblem,
} from "../../../lib/workset/record";
import {
  type ChangeFacts,
  deriveWorksetStage,
  type WorksetStageId,
  type WorksetTurn,
} from "../../../lib/workset/stage";
import { errorMessage } from "../../../runtime/error-message";
import { canonicalSpecsFor, discoverArchives } from "../artifact/pending/discovery";
import { defaultGitOps } from "../artifact/finish/git";
import { readSpecAreas } from "./areas";
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
}

export interface StudioSpec {
  capability: string;
  requirementCount?: number;
  areas: string[];
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
}

export interface StudioCompanionPayload {
  companionPath: string;
  changes: StudioChange[];
  specs: StudioSpec[];
  /** Newest first. */
  shipped: StudioShippedChange[];
  /** Flattened names retained for the workflow's skill-availability check. */
  skills?: string[];
  skillInventory?: StudioSkillInventory;
  topology: WorkflowTopology | null;
  worksets: StudioWorkset[];
  /** `org/repository` identities linked to the companion: what a new Workset may name. */
  linkedRepositories: string[];
  /** Records that could not be read, by path and reason. */
  worksetProblems: WorksetProblem[];
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
  readSpecAreas?: (specsRoot: string, specId: string) => Promise<string[]>;
  collectSkillInventory?: typeof collectSkillInventory;
  discoverArchives?: typeof discoverArchives;
  canonicalSpecsFor?: typeof canonicalSpecsFor;
  /** Porcelain paths with uncommitted changes; throws when status cannot be read. */
  readUncommittedPaths?: (companionPath: string) => Promise<string[]>;
  hasArchivedProposal?: (companionPath: string, anchor: string) => Promise<boolean>;
  readWorksets?: typeof readWorksets;
  linkedRepositoryIdentities?: typeof linkedRepositoryIdentities;
  archiveAnchors?: typeof archiveAnchors;
  /** Whether an archive's Publication Merge Gate is open: merged, not applicable, or legacy. */
  archiveMergeSettled?: (companionPath: string, anchor: string) => Promise<boolean>;
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

/** Committed archives, newest first. Shares pending's discovery so the two never disagree. */
async function collectShipped(
  companionPath: string,
  deps: CompanionPayloadDeps,
): Promise<StudioShippedChange[]> {
  const uncommitted = await (deps.readUncommittedPaths ?? readUncommittedPaths)(companionPath);
  const archives = await (deps.discoverArchives ?? discoverArchives)(companionPath, uncommitted);
  const specsFor = deps.canonicalSpecsFor ?? canonicalSpecsFor;
  const proposalOf = deps.hasArchivedProposal ?? hasArchivedProposal;
  const shipped = await Promise.all(
    archives.flatMap((archive) => {
      const anchor = parseAnchor(archive.anchor);
      if (archive.state !== "committed" || !anchor) return [];
      return [
        Promise.all([
          specsFor(companionPath, archive.anchor),
          proposalOf(companionPath, archive.anchor),
        ]).then(([specPaths, hasProposal]) => ({
          name: anchor.name,
          anchor: archive.anchor,
          archivedOn: anchor.date,
          specs: capabilityIdsOf(specPaths),
          hasProposal,
        })),
      ];
    }),
  );
  return shipped.toSorted(byAnchorDescending);
}

async function archiveMergeSettled(companionPath: string, anchor: string): Promise<boolean> {
  const state = await readDeliveryState(path.join(archiveDirOf(companionPath), anchor));
  return isPublishable(state.status);
}

/**
 * Worksets with their derived stages. Delivery Records are read only for archives a
 * Workset links, so a companion without Worksets pays nothing.
 */
async function collectWorksets(
  companionPath: string,
  changes: StudioChange[],
  shipped: StudioShippedChange[],
  deps: CompanionPayloadDeps,
): Promise<{ worksets: StudioWorkset[]; problems: WorksetProblem[] }> {
  const listing = await (deps.readWorksets ?? readWorksets)(companionPath);
  if (listing.worksets.length === 0) return { worksets: [], problems: listing.problems };

  const anchors = await (deps.archiveAnchors ?? archiveAnchors)(companionPath);
  const linked = resolveLinkedChanges(
    listing.worksets,
    changes.map((change) => change.name),
    anchors,
  );
  const published = new Set(shipped.map((change) => change.anchor));
  const mergeSettled = deps.archiveMergeSettled ?? archiveMergeSettled;
  const activeByName = new Map(changes.map((change) => [change.name, change]));

  const unique = new Map([...linked.values()].flat().map((change) => [change.name, change]));
  const entries = await Promise.all(
    [...unique.values()].map(async (change): Promise<[string, ChangeFacts] | null> => {
      if (change.kind === "active") {
        const active = activeByName.get(change.name)!;
        return [
          change.name,
          {
            name: change.name,
            archived: false,
            artifactsComplete:
              active.artifacts.length > 0 &&
              active.artifacts.every((artifact) => artifact.status === "done"),
            reviewArtifacts: active.artifacts.map((artifact) => artifact.id),
            checkedTasks: active.completedTasks ?? 0,
            mergeSettled: false,
            published: false,
          },
        ];
      }
      if (change.kind === "archived") {
        return [
          change.name,
          {
            name: change.name,
            archived: true,
            artifactsComplete: true,
            reviewArtifacts: [],
            checkedTasks: 0,
            mergeSettled: await mergeSettled(companionPath, change.anchor),
            published: published.has(change.anchor),
          },
        ];
      }
      return null;
    }),
  );
  const facts = new Map(entries.filter((entry) => entry !== null));

  return {
    worksets: listing.worksets.map((record) => {
      const derived = deriveWorksetStage(record, linked.get(record.id) ?? [], (name) =>
        facts.get(name),
      );
      return {
        id: record.id,
        title: record.title,
        intent: record.intent,
        repositories: record.repositories,
        changes: record.changes,
        stage: derived.stage,
        stageLabel: derived.label,
        turn: derived.turn,
        problems: derived.problems,
      };
    }),
    problems: listing.problems,
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
  const collectAreas = deps.readSpecAreas ?? readSpecAreas;
  const collectSkills = deps.collectSkillInventory ?? collectSkillInventory;

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

  const statusByChange = new Map(
    (status.value.changes ?? []).map((entry) => [entry.changeName, entry]),
  );

  const changes: StudioChange[] = (changeList.value.changes ?? []).map((change) => {
    const changeStatus = statusByChange.get(change.name);
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
    };
  });

  const planningRoot =
    (status.value.changes ?? []).find((entry) => entry.planningHome?.root)?.planningHome?.root ??
    companionPath;
  const specsRoot = path.join(planningRoot, "openspec", "specs");

  const specs: StudioSpec[] = await Promise.all(
    (specList.value.specs ?? []).map(async (spec) => ({
      capability: spec.id,
      ...(spec.requirementCount === undefined ? {} : { requirementCount: spec.requirementCount }),
      areas: await collectAreas(specsRoot, spec.id),
      ...validationOf(validationItems, spec.id, "spec"),
    })),
  );

  const shippedChanges = "changes" in shipped ? shipped.changes : [];
  const [worksets, linkedRepositories] = await Promise.all([
    collectWorksets(companionPath, changes, shippedChanges, deps).catch((error: unknown) => {
      warnings.push(`worksets: ${errorMessage(error)}`);
      return { worksets: [], problems: [] };
    }),
    (deps.linkedRepositoryIdentities ?? linkedRepositoryIdentities)(companionPath).catch(
      (error: unknown) => {
        warnings.push(`linked repositories: ${errorMessage(error)}`);
        return [];
      },
    ),
  ]);

  return {
    companionPath,
    changes,
    specs,
    shipped: shippedChanges,
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
    linkedRepositories,
    worksetProblems: worksets.problems,
    warnings,
  };
}
