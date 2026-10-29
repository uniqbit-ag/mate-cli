import {
  recordDelivery,
  type DeliveryRefusal,
  type DeliveryResult,
  type RecordDeliveryDeps,
} from "../../../../lib/delivery/record-delivery";
import { applyWarnings, type DependencyWarning } from "../../../../lib/delivery/overlap";
import type { MergeState } from "../../../../lib/delivery/record";
import { type BooleanFlagSet, parseFlags, positionalArgs, stringFlag } from "../../../parse-flags";
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

export interface LinkCommandDeps extends DeliveryEnvironmentDeps, RecordDeliveryDeps {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const BOOLEAN_FLAGS: BooleanFlagSet = new Set([
  "json",
  "refresh",
  "direct",
  "confirm-merged",
  "confirm-open",
  "confirm-dropped",
]);

const CONFIRMATIONS: Record<string, MergeState> = {
  "confirm-merged": "merged",
  "confirm-open": "open",
  "confirm-dropped": "closed-unmerged",
};

/** `warnings`: declared dependencies not implemented yet; they inform and never block. */
export type LinkResult = DeliveryResult & { warnings: DependencyWarning[] };

function refusalMessage(refusal: DeliveryRefusal): string {
  if (refusal.reason === "unknown-change") {
    return `mate: no active or archived change named "${refusal.change}".`;
  }
  return sharedRefusalMessage(refusal);
}

function renderHuman(result: LinkResult): string[] {
  const lines = [`${result.change}: ${result.settlement.status}`];
  lines.push(...result.record.deliveries.map(renderDelivery));
  for (const repository of result.settlement.missing) {
    lines.push(`  ${repository}: no delivery recorded (named in the change's scopes)`);
  }
  for (const outcome of result.outcomes.filter((entry) => entry.needsAnswer)) {
    lines.push(`  ${outcome.branch}: needs an answer (${outcome.answerReason})`);
    if (outcome.failure) lines.push(`    ${outcome.failure.message}`);
    for (const candidate of outcome.candidates ?? []) {
      lines.push(`    #${candidate.number} ${candidate.state}  ${candidate.url}`);
    }
  }
  return lines;
}

/**
 * @command mate artifact link <change>...
 * @description Writes a change's Delivery Record (`delivery.yaml`), with `artifact archive`
 * the only writer of that file, for active and archived changes. Records the delivery branch or a
 * not-applicable reason per Working Repository, an informational PR URL, merge results
 * from the forge (`--refresh`), or the user's answer (`--confirm-*`, source `user`).
 * @flags
 * - `--repository <org/repo>` — the delivery to edit; defaults to the Working Repository.
 * - `--branch <branch>` — record the delivery branch; a protected branch needs `--direct`.
 * - `--direct` — with `--branch`, record a direct delivery, settled only by the user's answer; required for a protected branch.
 * - `--not-applicable <reason>` — no branch delivers this change in the repository.
 * - `--pr <url>` — record the PR URL; with `--refresh`, picks that PR among several.
 * - `--refresh` — ask the forge for the merge state of each recorded branch; a direct delivery
 *   is reported as needing the user's answer.
 * - `--confirm-merged` / `--confirm-open` / `--confirm-dropped` — the user's answer.
 * - `--json` — emit an array of {@link LinkResult}, one per change.
 * @remarks Warns, without blocking, about each `dependsOn` change that is neither archived nor
 * fully implemented, since apply records the branch before writing code. Without an edit flag or `--refresh` it only reads the record and writes nothing.
 * Network requests go only to the forge API: with `--refresh`, and with `--branch` for
 * another repository's default branch. The forge token is never
 * printed, logged, or written.
 */
export async function runArtifactLinkCommand(
  argv: string[],
  deps: LinkCommandDeps = {},
): Promise<void> {
  const { emitOut, emitErr, refuse } = commandOutput(deps);
  const flags = parseFlags(argv, BOOLEAN_FLAGS);
  const flagError = valueFlagError(flags, ["repository", "branch", "not-applicable", "pr"]);
  if (flagError) return refuse(flagError);
  const changes = positionalArgs(argv, BOOLEAN_FLAGS);
  const branchFlags = branchFlagsFrom(flags);
  const { branch, notApplicable } = branchFlags;
  const pr = stringFlag(flags.pr);
  const confirmations = Object.keys(CONFIRMATIONS).filter((flag) => flags[flag] === true);

  if (changes.length === 0) return refuse("mate: artifact link requires a change name.");
  if (branch !== undefined && notApplicable !== undefined) {
    return refuse("mate: --branch and --not-applicable exclude each other.");
  }
  if (confirmations.length > 1) {
    return refuse("mate: pass one of --confirm-merged, --confirm-open, or --confirm-dropped.");
  }
  if (branchFlags.direct && branch === undefined) return refuse(DIRECT_NEEDS_BRANCH);
  if (pr !== undefined && !/^https?:\/\/\S+$/.test(pr)) {
    return refuse("mate: --pr expects the PR's URL.");
  }
  const requested = repositoryFlag(flags);
  if ("error" in requested) return refuse(requested.error);

  const environment = await resolveDeliveryEnvironment(deps);
  if ("error" in environment) return refuse(environment.error);
  const repository = canonicalRepository(environment, requested.repository);
  const confirm = confirmations.length === 1 ? CONFIRMATIONS[confirmations[0]] : undefined;
  const delivery = deliveryEditFrom(branchFlags);
  const outcome = await recordDelivery(
    environment,
    {
      changes,
      ...(repository ? { repository } : {}),
      edit: {
        ...(delivery ? { delivery } : {}),
        ...(pr !== undefined ? { pr } : {}),
        ...(confirm ? { confirm } : {}),
      },
      refresh: flags.refresh === true,
      includeArchived: true,
    },
    deps,
  );
  if ("refusal" in outcome) return refuse(refusalMessage(outcome.refusal));
  const results: LinkResult[] = [];
  for (const result of "results" in outcome ? outcome.results : []) {
    const warnings = await applyWarnings(environment.companionPath, result.change);
    for (const warning of warnings) emitErr(`warning: ${warning.message}`);
    for (const entry of result.settlement.unscoped) {
      emitErr(unscopedDeliveryWarning(result.change, entry));
    }
    results.push({ ...result, warnings });
  }
  if (flags.json === true) emitOut(JSON.stringify(results));
  else for (const result of results) for (const line of renderHuman(result)) emitOut(line);
}
