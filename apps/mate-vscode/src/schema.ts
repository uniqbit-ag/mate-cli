/**
 * Local mirrors of Mate's `workspace list`/`workspace materialize` JSON
 * contracts. Deliberately hand-defined here rather than imported from
 * `@uniqbit/mate-core` — the extension treats the CLI's stdout as the only
 * process boundary (design decision 1) and must not bundle orchestration
 * internals or require lockstep package versions.
 */

export const SUPPORTED_INVENTORY_SCHEMA_VERSION = 1;
export const SUPPORTED_MATERIALIZED_SCHEMA_VERSION = 1;

export type CompanionHealth = "ready" | "missing" | "unreadable";
export type PairingHealth = "ready" | "missing-companion" | "missing-repository" | "unreadable";

export interface WorkspaceInventoryCompanion {
  path: string;
  health: CompanionHealth;
  diagnostic?: string;
}

export interface WorkspaceInventoryPairing {
  companionPath: string;
  repository: { id: string; path: string };
  health: PairingHealth;
  ambiguous: boolean;
  diagnostic?: string;
}

export interface WorkspaceInventoryV1 {
  schemaVersion: 1;
  companions: WorkspaceInventoryCompanion[];
  pairings: WorkspaceInventoryPairing[];
}

export interface MaterializedWorkspaceV1 {
  schemaVersion: 1;
  workspacePath: string;
  folders: [string, string];
}

export class InvalidMateResponseError extends Error {}

export class UnsupportedSchemaVersionError extends Error {
  constructor(
    readonly received: unknown,
    readonly supported: number,
    contractName: string,
  ) {
    super(
      `Mate returned an unsupported ${contractName} schema version (${JSON.stringify(received)}); ` +
        `this extension supports version ${supported}. Update Mate or the Mate Workspace Navigator extension.`,
    );
  }
}

const COMPANION_HEALTH: ReadonlySet<string> = new Set(["ready", "missing", "unreadable"]);
const PAIRING_HEALTH: ReadonlySet<string> = new Set([
  "ready",
  "missing-companion",
  "missing-repository",
  "unreadable",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJson(raw: string, contractName: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new InvalidMateResponseError(
      `Could not parse ${contractName} response as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateCompanionEntry(entry: unknown): WorkspaceInventoryCompanion {
  if (!isRecord(entry))
    throw new InvalidMateResponseError("Invalid companion entry in workspace inventory.");
  const { path, health, diagnostic } = entry;
  if (!isNonEmptyString(path)) {
    throw new InvalidMateResponseError("Companion entry is missing a path.");
  }
  if (typeof health !== "string" || !COMPANION_HEALTH.has(health)) {
    throw new InvalidMateResponseError(
      `Companion entry has an unknown health value: ${String(health)}`,
    );
  }
  return {
    path,
    health: health as CompanionHealth,
    ...(isNonEmptyString(diagnostic) ? { diagnostic } : {}),
  };
}

function validatePairingEntry(entry: unknown): WorkspaceInventoryPairing {
  if (!isRecord(entry))
    throw new InvalidMateResponseError("Invalid pairing entry in workspace inventory.");
  const { companionPath, repository, health, ambiguous, diagnostic } = entry;
  if (!isNonEmptyString(companionPath)) {
    throw new InvalidMateResponseError("Pairing entry is missing a companionPath.");
  }
  if (!isRecord(repository)) {
    throw new InvalidMateResponseError("Pairing entry is missing a repository object.");
  }
  const { id, path: repositoryPath } = repository;
  if (!isNonEmptyString(id) || !isNonEmptyString(repositoryPath)) {
    throw new InvalidMateResponseError("Pairing repository is missing an id or path.");
  }
  if (typeof health !== "string" || !PAIRING_HEALTH.has(health)) {
    throw new InvalidMateResponseError(
      `Pairing entry has an unknown health value: ${String(health)}`,
    );
  }
  if (typeof ambiguous !== "boolean") {
    throw new InvalidMateResponseError("Pairing entry is missing its ambiguous flag.");
  }
  return {
    companionPath,
    repository: { id, path: repositoryPath },
    health: health as PairingHealth,
    ambiguous,
    ...(isNonEmptyString(diagnostic) ? { diagnostic } : {}),
  };
}

/** Validates one `mate workspace list --json` response. Rejects unsupported schema versions outright. */
export function parseWorkspaceInventory(raw: string): WorkspaceInventoryV1 {
  const data = parseJson(raw, "workspace inventory");
  if (!isRecord(data))
    throw new InvalidMateResponseError("Workspace inventory response was not a JSON object.");

  const { schemaVersion, companions, pairings } = data;
  if (schemaVersion !== SUPPORTED_INVENTORY_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(
      schemaVersion,
      SUPPORTED_INVENTORY_SCHEMA_VERSION,
      "workspace inventory",
    );
  }
  if (!Array.isArray(companions) || !Array.isArray(pairings)) {
    throw new InvalidMateResponseError(
      "Workspace inventory response is missing companions/pairings arrays.",
    );
  }

  return {
    schemaVersion: 1,
    companions: companions.map(validateCompanionEntry),
    pairings: pairings.map(validatePairingEntry),
  };
}

/** Validates one `mate workspace materialize --json` response. */
export function parseMaterializedWorkspace(raw: string): MaterializedWorkspaceV1 {
  const data = parseJson(raw, "workspace materialization");
  if (!isRecord(data)) {
    throw new InvalidMateResponseError("Workspace materialization response was not a JSON object.");
  }

  const { schemaVersion, workspacePath, folders } = data;
  if (schemaVersion !== SUPPORTED_MATERIALIZED_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(
      schemaVersion,
      SUPPORTED_MATERIALIZED_SCHEMA_VERSION,
      "workspace materialization",
    );
  }
  if (!isNonEmptyString(workspacePath)) {
    throw new InvalidMateResponseError(
      "Workspace materialization response is missing workspacePath.",
    );
  }
  if (
    !Array.isArray(folders) ||
    folders.length !== 2 ||
    !isNonEmptyString(folders[0]) ||
    !isNonEmptyString(folders[1])
  ) {
    throw new InvalidMateResponseError(
      "Workspace materialization response is missing an ordered folders pair.",
    );
  }

  return { schemaVersion: 1, workspacePath, folders: [folders[0], folders[1]] };
}
