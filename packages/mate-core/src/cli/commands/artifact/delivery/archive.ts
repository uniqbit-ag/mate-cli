import { companionRelative } from "../../../../lib/delivery/environment";
import { archiveWarnings, type ArchiveWarning } from "../../../../lib/delivery/overlap";
import {
  isPublishable,
  locateChangeDir,
  settleDelivery,
  type DeliveryRecord,
  type DeliverySettlement,
} from "../../../../lib/delivery/record";
import {
  recordDelivery,
  type DeliveryRefusal,
  type RecordDeliveryDeps,
} from "../../../../lib/delivery/record-delivery";
import type { BranchOutcome } from "../../../../lib/delivery/refresh";
import { runOpenSpec, type RunOpenSpec } from "../../../../lib/openspec-cli";
import { type BooleanFlagSet, parseFlags, positionalArgs } from "../../../parse-flags";
import {
  branchFlagsFrom,
  canonicalRepository,
  deliveryEditFrom,
  DIRECT_NEEDS_BRANCH,
  repositoryFlag,
  valueFlagError,
} from "./branch-flags";
import { resolveDeliveryEnvironment, type DeliveryEnvironmentDeps } from "./environment";
import {
  commandOutput,
  renderDelivery,
  sharedRefusalMessage,
  unscopedDeliveryWarning,
} from "./output";

