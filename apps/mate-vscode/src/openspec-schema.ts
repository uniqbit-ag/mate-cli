/**
 * Local mirror of `openspec list --json`'s contract. Hand-defined here for
 * the same reason as {@link ./schema}'s Mate mirrors: `openspec` is a
 * second, independent external CLI, and this extension must not assume
 * lockstep versioning with it.
 */

export interface OpenSpecChangeSummary {
  name: string;
  completedTasks: number;
  totalTasks: number;
  status: string;
}

export class InvalidOpenSpecResponseError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateChangeEntry(entry: unknown): OpenSpecChangeSummary {
  if (!isRecord(entry))
    throw new InvalidOpenSpecResponseError("Invalid change entry in openspec list.");
  const { name, completedTasks, totalTasks, status } = entry;
  if (!isNonEmptyString(name)) {
    throw new InvalidOpenSpecResponseError("Change entry is missing a name.");
  }
  if (typeof completedTasks !== "number" || typeof totalTasks !== "number") {
    throw new InvalidOpenSpecResponseError(`Change "${name}" is missing its task counts.`);
  }
  return {
    name,
    completedTasks,
    totalTasks,
    status: isNonEmptyString(status) ? status : "unknown",
  };
}

/** Validates one `openspec list --json` response. Task progress ships inline — no per-change follow-up call needed. */
export function parseOpenSpecChangeList(raw: string): OpenSpecChangeSummary[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new InvalidOpenSpecResponseError(
      `Could not parse openspec list response as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(data) || !Array.isArray(data.changes)) {
    throw new InvalidOpenSpecResponseError("openspec list response is missing a changes array.");
  }
  return data.changes.map(validateChangeEntry);
}

/** Extracts `changeRoot` from one `openspec status --change <name> --json` response — the only field the "open change" action needs. */
export function parseOpenSpecChangeRoot(raw: string): string {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new InvalidOpenSpecResponseError(
      `Could not parse openspec status response as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(data) || !isNonEmptyString(data.changeRoot)) {
    throw new InvalidOpenSpecResponseError("openspec status response is missing changeRoot.");
  }
  return data.changeRoot;
}
