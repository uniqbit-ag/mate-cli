import {
  recordDelivery,
  type DeliveryRefusal,
  type DeliveryResult,
  type RecordDeliveryDeps,
} from "../../../../lib/delivery/record-delivery";
import { applyWarnings, type DependencyWarning } from "../../../../lib/delivery/overlap";
import { isJiraKey, normalizeJiraKey, type MergeState } from "../../../../lib/delivery/record";
import { attributeCurrentSession } from "../../../../lib/session-attribution";
import { claudeSessionIsolation } from "../../../../runtime/claude-bg-isolation";
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
  renderOutcome,
  sharedRefusalMessage,
  unscopedDeliveryWarning,
} from "./output";

export interface LinkCommandDeps extends DeliveryEnvironmentDeps, RecordDeliveryDeps {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Records the change on the agent session this runs in. */
  attribute?: typeof attributeCurrentSession;
  sessionEnv?: Record<string, string | undefined>;
}

const BOOLEAN_FLAGS: BooleanFlagSet = new Set([
  "json",
  "refresh",
  "fetch",
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

/**
 * `warnings`: declared dependencies not implemented yet; they inform and never block.
 * `session.isolated`: a Claude Code background session outside a linked worktree, where
 * it may not write.
 */
export type LinkResult = DeliveryResult & {
  warnings: DependencyWarning[];
  session: { isolated: boolean };
};

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
  for (const outcome of result.outcomes) lines.push(...renderOutcome(outcome));
  return lines;
}

/**
 * @command mate artifact link <change>...
 * @description Writes a change's Delivery Record (`delivery.yaml`), with `artifact archive`
 * the only writer of that file, for active and archived changes. Records the delivery branch or a
 * not-applicable reason per Working Repository, an informational PR URL, merge results
 * from the forge or a local checkout (`--refresh`), or the user's answer (`--confirm-*`,
 * source `user`).
 * @flags
 * - `--repository <org/repo>` — the delivery to edit; defaults to the Working Repository, or in
 *   an Umbrella Repository to the change's only scoped child.
 * - `--branch <branch>` — record the delivery branch; a protected branch needs `--direct`.
 * - `--direct` — with `--branch`, record a direct delivery, settled only by the user's answer; required for a protected branch.
 * - `--not-applicable <reason>` — no branch delivers this change in the repository.
 * - `--pr <url>` — record the PR URL; with `--refresh`, picks that PR among several.
 * - `--ticket <KEY>` — record the Delivery Branch resolved with this Jira key (`ABC-123`, any
 *   case): a new branch is named by the `branchTemplate` (default
 *   `workset/<TICKET>-<workset-id>`), while a recorded, inherited,
 *   or existing branch is kept. The key is not stored. Excludes `--branch` and
 *   `--not-applicable`; refused unless the openspec capability sets `ticket: jira`.
 * - `--refresh` — ask the forge (with `MATE_GIT_TOKEN`), then a local checkout, for the merge
 *   state of each recorded branch; a direct delivery is reported as needing the user's answer.
 * - `--fetch` — with `--refresh`, fetch the default and delivery branches first even when the
 *   companion's Git mode is not `auto`.
 * - `--confirm-merged` / `--confirm-open` / `--confirm-dropped` — the user's answer.
 * - `--json` — emit an array of {@link LinkResult}, one per change.
 * @remarks Warns, without blocking, about each `dependsOn` change that is neither archived nor
 * fully implemented, since apply records the branch before writing code. Without an edit flag or `--refresh` it only reads the record and writes nothing.
 * Every result reports `session.isolated`: true in a Claude Code background session
 * (`CLAUDE_JOB_DIR`) whose isolation (the job's, else its launch `--settings`, else
 * `worktree.bgIsolation` in the Claude settings files) is not `none`, when the Working
 * Repository (else the current folder) lies in a Git checkout that is not a linked
 * worktree. An isolation value other than `worktree` or `none` is ignored with a warning.
 * Network requests go only to the forge API, with `--refresh` and with `--branch` for
 * another repository's default branch, and to `origin` through `git fetch` with `--refresh`
 * in Git mode `auto` or with `--fetch`. Only `git` is started; no credential is read. The
 * forge token is never printed, logged, or written.
 */
export async function runArtifactLinkCommand(
  argv: string[],
  deps: LinkCommandDeps = {},
): Promise<void> {
  const { emitOut, emitErr, refuse } = commandOutput(deps);
  const flags = parseFlags(argv, BOOLEAN_FLAGS);
  const flagError = valueFlagError(flags, [
    "repository",
    "branch",
    "not-applicable",
    "pr",
    "ticket",
  ]);
  if (flagError) return refuse(flagError);
  const changes = positionalArgs(argv, BOOLEAN_FLAGS);
  const branchFlags = branchFlagsFrom(flags);
  const { branch, notApplicable } = branchFlags;
  const pr = stringFlag(flags.pr);
  const ticket = stringFlag(flags.ticket);
  const confirmations = Object.keys(CONFIRMATIONS).filter((flag) => flags[flag] === true);

  if (changes.length === 0) return refuse("mate: artifact link requires a change name.");
  if (flags.fetch === true && flags.refresh !== true) {
    return refuse("mate: --fetch needs --refresh.");
  }
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
  if (ticket !== undefined && !isJiraKey(ticket)) {
    return refuse("mate: --ticket expects a Jira key such as ABC-123.");
  }
  if (ticket !== undefined && (branch !== undefined || notApplicable !== undefined)) {
    return refuse(
      "mate: --ticket names the resolved branch; it excludes --branch and --not-applicable.",
    );
  }
  const requested = repositoryFlag(flags);
  if ("error" in requested) return refuse(requested.error);

  const environment = await resolveDeliveryEnvironment(deps);
  if ("error" in environment) return refuse(environment.error);
  if (environment.ticket?.diagnostic) emitErr(`warning: ${environment.ticket.diagnostic}`);
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
        ...(ticket !== undefined ? { ticket: normalizeJiraKey(ticket) } : {}),
      },
      refresh: flags.refresh === true,
      fetch: flags.fetch === true,
      includeArchived: true,
    },
    deps,
  );
  if ("refusal" in outcome) return refuse(refusalMessage(outcome.refusal));
  const sessionEnv = deps.sessionEnv ?? process.env;
  // One change names the session's work; a batch link names none.
  if (changes.length === 1) {
    await (deps.attribute ?? attributeCurrentSession)({ change: changes[0]! }, sessionEnv);
  }
  const isolation = claudeSessionIsolation(
    sessionEnv,
    environment.workingRepo?.path ?? process.cwd(),
  );
  for (const diagnostic of isolation.diagnostics) emitErr(`warning: ${diagnostic}`);
  const session = { isolated: isolation.isolated };
  const results: LinkResult[] = [];
  for (const result of "results" in outcome ? outcome.results : []) {
    for (const diagnostic of result.diagnostics) emitErr(`warning: ${diagnostic}`);
    const warnings = await applyWarnings(environment.companionPath, result.change);
    for (const warning of warnings) emitErr(`warning: ${warning.message}`);
    for (const entry of result.settlement.unscoped) {
      emitErr(unscopedDeliveryWarning(result.change, entry));
    }
    results.push({ ...result, warnings, session });
  }
  if (flags.json === true) emitOut(JSON.stringify(results));
  else for (const result of results) for (const line of renderHuman(result)) emitOut(line);
}
