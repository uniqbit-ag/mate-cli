import { hasOpenspecCapability } from "../../../../lib/orchestrator/capabilities";
import { resolveForCapability } from "../../../../lib/orchestrator/framework-context";
import type { LaunchContext } from "../../../../lib/orchestrator/framework-context";
import type { CapabilityConfig } from "../../../../lib/orchestrator/types";
import { WorkingRepoRequiredError } from "../../../../lib/orchestrator/types";
import { type BooleanFlagSet, parseFlags } from "../../../parse-flags";
import { ensureUnambiguousCompanion } from "../../shared/companion-selection";
import { defaultGitOps, type GitOps } from "../finish/git";
import { discoverArchives, pendingArchives, type ArchiveEntry } from "./discovery";

export interface PendingCommandDeps {
  ensureUnambiguousCompanion?: (cwd: string) => Promise<boolean>;
  resolveContext?: (cwd: string) => Promise<LaunchContext>;
  loadCapabilities?: (context: LaunchContext) => Promise<CapabilityConfig[]>;
  git?: (companionPath: string, workingRepoPath?: string) => GitOps;
  discover?: (
    companionPath: string,
    tagExists: (name: string) => Promise<boolean>,
  ) => Promise<ArchiveEntry[]>;
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
}

async function defaultLoadCapabilities(context: LaunchContext): Promise<CapabilityConfig[]> {
  const config = await context.configStore.load();
  return config.capabilities ?? [];
}

function renderHuman(result: PendingResult): string[] {
  if (result.count === 0) return ["No archived changes are pending publication."];
  return [
    `${result.count} archived change${result.count === 1 ? "" : "s"} pending publication:`,
    ...result.pending.map(
      (entry, index) => `  ${index + 1}. ${entry.name}  ${entry.tag}  ${entry.path}`,
    ),
  ];
}

/**
 * @command mate artifact pending
 * @description Lists archived OpenSpec changes that have no local finish marker, so the
 * publication workflow can offer exact selectable entries instead of parsing OpenSpec
 * prose. Read-only: nothing is validated, produced, committed, tagged, or pushed.
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
  const pending = pendingArchives(
    await discover(context.companionPath, (name) => git.tagExists(name)),
  );
  const result: PendingResult = {
    type: "openspec",
    companionPath: context.companionPath,
    count: pending.length,
    pending,
  };

  if (json) emitOut(JSON.stringify(result));
  else for (const line of renderHuman(result)) emitOut(line);
}
