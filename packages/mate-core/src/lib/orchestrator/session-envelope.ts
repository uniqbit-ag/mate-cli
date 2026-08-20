import path from "node:path";

import { getWrapperBinPath } from "../package-paths";
import { buildCompanionGuidance } from "../../playbooks/companion-guidance";
import { readFrameworkConfigReadOnly } from "./config-store";
import { CompanionResolver, type CompanionMatch } from "./companion-resolver";
import { readCompanionRegistry } from "./companion-registry-reader";
import { GlobalConfigStore } from "./global-config-store";
import { findRepoLocalLinkedRepository, pathIsDirectory } from "./repo-local-registry";
import { collectWorkspaceInventory, defaultWorkspaceInventoryDeps } from "./workspace-inventory";
import type { CapabilityConfig, FrameworkConfig, LinkedRepository } from "./types";

export const SESSION_ENVELOPE_SCHEMA_VERSION = 1 as const;
export const SESSION_ENVELOPE_RESOLUTION_SCHEMA_VERSION = 1 as const;

export interface SessionEnvelopeCandidate {
  schemaVersion: typeof SESSION_ENVELOPE_SCHEMA_VERSION;
  repository: LinkedRepository;
  companionPath: string;
}

export interface SessionEnvelopeSelection {
  companionPath: string;
  repositoryId?: string;
  repositoryPath?: string;
}

export interface SessionEnvelopeRequest {
  host: string;
  cwd?: string;
  activePath?: string;
  workspaceRoots?: string[];
  selection?: SessionEnvelopeSelection;
}

export type SessionEnvelopeDiagnosticCode =
  | "selection-required"
  | "selection-not-found"
  | "working-repository-not-found"
  | "companion-config-unreadable";

export interface SessionEnvelopeDiagnostic {
  code: SessionEnvelopeDiagnosticCode;
  message: string;
  candidates: SessionEnvelopeCandidate[];
}

export interface SessionEnvelope {
  schemaVersion: typeof SESSION_ENVELOPE_SCHEMA_VERSION;
  host: string;
  repositoryLink: SessionEnvelopeCandidate;
  workingRepositoryPath: string;
  companionRepositoryPath: string;
  capabilities: CapabilityConfig[];
  renderedGuidance: string;
  permittedRoots: string[];
}

export interface SessionEnvelopeResolution {
  schemaVersion: typeof SESSION_ENVELOPE_RESOLUTION_SCHEMA_VERSION;
  status: "resolved" | "diagnostic";
  envelope?: SessionEnvelope;
  diagnostics: SessionEnvelopeDiagnostic[];
}

export interface SessionEnvelopeDeps {
  listCandidates: (request: SessionEnvelopeRequest) => Promise<SessionEnvelopeCandidate[]>;
  readConfig: (companionPath: string) => Promise<FrameworkConfig>;
  isDirectory: (candidatePath: string) => Promise<boolean>;
  readCompanionRegistry: typeof readCompanionRegistry;
}

function candidateKey(candidate: SessionEnvelopeCandidate): string {
  return `${candidate.companionPath}\0${candidate.repository.id}\0${candidate.repository.path}`;
}

function makeCandidate(
  repository: LinkedRepository,
  companionPath: string,
): SessionEnvelopeCandidate {
  return {
    schemaVersion: SESSION_ENVELOPE_SCHEMA_VERSION,
    repository: { id: repository.id, path: path.resolve(repository.path) },
    companionPath: path.resolve(companionPath),
  };
}

