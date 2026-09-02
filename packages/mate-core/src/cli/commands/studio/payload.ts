import path from "node:path";

import { readSpecAreas } from "./areas";
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

export interface StudioCompanionPayload {
  companionPath: string;
  changes: StudioChange[];
  specs: StudioSpec[];
  topology: WorkflowTopology | null;
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

/**
 * One Companion Repository's studio payload. Change and spec collection is
 * load-bearing — its failure becomes the error payload — while topology,
 * validation, and skills degrade to warnings so a companion missing one of them
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

  const [changeList, specList, status, validation, topology] = await Promise.all([
    collectChanges(companionPath),
    collectSpecs(companionPath),
    collectStatus(companionPath),
    collectValidation(companionPath),
    collectTopology(companionPath),
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

  return {
    companionPath,
    changes,
    specs,
    topology: topology.ok ? topology.value : null,
    warnings,
  };
}
