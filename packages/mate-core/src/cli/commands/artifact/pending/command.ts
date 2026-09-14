import { hasOpenspecCapability } from "../../../../lib/orchestrator/capabilities";
import { resolveForCapability } from "../../../../lib/orchestrator/framework-context";
import type { LaunchContext } from "../../../../lib/orchestrator/framework-context";
import type { CapabilityConfig } from "../../../../lib/orchestrator/types";
import { WorkingRepoRequiredError } from "../../../../lib/orchestrator/types";
import { type BooleanFlagSet, parseFlags } from "../../../parse-flags";
import { ensureUnambiguousCompanion } from "../../shared/companion-selection";
import { defaultGitOps, type GitOps, type WorkingTreeChange } from "../finish/git";
import {
  discoverArchives,
  pendingArchives,
  unattributedSpecs,
  type ArchiveEntry,
  type UnattributedSpec,
} from "./discovery";

export interface PendingCommandDeps {
  ensureUnambiguousCompanion?: (cwd: string) => Promise<boolean>;
  resolveContext?: (cwd: string) => Promise<LaunchContext>;
  loadCapabilities?: (context: LaunchContext) => Promise<CapabilityConfig[]>;
  git?: (companionPath: string, workingRepoPath?: string) => GitOps;
  discover?: (
    companionPath: string,
    uncommittedPaths: string[],
    changeKinds?: Readonly<Record<string, WorkingTreeChange>>,
  ) => Promise<ArchiveEntry[]>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** Presence-only flags; every other `--flag` consumes the following token as its value. */
const BOOLEAN_FLAGS: BooleanFlagSet = new Set(["json"]);

/**
 * Whether `mate artifact publish --all` would publish this entry. Discovery does not know
 * about publication modes, so the marking is applied here rather than in the entry types.
 */
export interface AllCoverage {
  coveredByAll: boolean;
}

/** Machine-readable result emitted with `--json`. */
export interface PendingResult {
  type: string;
  companionPath: string;
  count: number;
  pending: Array<ArchiveEntry & AllCoverage>;
  /** Uncommitted canonical specs no pending change accounts for, each with its attribution. */
  unattributedSpecs: Array<UnattributedSpec & AllCoverage>;
}

/**
 * `--all` publishes every pending change and then every remaining drifted spec, so both
 * reported sets are covered in full — an unattributed spec included, whatever its
 * attribution, because a spec publication needs no archive to carry it.
 */
function markCoveredByAll<T>(entries: T[]): Array<T & AllCoverage> {
  return entries.map((entry) => ({ ...entry, coveredByAll: true }));
}

async function defaultLoadCapabilities(context: LaunchContext): Promise<CapabilityConfig[]> {
  const config = await context.configStore.load();
  return config.capabilities ?? [];
}

/** Attribution is printed as candidate archives, never as a claim about which one is responsible. */
function renderUnattributed(specs: Array<UnattributedSpec & AllCoverage>): string[] {
  if (specs.length === 0) return [];
  return [
    "",
    `${specs.length} uncommitted spec${specs.length === 1 ? "" : "s"} not accounted for by a pending change:`,
    ...specs.flatMap((spec) => [
      `  ${spec.path}  [${spec.kind}]${spec.coveredByAll ? "  [--all]" : ""}`,
      ...(spec.touchedByArchives.length === 0
        ? ["       no archive names this spec"]
        : spec.touchedByArchives.map(
            (archive) => `       publishes via ${archive.anchor}  (archive ${archive.state})`,
          )),
    ]),
  ];
}

function renderHuman(result: PendingResult): string[] {
  const pending =
    result.count === 0
      ? ["No archived changes have uncommitted content."]
      : [
          `${result.count} archived change${result.count === 1 ? "" : "s"} pending publication:`,
          ...result.pending.flatMap((entry, index) => [
            `  ${index + 1}. ${entry.name}  ${entry.tag}  ${entry.path}${entry.coveredByAll ? "  [--all]" : ""}`,
            ...entry.uncommittedPaths.map((uncommitted) => `       ${uncommitted}`),
            ...entry.uncommittedSpecs.map((spec) => `       ${spec}`),
          ]),
        ];
  return [...pending, ...renderUnattributed(result.unattributedSpecs)];
}

/**
 * @command mate artifact pending
 * @description Lists archived OpenSpec changes whose own files — the archive directory or
 * the active directory archiving deleted — are still uncommitted in the companion working
 * tree, each with the uncommitted canonical specs it applied to, so the publication
 * workflow can offer exact selectable entries instead of parsing OpenSpec prose.
 * Uncommitted specs no pending change accounts for are reported separately, each with the
 * archives whose delta specs name it. Every reported entry carries `coveredByAll`, marking
 * what `mate artifact publish --all` would publish. Read-only:
 * nothing is validated, produced, committed, tagged, or pushed.
 * @flags
 * - `--json` — emit a machine-readable {@link PendingResult} instead of human-readable text.
 * @remarks No-ops (with a message on stderr) when the openspec capability is disabled for
 * this repo. Exits non-zero only when the companion, launch context, or Git guard rejects.
 */
export async function runArtifactPendingCommand(
  argv: string[],
  deps: PendingCommandDeps = {},
): Promise<void> {
  const emitOut = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emitErr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const json = parseFlags(argv, BOOLEAN_FLAGS).json === true;

  const ensureCompanion = deps.ensureUnambiguousCompanion ?? ensureUnambiguousCompanion;
  if (!(await ensureCompanion(process.cwd()))) {
    process.exitCode = 1;
    return;
  }

  const resolveContext = deps.resolveContext ?? ((cwd: string) => resolveForCapability(cwd));
  let context: LaunchContext;
  try {
    context = await resolveContext(process.cwd());
  } catch (err) {
    if (err instanceof WorkingRepoRequiredError) {
      emitErr(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const loadCapabilities = deps.loadCapabilities ?? defaultLoadCapabilities;
  if (!hasOpenspecCapability(await loadCapabilities(context))) {
    emitErr("mate: the openspec capability must be enabled to list pending artifacts.");
    return;
  }

  let git: GitOps;
  try {
    git = (deps.git ?? defaultGitOps)(
      context.companionPath,
      context.repository?.path ?? process.env.MATE_REPO_PATH,
    );
  } catch (err) {
    emitErr(`mate: pending Git guard rejected the target: ${String(err)}`);
    process.exitCode = 1;
    return;
  }

  const discover = deps.discover ?? discoverArchives;
  const changed = await git.changedPaths();
  const changeKinds = (await git.changedPathKinds?.()) ?? {};
  const archives = await discover(context.companionPath, changed, changeKinds);
  const pending = pendingArchives(archives);
  const result: PendingResult = {
    type: "openspec",
    companionPath: context.companionPath,
    count: pending.length,
    pending: markCoveredByAll(pending),
    unattributedSpecs: markCoveredByAll(
      await unattributedSpecs(context.companionPath, changed, archives, changeKinds),
    ),
  };

  if (json) emitOut(JSON.stringify(result));
  else for (const line of renderHuman(result)) emitOut(line);
}
