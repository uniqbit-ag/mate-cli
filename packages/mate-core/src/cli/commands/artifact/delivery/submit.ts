import type { DeliveryRefusal } from "../../../../lib/delivery/record-delivery";
import type { dropSubmitted, DropResult } from "../../../../lib/delivery/staging/submit";
import {
  dropChanges,
  submitChanges,
  type SubmitChangeDeps,
  type SubmitResult,
} from "../../../../lib/delivery/submit-change";
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
  renderOutcome,
  sharedRefusalMessage,
  unscopedDeliveryWarning,
} from "./output";

export interface SubmitCommandDeps
  extends DeliveryEnvironmentDeps, Omit<SubmitChangeDeps, "onWarnings"> {
  dropSubmitted?: typeof dropSubmitted;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const BOOLEAN_FLAGS: BooleanFlagSet = new Set(["json", "direct", "skip-branch", "fetch", "drop"]);

function refusalMessage(refusal: DeliveryRefusal): string {
  if (refusal.reason === "unknown-change") {
    return `mate: no active change named "${refusal.change}" to submit.`;
  }
  return sharedRefusalMessage(refusal);
}

/** Warnings are not repeated here: they go to stderr before anything is pushed. */
function renderHuman(result: SubmitResult): string[] {
  return [
    result.message,
    ...result.record.deliveries.map(renderDelivery),
    ...result.outcomes.flatMap(renderOutcome),
    `  delivery: ${result.settlement.status}`,
    ...(result.secretFindings ?? []).map(
      (finding) => `  secret: ${finding.path}:${finding.line} (${finding.ruleId})`,
    ),
  ];
}

/**
 * @command mate artifact submit <change>...
 * @description Submits finished changes, each with its whole Workset, for publication before
 * their delivery is merged. Per named change: records and refreshes the delivery as
 * `artifact link` would, writes overlap, dependency, incomplete-planning and Delivery Group
 * warnings to stderr, and runs the artifact type's check (`openspec validate <change>
 * --strict`). The other active changes of its Delivery Group (`<repository>/<delivery-branch>`,
 * or `change/<change>` without a branch) in this checkout join when all their tasks are
 * checked. The group is then pushed whole, in one secret-scanned commit that sets
 * `state: submitted` in each `delivery.yaml` and carries a `Mate-Transaction` trailer, to the
 * pending branch, the inbox `mate/inbox`. While a member has open tasks or fails its check the
 * group answers `waiting`, naming it, and nothing is pushed or changed. The commit is built in a
 * temporary worktree, pushed without force and rebuilt up to three times; the checkout is not
 * touched.
 * Nothing is archived and no canonical spec is written; publication does that after the merge.
 * @flags
 * - `--drop` — instead drop each named change: set `state: dropped` in a local copy and remove
 *   its folder from the pending branch, from any machine.
 * - `--repository <org/repo>` — the delivery `--branch` or `--not-applicable` records; defaults
 *   to the Working Repository.
 * - `--branch <branch>` / `--direct` — record the delivery branch first, as `artifact link`.
 * - `--not-applicable <reason>` — record that no branch delivers this change.
 * - `--skip-branch` — submit with an unlinked record when the user skips the question, so
 *   publication asks again.
 * - `--fetch` — fetch the default and delivery branches before the merge check even when the
 *   companion's Git mode is not `auto`.
 * - `--json` — emit an array of {@link SubmitResult} (with `--drop`, of drop results), one per
 *   change.
 * @remarks `needs-branch` and `waiting` are answers, not refusals (exit 0). A change whose plan
 * leaves a required stage before `submit` open (unchecked tasks, or no tasks) is submitted with a
 * warning of kind `stage-open` naming the stage, what is open and the skill to run. Submitting
 * counts every other step before `mate-submit-change` that was not reported with
 * `mate workflow done`, named in a warning of kind `step-counted`. Like every warning neither
 * blocks. A failed check
 * or push exits non-zero and changes no state; running submit again retries, and an unchanged
 * resubmit adds no commit. A change is `submitted` only once it is on the pending branch.
 * Refused, with nothing recorded, when Git would settle a named change's delivery as merged
 * while a work tree that has its branch checked out holds modified tracked files.
 */
export async function runArtifactSubmitCommand(
  argv: string[],
  deps: SubmitCommandDeps = {},
  options: { holdPush?: boolean } = {},
): Promise<void> {
  const { emitOut, emitErr, refuse } = commandOutput(deps);
  const flags = parseFlags(argv, BOOLEAN_FLAGS);
  const flagError = valueFlagError(flags, ["repository", "branch", "not-applicable"]);
  if (flagError) return refuse(flagError);
  const json = flags.json === true;
  const changes = positionalArgs(argv, BOOLEAN_FLAGS);
  const branchFlags = branchFlagsFrom(flags);
  const { branch, notApplicable } = branchFlags;
  const skip = flags["skip-branch"] === true;

  if (changes.length === 0) return refuse("mate: artifact submit requires a change name.");
  if (flags.drop === true) {
    const environment = await resolveDeliveryEnvironment(deps);
    if ("error" in environment) return refuse(environment.error);
    const dropped: DropResult[] = await dropChanges(environment.companionPath, changes, {
      ...deps,
      ...(environment.artifactType ? { artifactType: environment.artifactType } : {}),
    });
    if (dropped.some((result) => result.status === "refused")) process.exitCode = 1;
    if (json) emitOut(JSON.stringify(dropped));
    else for (const result of dropped) emitOut(result.message);
    return;
  }
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
  const outcome = await submitChanges(
    environment,
    {
      changes,
      ...(repository ? { repository } : {}),
      ...(delivery ? { delivery } : {}),
      skipBranch: skip,
      fetch: flags.fetch === true,
      ...(options.holdPush ? { holdPush: true } : {}),
    },
    {
      ...deps,
      onWarnings: (change, warnings, unscoped) => {
        for (const warning of warnings) emitErr(`warning: ${warning.message}`);
        for (const entry of unscoped) emitErr(unscopedDeliveryWarning(change, entry));
      },
    },
  );
  if ("refusal" in outcome) return refuse(refusalMessage(outcome.refusal));

  const { results } = outcome;
  for (const result of results) {
    for (const diagnostic of result.diagnostics) emitErr(`warning: ${diagnostic}`);
  }
  if (results.some((result) => result.status === "failed")) process.exitCode = 1;
  if (json) emitOut(JSON.stringify(results));
  else for (const result of results) for (const line of renderHuman(result)) emitOut(line);
}
