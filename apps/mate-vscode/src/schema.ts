/**
 * Local mirrors of Mate's `workspace list`/`workspace materialize` JSON
 * contracts. Deliberately hand-defined here rather than imported from
 * `@uniqbit/mate-core` — the extension treats the CLI's stdout as the only
 * process boundary (design decision 1) and must not bundle orchestration
 * internals or require lockstep package versions.
 */

export const SUPPORTED_INVENTORY_SCHEMA_VERSION = 1;
export const SUPPORTED_MATERIALIZED_SCHEMA_VERSION = 1;
export const SUPPORTED_SESSION_ENVELOPE_SCHEMA_VERSION = 1;
export const SUPPORTED_SESSION_ENVELOPE_RESOLUTION_SCHEMA_VERSION = 1;

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

export interface SessionEnvelopeCandidateV1 {
  schemaVersion: 1;
  repository: { id: string; path: string };
  companionPath: string;
}

export interface SessionEnvelopeCapabilityV1 {
  name: string;
  schemaProfile?: string;
}

export interface SessionEnvelopeV1 {
  schemaVersion: 1;
  host: string;
  repositoryLink: SessionEnvelopeCandidateV1;
  workingRepositoryPath: string;
  companionRepositoryPath: string;
  capabilities: SessionEnvelopeCapabilityV1[];
  renderedGuidance: string;
  permittedRoots: string[];
}

export interface SessionEnvelopeDiagnosticV1 {
  code: string;
  message: string;
  candidates: SessionEnvelopeCandidateV1[];
}

export interface SessionEnvelopeResolutionV1 {
  schemaVersion: 1;
  status: "resolved" | "diagnostic";
  envelope?: SessionEnvelopeV1;
  diagnostics: SessionEnvelopeDiagnosticV1[];
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

function validateSessionEnvelopeCandidate(entry: unknown): SessionEnvelopeCandidateV1 {
  if (!isRecord(entry) || entry.schemaVersion !== SUPPORTED_SESSION_ENVELOPE_SCHEMA_VERSION) {
    throw new InvalidMateResponseError("Invalid Session Envelope candidate schema version.");
  }
  if (!isRecord(entry.repository)) {
    throw new InvalidMateResponseError("Session Envelope candidate is missing a repository.");
  }
  const repository = entry.repository;
  if (
    !isNonEmptyString(entry.companionPath) ||
    !isNonEmptyString(repository.id) ||
    !isNonEmptyString(repository.path)
  ) {
    throw new InvalidMateResponseError(
      "Session Envelope candidate is missing a path or repository.",
    );
  }
  return {
    schemaVersion: 1,
    companionPath: entry.companionPath,
    repository: { id: repository.id, path: repository.path },
  };
}

function validateSessionEnvelope(entry: unknown): SessionEnvelopeV1 {
  if (!isRecord(entry) || entry.schemaVersion !== SUPPORTED_SESSION_ENVELOPE_SCHEMA_VERSION) {
    throw new InvalidMateResponseError("Invalid Session Envelope schema version.");
  }
  const { host, workingRepositoryPath, companionRepositoryPath, renderedGuidance, permittedRoots } =
    entry;
  if (
    !isNonEmptyString(host) ||
    !isNonEmptyString(workingRepositoryPath) ||
    !isNonEmptyString(companionRepositoryPath) ||
    typeof renderedGuidance !== "string" ||
    !Array.isArray(permittedRoots) ||
    !permittedRoots.every(isNonEmptyString) ||
    !Array.isArray(entry.capabilities)
  ) {
    throw new InvalidMateResponseError("Session Envelope is missing required context fields.");
  }
  const capabilities = entry.capabilities.map((capability) => {
    if (!isRecord(capability) || !isNonEmptyString(capability.name)) {
      throw new InvalidMateResponseError("Session Envelope contains an invalid capability.");
    }
    return {
      name: capability.name,
      ...(typeof capability.schemaProfile === "string"
        ? { schemaProfile: capability.schemaProfile }
        : {}),
    };
  });
  return {
    schemaVersion: 1,
    host,
    repositoryLink: validateSessionEnvelopeCandidate(entry.repositoryLink),
    workingRepositoryPath,
    companionRepositoryPath,
    capabilities,
    renderedGuidance,
    permittedRoots: [...permittedRoots],
  };
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

/** Validates one `mate workspace resolve --json` response. */
export function parseSessionEnvelopeResolution(raw: string): SessionEnvelopeResolutionV1 {
  const data = parseJson(raw, "Session Envelope resolution");
  if (!isRecord(data)) {
    throw new InvalidMateResponseError("Session Envelope resolution was not a JSON object.");
  }
  if (data.schemaVersion !== SUPPORTED_SESSION_ENVELOPE_RESOLUTION_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(
      data.schemaVersion,
      SUPPORTED_SESSION_ENVELOPE_RESOLUTION_SCHEMA_VERSION,
      "Session Envelope resolution",
    );
  }
  if (data.status !== "resolved" && data.status !== "diagnostic") {
    throw new InvalidMateResponseError("Session Envelope resolution has an unknown status.");
  }
  if (!Array.isArray(data.diagnostics)) {
    throw new InvalidMateResponseError("Session Envelope resolution is missing diagnostics.");
  }
  const diagnostics = data.diagnostics.map((diagnostic) => {
    if (
      !isRecord(diagnostic) ||
      !isNonEmptyString(diagnostic.code) ||
      !isNonEmptyString(diagnostic.message) ||
      !Array.isArray(diagnostic.candidates)
    ) {
      throw new InvalidMateResponseError(
        "Session Envelope resolution contains an invalid diagnostic.",
      );
    }
    return {
      code: diagnostic.code,
      message: diagnostic.message,
      candidates: diagnostic.candidates.map(validateSessionEnvelopeCandidate),
    };
  });
  const envelope = data.envelope === undefined ? undefined : validateSessionEnvelope(data.envelope);
  if (data.status === "resolved" && !envelope) {
    throw new InvalidMateResponseError(
      "Resolved Session Envelope response is missing its envelope.",
    );
  }
  if (data.status === "diagnostic" && envelope) {
    throw new InvalidMateResponseError(
      "Diagnostic Session Envelope response must not contain an envelope.",
    );
  }
  return {
    schemaVersion: 1,
    status: data.status,
    ...(envelope ? { envelope } : {}),
    diagnostics,
  };
}
