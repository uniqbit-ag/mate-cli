import { hasOpenspecCapability } from "../../../../lib/orchestrator/capabilities";
import { resolveForCapability } from "../../../../lib/orchestrator/framework-context";
import type { LaunchContext } from "../../../../lib/orchestrator/framework-context";
import type { CapabilityConfig } from "../../../../lib/orchestrator/types";
import { WorkingRepoRequiredError } from "../../../../lib/orchestrator/types";
import { type BooleanFlagSet, parseFlags } from "../../../parse-flags";
import { ensureUnambiguousCompanion } from "../../shared/companion-selection";
import { defaultGitOps, type GitOps } from "../finish/git";
import {
  discoverArchives,
  pendingArchives,
  unattributedSpecs,
  type ArchiveEntry,
} from "./discovery";

export interface PendingCommandDeps {
  ensureUnambiguousCompanion?: (cwd: string) => Promise<boolean>;
  resolveContext?: (cwd: string) => Promise<LaunchContext>;
  loadCapabilities?: (context: LaunchContext) => Promise<CapabilityConfig[]>;
  git?: (companionPath: string, workingRepoPath?: string) => GitOps;
  discover?: (companionPath: string, uncommittedPaths: string[]) => Promise<ArchiveEntry[]>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** Presence-only flags; every other `--flag` consumes the following token as its value. */
const BOOLEAN_FLAGS: BooleanFlagSet = new Set(["json"]);

/** Machine-readable result emitted with `--json`. */
export interface PendingResult {
  type: string;
  companionPath: string;
  count: number;
  pending: ArchiveEntry[];
  /** Uncommitted canonical specs no pending change accounts for. */
  unattributedSpecs: string[];
}

async function defaultLoadCapabilities(context: LaunchContext): Promise<CapabilityConfig[]> {
  const config = await context.configStore.load();
  return config.capabilities ?? [];
}

function renderUnattributed(specs: string[]): string[] {
  if (specs.length === 0) return [];
  return [
    "",
    `${specs.length} uncommitted spec${specs.length === 1 ? "" : "s"} not accounted for by a pending change:`,
    ...specs.map((spec) => `  ${spec}`),
  ];
}

function renderHuman(result: PendingResult): string[] {
  const pending =
    result.count === 0
      ? ["No archived changes have uncommitted content."]
      : [
          `${result.count} archived change${result.count === 1 ? "" : "s"} pending publication:`,
          ...result.pending.flatMap((entry, index) => [
            `  ${index + 1}. ${entry.name}  ${entry.tag}  ${entry.path}`,
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
 * Uncommitted specs no pending change accounts for are reported separately. Read-only:
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
  const pending = pendingArchives(await discover(context.companionPath, changed));
  const result: PendingResult = {
    type: "openspec",
    companionPath: context.companionPath,
    count: pending.length,
    pending,
    unattributedSpecs: unattributedSpecs(changed, pending),
  };

  if (json) emitOut(JSON.stringify(result));
  else for (const line of renderHuman(result)) emitOut(line);
}
