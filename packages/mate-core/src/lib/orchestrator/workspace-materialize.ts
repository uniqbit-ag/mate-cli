import path from "node:path";

import { readCompanionRegistry } from "./companion-registry-reader";
import { pathIsDirectory } from "./repo-local-registry";
import { MateError } from "./types";
import { writeWorkspaceDocument } from "./editor";

/** Envelope version for `mate workspace materialize --json`. */
export const MATERIALIZED_WORKSPACE_SCHEMA_VERSION = 1;

export interface MaterializedWorkspaceV1 {
  schemaVersion: 1;
  workspacePath: string;
  folders: [string, string];
}

export class WorkspacePairingNotFoundError extends MateError {
  constructor(repositoryId: string, companionPath: string) {
    super(`mate: repository "${repositoryId}" is not linked by companion: ${companionPath}`);
  }
}

export class WorkspaceRootUnavailableError extends MateError {
  constructor(
    readonly root: "companion" | "repository",
    readonly rootPath: string,
  ) {
    super(`mate: ${root} path does not exist: ${rootPath}`);
  }
}

export interface MaterializeWorkspaceRequest {
  repositoryId: string;
  companionPath: string;
}

export interface MaterializeWorkspaceDeps {
  isDirectory: (candidatePath: string) => Promise<boolean>;
  readCompanionRegistry: typeof readCompanionRegistry;
  writeWorkspaceDocument: typeof writeWorkspaceDocument;
}

export function defaultMaterializeWorkspaceDeps(): MaterializeWorkspaceDeps {
  return { isDirectory: pathIsDirectory, readCompanionRegistry, writeWorkspaceDocument };
}

/**
 * Resolves an explicit companion-path/repository-id pairing, validates both
 * roots exist, and writes the shared workspace document — without touching
 * the registry or spawning an editor. Distinct from `injectEditorFolder`,
 * which additionally launches/reloads an editor CLI.
 */
export async function materializeWorkspace(
  request: MaterializeWorkspaceRequest,
  deps: MaterializeWorkspaceDeps = defaultMaterializeWorkspaceDeps(),
): Promise<MaterializedWorkspaceV1> {
  const companionPath = path.resolve(request.companionPath);

  if (!(await deps.isDirectory(companionPath))) {
    throw new WorkspaceRootUnavailableError("companion", companionPath);
  }

  const { repos } = await deps.readCompanionRegistry(companionPath).catch(() => ({ repos: [] }));
  const repository = repos.find((repo) => repo.id === request.repositoryId);
  if (!repository) {
    throw new WorkspacePairingNotFoundError(request.repositoryId, companionPath);
  }

  const repositoryPath = path.resolve(repository.path);
  if (!(await deps.isDirectory(repositoryPath))) {
    throw new WorkspaceRootUnavailableError("repository", repositoryPath);
  }

  const { workspacePath, folders } = await deps.writeWorkspaceDocument(
    companionPath,
    repositoryPath,
  );

  return { schemaVersion: MATERIALIZED_WORKSPACE_SCHEMA_VERSION, workspacePath, folders };
}
