/**
 * Local mirror of `mate doctor --json`'s contract (see
 * `packages/mate-core/src/cli/commands/doctor.ts`), for the same reason as
 * `./schema`'s workspace-inventory mirrors: the extension treats stdout as
 * the only process boundary, never `@uniqbit/mate-core` internals.
 *
 * The real report has no file-scoped vs. workspace-scoped distinction —
 * every field here is workspace-scoped except `hub.members[].path` and
 * `resolutionFailures[].companionPath`, which name a concrete directory on
 * disk. Parsing is deliberately lenient (missing/malformed optional
 * sections are dropped, not fatal) since this is a best-effort second
 * surface, not the tree-item tooltip health this extension already relies on.
 */

export interface DoctorToolInstallation {
  tool: string;
  status: "ok" | "missing";
}

export interface DoctorRequiredPluginDrift {
  pluginId: string;
  reason: string;
}

export interface DoctorEngineRequirement {
  ok: boolean;
  detail: string;
}

export interface DoctorHubMember {
  id: string;
  path: string;
  exists: boolean;
  commitStatus: "ok" | "drifted" | "missing" | "unknown";
}

export interface DoctorResolutionFailure {
  companionPath: string;
  message: string;
}

export interface DoctorReport {
  multipleCompanions: Array<{ companionPath: string; repositoryId: string }>;
  policyError?: string;
  toolInstallations: DoctorToolInstallation[];
  requiredPluginDrift: DoctorRequiredPluginDrift[];
  engineRequirement?: DoctorEngineRequirement;
  hubMembers: DoctorHubMember[];
  resolutionFailures: DoctorResolutionFailure[];
}

export class InvalidDoctorResponseError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function toolInstallations(value: unknown): DoctorToolInstallation[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .filter((entry) => isNonEmptyString(entry.tool))
    .map((entry) => ({
      tool: entry.tool as string,
      status: entry.status === "missing" ? "missing" : "ok",
    }));
}

function requiredPluginDrift(value: unknown): DoctorRequiredPluginDrift[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .filter((entry) => isNonEmptyString(entry.pluginId))
    .map((entry) => ({
      pluginId: entry.pluginId as string,
      reason: isNonEmptyString(entry.reason) ? entry.reason : "required plugin drift detected",
    }));
}

function engineRequirement(value: unknown): DoctorEngineRequirement | undefined {
  if (!isRecord(value) || typeof value.ok !== "boolean") return undefined;
  return { ok: value.ok, detail: isNonEmptyString(value.detail) ? value.detail : "" };
}

function hubMembers(value: unknown): DoctorHubMember[] {
  if (!isRecord(value) || !Array.isArray(value.members)) return [];
  return value.members
    .filter(isRecord)
    .filter((entry) => isNonEmptyString(entry.id) && isNonEmptyString(entry.path))
    .map((entry) => ({
      id: entry.id as string,
      path: entry.path as string,
      exists: entry.exists === true,
      commitStatus:
        entry.commitStatus === "drifted" ||
        entry.commitStatus === "missing" ||
        entry.commitStatus === "unknown"
          ? entry.commitStatus
          : "ok",
    }));
}

function resolutionFailures(value: unknown): DoctorResolutionFailure[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .filter((entry) => isNonEmptyString(entry.companionPath) && isNonEmptyString(entry.message))
    .map((entry) => ({
      companionPath: entry.companionPath as string,
      message: entry.message as string,
    }));
}

/** Validates one `mate doctor --json` response. Only the top level must be a JSON object; every field is best-effort. */
export function parseDoctorReport(raw: string): DoctorReport {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new InvalidDoctorResponseError(
      `Could not parse mate doctor response as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(data)) {
    throw new InvalidDoctorResponseError("mate doctor --json response was not a JSON object.");
  }

  return {
    multipleCompanions: Array.isArray(data.multipleCompanions)
      ? data.multipleCompanions
          .filter(isRecord)
          .filter(
            (entry) =>
              isNonEmptyString(entry.companionPath) && isNonEmptyString(entry.repositoryId),
          )
          .map((entry) => ({
            companionPath: entry.companionPath as string,
            repositoryId: entry.repositoryId as string,
          }))
      : [],
    policyError: isNonEmptyString(data.policyError) ? data.policyError : undefined,
    toolInstallations: toolInstallations(data.toolInstallations),
    requiredPluginDrift: requiredPluginDrift(data.requiredPluginDrift),
    engineRequirement: engineRequirement(data.engineRequirement),
    hubMembers: hubMembers(data.hub),
    resolutionFailures: resolutionFailures(data.resolutionFailures),
  };
}
