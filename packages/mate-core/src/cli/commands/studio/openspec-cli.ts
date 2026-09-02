import { spawn } from "node:child_process";
import path from "node:path";

import { getWrapperBinPath } from "../../../lib/package-paths";

export interface OpenSpecFailure {
  command: string;
  reason: string;
}

export type OpenSpecResult<T> = { ok: true; value: T } | { ok: false; failure: OpenSpecFailure };

export interface OpenSpecRunOutput {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface OpenSpecCliDeps {
  wrapperPath?: () => string;
  run?: (bin: string, args: string[], companionPath: string) => Promise<OpenSpecRunOutput>;
}

/** The Capability whose CLI produces the workflow a companion's changes move through. */
export const WORKFLOW_CAPABILITY_ID = "openspec";

/** Upper bound on one collection call; a hung wrapper must not hold a request open. */
const OPENSPEC_TIMEOUT_MS = 60_000;

export function openSpecWrapperPath(): string {
  return path.join(getWrapperBinPath(), "openspec");
}

/**
 * The wrapper resolves its OpenSpec root from `MATE_ARTIFACT_PATH`, so the
 * companion is selected by environment rather than by cwd — the studio server
 * has no Repository Link to walk up from.
 */
function runOpenSpecWrapper(
  bin: string,
  args: string[],
  companionPath: string,
): Promise<OpenSpecRunOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: companionPath,
      env: { ...process.env, MATE_ARTIFACT_PATH: companionPath },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: OPENSPEC_TIMEOUT_MS,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code }));
  });
}

function firstJsonValue(stdout: string): unknown {
  const start = stdout.search(/[[{]/);
  if (start < 0) return undefined;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
}

function reasonFor(output: OpenSpecRunOutput): string {
  const detail = (output.stderr.trim() || output.stdout.trim()).split("\n").slice(-3).join("; ");
  const status = `exit code ${output.code ?? "unknown"}`;
  return detail ? `${status}: ${detail}` : status;
}

/**
 * Reads one OpenSpec JSON command for a Companion Repository. Never throws:
 * every failure — spawn, exit status, unparseable output — becomes a typed
 * failure so one unreadable companion cannot take the server down.
 */
export async function readOpenSpecJson<T>(
  companionPath: string,
  args: string[],
  deps: OpenSpecCliDeps = {},
): Promise<OpenSpecResult<T>> {
  const bin = (deps.wrapperPath ?? openSpecWrapperPath)();
  const command = `openspec ${args.join(" ")}`;
  const run = deps.run ?? runOpenSpecWrapper;

  let output: OpenSpecRunOutput;
  try {
    output = await run(bin, args, companionPath);
  } catch (error) {
    return {
      ok: false,
      failure: { command, reason: error instanceof Error ? error.message : String(error) },
    };
  }

  // `validate` exits non-zero when it finds issues, and its JSON report is
  // exactly what Studio wants in that case — parseable stdout wins over status.
  const parsed = firstJsonValue(output.stdout);
  if (parsed !== undefined) return { ok: true, value: parsed as T };

  if (output.code !== 0) return { ok: false, failure: { command, reason: reasonFor(output) } };
  return { ok: false, failure: { command, reason: `${command} did not return JSON` } };
}

export interface OpenSpecChangeListEntry {
  name: string;
  completedTasks?: number;
  totalTasks?: number;
  status?: string;
  lastModified?: string;
}

export interface OpenSpecChangeList {
  changes?: OpenSpecChangeListEntry[];
}

export interface OpenSpecSpecListEntry {
  id: string;
  requirementCount?: number;
}

export interface OpenSpecSpecList {
  specs?: OpenSpecSpecListEntry[];
}

export interface OpenSpecArtifactStatus {
  id: string;
  status?: string;
  outputPath?: string;
  requires?: string[];
}

export interface OpenSpecChangeStatusEntry {
  changeName: string;
  schemaName?: string;
  isComplete?: boolean;
  isPlanningComplete?: boolean;
  planningHome?: { root?: string; defaultSchema?: string };
  artifacts?: OpenSpecArtifactStatus[];
}

export interface OpenSpecAllChangeStatus {
  changes?: OpenSpecChangeStatusEntry[];
}

export interface OpenSpecValidationItem {
  id: string;
  type?: string;
  valid?: boolean;
  issues?: { level?: string; path?: string; message?: string }[];
}

export interface OpenSpecValidationReport {
  items?: OpenSpecValidationItem[];
}

export function listChanges(
  companionPath: string,
  deps: OpenSpecCliDeps = {},
): Promise<OpenSpecResult<OpenSpecChangeList>> {
  return readOpenSpecJson(companionPath, ["list", "--json"], deps);
}

export function listSpecs(
  companionPath: string,
  deps: OpenSpecCliDeps = {},
): Promise<OpenSpecResult<OpenSpecSpecList>> {
  return readOpenSpecJson(companionPath, ["list", "--specs", "--json"], deps);
}

export function readAllChangeStatus(
  companionPath: string,
  deps: OpenSpecCliDeps = {},
): Promise<OpenSpecResult<OpenSpecAllChangeStatus>> {
  return readOpenSpecJson(companionPath, ["status", "--all", "--json"], deps);
}

/**
 * `validate --json` without a selector prints help and exits non-zero, so the
 * whole-root report is the `--all` form.
 */
export function validateAll(
  companionPath: string,
  deps: OpenSpecCliDeps = {},
): Promise<OpenSpecResult<OpenSpecValidationReport>> {
  return readOpenSpecJson(companionPath, ["validate", "--all", "--json"], deps);
}