function isWithin(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sortCandidates(candidates: SessionEnvelopeCandidate[]): SessionEnvelopeCandidate[] {
  return candidates.toSorted(
    (a, b) =>
      a.repository.path.localeCompare(b.repository.path) ||
      a.repository.id.localeCompare(b.repository.id) ||
      a.companionPath.localeCompare(b.companionPath),
  );
}

function deduplicateCandidates(candidates: SessionEnvelopeCandidate[]): SessionEnvelopeCandidate[] {
  const seen = new Set<string>();
  return sortCandidates(
    candidates.filter((candidate) => {
      const key = candidateKey(candidate);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}

async function candidatesFromLocalResolution(
  request: SessionEnvelopeRequest,
): Promise<SessionEnvelopeCandidate[]> {
  if (!request.cwd) return [];

  const resolution = await new CompanionResolver(new GlobalConfigStore()).resolveWithDiagnostics(
    request.cwd,
    { logFailures: false, repair: false },
  );
  const repository = await findRepoLocalLinkedRepository(request.cwd);
  if (!repository) return [];

  const matches: CompanionMatch[] = resolution.match
    ? [resolution.match]
    : resolution.ambiguousMatches;
  return matches.map((match) =>
    makeCandidate({ ...repository, id: match.repositoryId }, match.companionPath),
  );
}

async function listDefaultCandidates(
  request: SessionEnvelopeRequest,
): Promise<SessionEnvelopeCandidate[]> {
  const inventory = await collectWorkspaceInventory(
    defaultWorkspaceInventoryDeps(new GlobalConfigStore()),
  );
  const inventoryCandidates = inventory.pairings
    .filter((pairing) => pairing.health === "ready")
    .map((pairing) => makeCandidate(pairing.repository, pairing.companionPath));
  return deduplicateCandidates([
    ...inventoryCandidates,
    ...(await candidatesFromLocalResolution(request)),
  ]);
}

export function defaultSessionEnvelopeDeps(): SessionEnvelopeDeps {
  return {
    listCandidates: listDefaultCandidates,
    readConfig: (companionPath) =>
      readFrameworkConfigReadOnly(path.join(companionPath, ".mate", "config", "framework.yaml")),
    isDirectory: pathIsDirectory,
    readCompanionRegistry,
  };
}

function selectionMatches(
  candidate: SessionEnvelopeCandidate,
  selection: SessionEnvelopeSelection,
): boolean {
  return (
    candidate.companionPath === path.resolve(selection.companionPath) &&
    (selection.repositoryId === undefined || candidate.repository.id === selection.repositoryId) &&
    (selection.repositoryPath === undefined ||
      candidate.repository.path === path.resolve(selection.repositoryPath))
  );
}

function contextCandidates(
  candidates: SessionEnvelopeCandidate[],
  request: SessionEnvelopeRequest,
): SessionEnvelopeCandidate[] {
  const contextPaths = request.activePath
    ? [request.activePath]
    : request.workspaceRoots?.length
      ? request.workspaceRoots
      : request.cwd
        ? [request.cwd]
        : [];
  if (contextPaths.length === 0) return candidates;
  return candidates.filter((candidate) =>
    contextPaths.some((contextPath) => isWithin(candidate.repository.path, contextPath)),
  );
}

function diagnostic(
  code: SessionEnvelopeDiagnosticCode,
  message: string,
  candidates: SessionEnvelopeCandidate[] = [],
): SessionEnvelopeResolution {
  return {
    schemaVersion: SESSION_ENVELOPE_RESOLUTION_SCHEMA_VERSION,
    status: "diagnostic",
    diagnostics: [{ code, message, candidates }],
  };
}

function resolveGuidanceWrapperBinPath(): string {
  try {
    return getWrapperBinPath();
  } catch {
    return path.resolve(import.meta.dirname, "../../../wrappers/bin");
  }
}

async function validateExplicitCandidate(
  selection: SessionEnvelopeSelection,
  deps: SessionEnvelopeDeps,
): Promise<SessionEnvelopeCandidate | null> {
  if (!selection.repositoryId) return null;

  try {
    const { repos } = await deps.readCompanionRegistry(selection.companionPath);
    const repository = repos.find(
      (entry) =>
        entry.id === selection.repositoryId &&
        (selection.repositoryPath === undefined ||
          path.resolve(entry.path) === path.resolve(selection.repositoryPath)),
    );
    if (!repository || !(await deps.isDirectory(repository.path))) return null;
    return makeCandidate(repository, selection.companionPath);
  } catch {
    return null;
  }
}

/** Resolves host context without launching a process or mutating runtime state. */
export async function resolveSessionEnvelope(
  request: SessionEnvelopeRequest,
  deps: SessionEnvelopeDeps = defaultSessionEnvelopeDeps(),
): Promise<SessionEnvelopeResolution> {
  let candidates: SessionEnvelopeCandidate[];
  try {
    candidates = await deps.listCandidates(request);
  } catch (error) {
    if (!request.selection) throw error;
    candidates = [];
  }
  let selected: SessionEnvelopeCandidate | undefined;

  if (request.selection) {
    selected = candidates.find((candidate) => selectionMatches(candidate, request.selection!));
    if (!selected)
      selected = (await validateExplicitCandidate(request.selection, deps)) ?? undefined;
    if (!selected) {
      return diagnostic(
        "selection-not-found",
        "The selected Repository Link is not registered or its working repository is unavailable.",
        contextCandidates(candidates, request),
      );
    }
  } else {
    const eligible = sortCandidates(contextCandidates(candidates, request));
    if (eligible.length === 0) {
      return diagnostic(
        "working-repository-not-found",
        "No eligible Repository Link was found for the supplied workspace context.",
      );
    }
    if (eligible.length > 1) {
      return diagnostic(
        "selection-required",
        "Multiple Repository Links match the supplied workspace context; select one before continuing.",
        eligible,
      );
    }
    selected = eligible[0];
  }

  if (!selected) {
    return diagnostic(
      "working-repository-not-found",
      "No eligible Repository Link was found for the supplied workspace context.",
    );
  }

  let config: FrameworkConfig;
  try {
    config = await deps.readConfig(selected.companionPath);
  } catch (error) {
    return diagnostic(
      "companion-config-unreadable",
      `The selected Companion Repository configuration could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      [selected],
    );
  }

  const adapterContext = {
    repository: selected.repository,
    allowedAgents: config.allowedAgents,
    companionPath: selected.companionPath,
    capabilities: config.capabilities ?? [],
    git: config.git,
  };
  const envelope: SessionEnvelope = {
    schemaVersion: SESSION_ENVELOPE_SCHEMA_VERSION,
    host: request.host,
    repositoryLink: selected,
    workingRepositoryPath: selected.repository.path,
    companionRepositoryPath: selected.companionPath,
    capabilities: config.capabilities ?? [],
    renderedGuidance: buildCompanionGuidance(adapterContext, {
      wrapperBinPath: resolveGuidanceWrapperBinPath(),
    }),
    permittedRoots: [selected.repository.path, selected.companionPath],
  };

  return {
    schemaVersion: SESSION_ENVELOPE_RESOLUTION_SCHEMA_VERSION,
    status: "resolved",
    envelope,
    diagnostics: [],
  };
}