export interface ArchiveCommandDeps extends DeliveryEnvironmentDeps, RecordDeliveryDeps {
  runOpenSpec?: RunOpenSpec;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const BOOLEAN_FLAGS: BooleanFlagSet = new Set(["json", "direct", "skip-branch"]);

export type ArchiveStatus = "archived" | "needs-branch" | "failed";

export interface ArchiveResult {
  status: ArchiveStatus;
  change: string;
  /** Companion-relative archive directory, once archived. */
  path: string | null;
  record: DeliveryRecord;
  settlement: DeliverySettlement;
  outcomes: BranchOutcome[];
  warnings: ArchiveWarning[];
  /** `needs-branch` only: the branch to suggest, when it exists. */
  suggestedBranch?: string | null;
  message: string;
}

function refusalMessage(refusal: DeliveryRefusal): string {
  if (refusal.reason === "unknown-change") {
    return `mate: no active change named "${refusal.change}" to archive.`;
  }
  return sharedRefusalMessage(refusal);
}

/** Warnings are not repeated here: they go to stderr before anything is archived. */
function renderHuman(result: ArchiveResult): string[] {
  return [
    result.message,
    ...result.record.deliveries.map(renderDelivery),
    `  delivery: ${result.settlement.status}`,
  ];
}

/**
 * @command mate artifact archive <change>
 * @description Archives an active change whether or not its delivery is merged, so a
 * feature's later changes build on its canonical specs. Writes overlap and dependency
 * warnings to stderr before archiving, refreshes merge state from the forge when a token
 * is available, always leaves a `delivery.yaml` (unlinked when none was recorded), then
 * runs `openspec archive` with the bundled CLI. Merge state is reported, never a refusal.
 * @flags
 * - `--repository <org/repo>` — the delivery `--branch` or `--not-applicable` records; defaults
 *   to the Working Repository.
 * - `--branch <branch>` / `--direct` — record the delivery branch first, as `artifact link`.
 * - `--not-applicable <reason>` — record that no branch delivers this change.
 * - `--skip-branch` — archive with an unlinked record when the user skips the question.
 * - `--json` — emit an {@link ArchiveResult}.
 * @remarks Without a recorded delivery and none of the branch flags, nothing is archived:
 * the result is `needs-branch`, a question rather than a refusal (exit 0), with
 * `change/<change-name>` suggested when that branch exists, so the caller can ask the user.
 */
export async function runArtifactArchiveCommand(
  argv: string[],
  deps: ArchiveCommandDeps = {},
): Promise<void> {
  const { emitOut, emitErr, refuse } = commandOutput(deps);
  const flags = parseFlags(argv, BOOLEAN_FLAGS);
  const flagError = valueFlagError(flags, ["repository", "branch", "not-applicable"]);
  if (flagError) return refuse(flagError);
  const json = flags.json === true;
  const [change] = positionalArgs(argv, BOOLEAN_FLAGS);
  const branchFlags = branchFlagsFrom(flags);
  const { branch, notApplicable } = branchFlags;
  const skip = flags["skip-branch"] === true;

  if (!change) return refuse("mate: artifact archive requires a change name.");
  if ([branch !== undefined, notApplicable !== undefined, skip].filter(Boolean).length > 1) {
    return refuse("mate: pass only one of --branch, --not-applicable, or --skip-branch.");
  }
  if (branchFlags.direct && branch === undefined) return refuse(DIRECT_NEEDS_BRANCH);
  const requested = repositoryFlag(flags);
  if ("error" in requested) return refuse(requested.error);
  if (requested.repository !== undefined && branch === undefined && notApplicable === undefined) {
    return refuse("mate: --repository names the delivery --branch or --not-applicable records.");
  }

  const environment = await resolveDeliveryEnvironment(deps);
  if ("error" in environment) return refuse(environment.error);
  const repository = canonicalRepository(environment, requested.repository);
  const delivery = deliveryEditFrom(branchFlags);
  const outcome = await recordDelivery(
    environment,
    {
      changes: [change],
      ...(repository ? { repository } : {}),
      ...(delivery ? { edit: { delivery } } : {}),
      refresh: true,
      requireDelivery: !skip,
    },
    deps,
  );
  if ("refusal" in outcome) return refuse(refusalMessage(outcome.refusal));

  const warnings = await archiveWarnings(environment.companionPath, change);
  const emit = (result: ArchiveResult): void => {
    if (json) emitOut(JSON.stringify(result));
    else for (const line of renderHuman(result)) emitOut(line);
  };

  // A `needs-branch` run archives nothing, so its warnings go to stderr only on the re-run.
  if ("needsBranch" in outcome) {
    const { record, suggestedBranch } = outcome.needsBranch;
    return emit({
      status: "needs-branch",
      change,
      path: null,
      record,
      settlement: settleDelivery(record),
      outcomes: [],
      warnings,
      suggestedBranch,
      message: `No delivery branch is recorded for ${change}. Re-run with --branch <branch>, --not-applicable <reason>, or --skip-branch.`,
    });
  }

  const [{ record, settlement, outcomes }] = outcome.results;
  for (const warning of warnings) emitErr(`warning: ${warning.message}`);
  for (const entry of settlement.unscoped) emitErr(unscopedDeliveryWarning(change, entry));

  const run = await (deps.runOpenSpec ?? runOpenSpec)(["archive", change, "--yes"], {
    cwd: environment.companionPath,
  });
  if (run.code !== 0) {
    process.exitCode = 1;
    const detail = (run.stderr.trim() || run.stdout.trim()).split("\n").slice(-5).join("\n");
    return emit({
      status: "failed",
      change,
      path: null,
      record,
      settlement,
      outcomes,
      warnings,
      message: `openspec archive ${change} failed (exit ${run.code ?? "unknown"}): ${detail}`,
    });
  }

  const archived = await locateChangeDir(environment.companionPath, change);
  const archivePath = archived?.archived ? companionRelative(environment, archived.dir) : null;
  emit({
    status: "archived",
    change,
    path: archivePath,
    record,
    settlement,
    outcomes,
    warnings,
    message: archivedMessage(change, settlement),
  });
}

function archivedMessage(change: string, settlement: DeliverySettlement): string {
  if (isPublishable(settlement.status)) {
    return `Archived ${change}; it can be published with mate-publish-artifact.`;
  }
  const missing =
    settlement.missing.length > 0
      ? ` No delivery is recorded for ${settlement.missing.join(", ")}, which its scopes name.`
      : "";
  return `Archived ${change}; publication waits until its delivery is merged (${settlement.status}).${missing}`;
}
