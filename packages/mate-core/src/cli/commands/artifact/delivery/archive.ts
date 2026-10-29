import {
  archiveChange,
  type ArchiveChangeDeps,
  type ArchiveResult,
} from "../../../../lib/delivery/archive-change";
import type { DeliveryRefusal } from "../../../../lib/delivery/record-delivery";
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

export interface ArchiveCommandDeps
  extends DeliveryEnvironmentDeps, Omit<ArchiveChangeDeps, "onWarnings"> {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const BOOLEAN_FLAGS: BooleanFlagSet = new Set(["json", "direct", "skip-branch"]);

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
 * feature's later changes build on its canonical specs. Writes overlap, dependency, and
 * incomplete-planning warnings to stderr before archiving, refreshes merge state from the forge when a token
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
  const outcome = await archiveChange(
    environment,
    {
      change,
      ...(repository ? { repository } : {}),
      ...(delivery ? { delivery } : {}),
      skipBranch: skip,
    },
    {
      ...deps,
      onWarnings: (warnings, unscoped) => {
        for (const warning of warnings) emitErr(`warning: ${warning.message}`);
        for (const entry of unscoped) emitErr(unscopedDeliveryWarning(change, entry));
      },
    },
  );
  if ("refusal" in outcome) return refuse(refusalMessage(outcome.refusal));

  const { result } = outcome;
  if (result.status === "failed") process.exitCode = 1;
  if (json) emitOut(JSON.stringify(result));
  else for (const line of renderHuman(result)) emitOut(line);
}
