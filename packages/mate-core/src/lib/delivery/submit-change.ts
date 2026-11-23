import { runOpenSpec, type RunOpenSpec } from "../openspec-cli";
import type { SecretFinding } from "../../runtime/secret-scan";
import { agentRuntime, formatInvocation } from "../../runtime/skill-prefix";
import type { DeliveryEnvironment } from "./environment";
import {
  openTasks,
  planningWarning,
  submitWarnings,
  type CountedWarning,
  type StageWarning,
  type SubmitWarning,
} from "./overlap";
import {
  settleDelivery,
  type DeliveryRecord,
  type DeliverySettlement,
  type SubmissionState,
  type UnscopedDelivery,
} from "./record";
import {
  recordDelivery,
  type DeliveryEdit,
  type DeliveryRefusal,
  type DeliveryRequest,
  type RecordDeliveryDeps,
} from "./record-delivery";
import type { BranchOutcome } from "./refresh";
import { repositoryAccessFor } from "./repository-access";
import { sourceDir, type ArtifactType } from "./staging/artifact-type";
import { openspecArtifactType } from "./staging/openspec-type";
import { loadSubmitWorkflow } from "./staging/registry";
import {
  dropSubmitted,
  editedSubmittedMembers,
  groupOfChange,
  localMembers,
  submissionState,
  submitGroups,
  type DropResult,
  type GroupSubmission,
  type PendingFailure,
  type SubmitDeps,
} from "./staging/submit";
import { openWork } from "../workflow/work";
import type { Workflow } from "../workflow/declaration";
import { pathPosition } from "../workflow/position";

/**
 * - `submitted`: the group's folders are on the pending branch (`pushed` tells whether this run
 *   pushed them; false when they were there unchanged)
 * - `waiting`: nothing was pushed and no state changed: the group waits for its `waitingFor`
 *   members, which are not ready (empty for the deprecated `archive` alias, which never pushes)
 * - `needs-branch`: no delivery recorded; nothing changed
 * - `failed`: the check or the push failed; no state changed
 */
export type SubmitStatus = "submitted" | "waiting" | "needs-branch" | "failed";

export type SubmitFailure = "check-failed" | PendingFailure;

export interface SubmitResult {
  change: string;
  status: SubmitStatus;
  /** The change's Delivery Group, once its delivery is recorded. */
  group: string | null;
  /** Local members of the group that keep it from being submitted. */
  waitingFor: string[];
  /** Whether this run pushed the group's folders; for an edited `submitted` member, its own. */
  pushed: boolean;
  /** The submit commit this run pushed. */
  commit: string | null;
  /** The branch submitted changes wait on, once known. */
  pendingBranch: string | null;
  /** The change's local state after the run. */
  state: SubmissionState;
  reason?: SubmitFailure;
  defaultBranch: string | null;
  diagnostics: string[];
  record: DeliveryRecord;
  settlement: DeliverySettlement;
  outcomes: BranchOutcome[];
  warnings: SubmitWarning[];
  /** `needs-branch` only: the branch to suggest, when it exists. */
  suggestedBranch?: string | null;
  /** `secret`: where and which rule, never the value. */
  secretFindings?: SecretFinding[];
  message: string;
}

export interface SubmitRequest {
  changes: string[];
  /** The repository `delivery` is recorded for; defaults to the Working Repository. */
  repository?: string;
  /** Recorded before the refresh, as `artifact link` would. */
  delivery?: DeliveryEdit["delivery"];
  /** Submit with an unlinked record instead of answering `needs-branch`. */
  skipBranch?: boolean;
  /** Fetch before the local merge check even when the companion's Git mode is not `auto`. */
  fetch?: boolean;
  /** Record the delivery and run the check, but push nothing: the deprecated `archive` alias. */
  holdPush?: boolean;
}

export type SubmitOutcome = { refusal: DeliveryRefusal } | { results: SubmitResult[] };

export interface SubmitChangeDeps extends RecordDeliveryDeps, Omit<SubmitDeps, "now"> {
  runOpenSpec?: RunOpenSpec;
  /** Counts a change's unchecked tasks; {@link openTasks} by default. */
  openTasks?: typeof openTasks;
  /**
   * Called per change once before its check runs, so warnings are visible even when the check or
   * the push fails or hangs. Never called for `needs-branch` or a refusal.
   */
  onWarnings?: (change: string, warnings: SubmitWarning[], unscoped: UnscopedDelivery[]) => void;
  /** Pushes the groups; {@link submitGroups} by default. */
  submitGroups?: typeof submitGroups;
}

/** A change past recording and its check, before the group push. */
type Prepared = Omit<
  SubmitResult,
  "status" | "group" | "waitingFor" | "pushed" | "commit" | "pendingBranch" | "state" | "message"
> & { group: string; failure?: string };

/**
 * What submitting leaves unfinished for `change`, as warnings: `stage-open` for
 * the first required skill stage before `submit` whose plan is open, and `step-counted` naming
 * every other step before `mate-submit-change` that is neither recorded nor covered, which
 * submitting counts. Optional and review stages are passed over. Never blocks: a recorded step
 * shows it was reported, not that its work is done.
 */
async function stageWarnings(
  companionPath: string,
  workflow: Workflow,
  change: string,
): Promise<Array<StageWarning | CountedWarning>> {
  const work = await openWork(companionPath, workflow).find(change);
  // Recording the delivery found the change, so it exists.
  if ("problem" in work) return [];
  const { progress } = await work.input();
  // As the change will be once submitted: what is still open then, the plan holds open.
  const { unfinished, counted } = pathPosition(workflow, { ...progress, state: "submitted" });
  const warnings: Array<StageWarning | CountedWarning> = [];
  const runtime = agentRuntime(process.env);
  if (unfinished[0]) {
    const { stage: first, open } = unfinished[0];
    warnings.push({
      kind: "stage-open",
      change,
      stage: first.id,
      message: `submitting ${change} leaves ${first.id} unfinished (${open}); to finish it, run ${formatInvocation(runtime, first.entry, change)} and submit again.`,
    });
  }
  // A stage the plan holds open is named by `stage-open`, not counted.
  const steps = Object.fromEntries(
    Object.entries(counted).filter(([id]) => !unfinished.some((entry) => entry.stage.id === id)),
  );
  const named = Object.values(steps).flatMap((skills) =>
    skills.map((skill) => formatInvocation(runtime, skill)),
  );
  if (named.length > 0) {
    warnings.push({
      kind: "step-counted",
      change,
      steps,
      message: `submitting ${change} counts ${named.join(", ")} as done, never reported; if one did not run, run it for ${change} and submit again.`,
    });
  }
  return warnings;
}

/** The delivery `change` records, as `artifact link` would. */
function deliveryRequest(request: SubmitRequest, change: string): DeliveryRequest {
  return {
    changes: [change],
    ...(request.repository ? { repository: request.repository } : {}),
    ...(request.delivery ? { edit: { delivery: request.delivery } } : {}),
    requireDelivery: !request.skipBranch,
  };
}

async function prepare(
  environment: DeliveryEnvironment,
  request: SubmitRequest,
  change: string,
  type: ArtifactType,
  workflow: Workflow,
  deps: SubmitChangeDeps,
): Promise<{ refusal: DeliveryRefusal } | { result: SubmitResult } | { prepared: Prepared }> {
  const outcome = await recordDelivery(
    environment,
    {
      ...deliveryRequest(request, change),
      refresh: true,
      ...(request.fetch ? { fetch: true } : {}),
      // The settlement covers every repository, so each delivery's merge state is refreshed.
      refreshAll: true,
    },
    deps,
  );
  if ("refusal" in outcome) return outcome;

  const runner = deps.runOpenSpec ?? runOpenSpec;
  const cwd = environment.companionPath;
  const [overlap, status] = await Promise.all([
    submitWarnings(cwd, change),
    runner(["status", "--change", change, "--json"], { cwd }),
  ]);
  const planning = status.code === 0 ? planningWarning(change, status.stdout) : null;
  const warnings: SubmitWarning[] = [...overlap, ...(planning ? [planning] : [])];

  if ("needsBranch" in outcome) {
    const { record, suggestedBranch, defaultBranch, diagnostics } = outcome.needsBranch;
    return {
      result: {
        change,
        status: "needs-branch",
        group: null,
        waitingFor: [],
        pushed: false,
        commit: null,
        pendingBranch: null,
        state: await submissionState(sourceDir(cwd, type, change)),
        defaultBranch,
        diagnostics,
        record,
        settlement: settleDelivery(record),
        outcomes: [],
        warnings,
        suggestedBranch,
        message: `No delivery branch is recorded for ${change}. Re-run with --branch <branch>, --not-applicable <reason>, or --skip-branch.`,
      },
    };
  }

  const [{ record, settlement, outcomes, defaultBranch, diagnostics }] = outcome.results;
  const named = await groupOfChange(cwd, change, type);
  if (named.warning) warnings.push({ kind: "group", change, message: named.warning });
  warnings.push(...(await stageWarnings(cwd, workflow, change)));
  deps.onWarnings?.(change, warnings, settlement.unscoped);

  const fields = { defaultBranch, diagnostics, record, settlement, outcomes, warnings };
  const failure = await type.check(cwd, change);
  if (failure) return { prepared: { ...fields, change, group: named.group, failure } };
  return { prepared: { ...fields, change, group: named.group } };
}

function groupMessage(change: string, submission: GroupSubmission): string {
  const { group, push } = submission;
  if (submission.status === "waiting") {
    return submission.waitingFor.length > 0
      ? `${change} is not submitted: group ${group} lands together and waits for: ${submission.waitingFor.join(", ")}. Finish or drop them, then submit again; nothing was pushed.`
      : `Checked ${change}; nothing was pushed.`;
  }
  const place = push?.pendingBranch ?? "the pending branch";
  if (submission.status === "pushed") {
    return `Submitted ${change}: pushed group ${group} to ${place}; it publishes once its delivery is merged.`;
  }
  if (submission.status === "unchanged") {
    return `${change} is already submitted unchanged in group ${group} on ${place}.`;
  }
  if (push?.reason === "no-remote") {
    return `mate: ${change} cannot be submitted: the companion has no upstream, and submitted changes wait on its remote until they are published. Give the companion a remote, then submit again; nothing changed.`;
  }
  return `mate: submitting group ${group} failed: ${push?.detail ?? push?.reason ?? "unknown"}. Nothing changed; run submit again.`;
}

/**
 * The other active changes of `groups` in this checkout that are ready to be submitted with
 * them: every task checked. One with open tasks is left out, so its group waits for it.
 */
async function readySiblings(
  companionPath: string,
  type: ArtifactType,
  groups: ReadonlySet<string>,
  named: readonly string[],
  count: typeof openTasks,
): Promise<string[]> {
  const ready: string[] = [];
  for (const member of await localMembers(companionPath, type)) {
    if (!groups.has(member.group) || member.state !== "active" || named.includes(member.name)) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- a few changes per group
    if ((await count(sourceDir(companionPath, type, member.name))) === 0) ready.push(member.name);
  }
  return ready;
}

/**
 * The Submit change stage for `request.changes` and their Worksets: each named change's delivery
 * is recorded and refreshed, with warnings about overlapping requirements, unsubmitted
 * dependencies, incomplete planning, an unfinished required stage of the Delivery Path and its
 * Delivery Group, and the type's `check` runs. The
 * other active changes of its Delivery Group join when every task of theirs is checked and they
 * pass the same steps, as do its `submitted` members edited since this checkout submitted or took
 * them. A group is then pushed whole, in one commit that sets its changes `submitted`, or not at
 * all: while a member has open tasks, fails its check or cannot be refreshed, the group waits and
 * no state changes. Never archives and never writes canonical specs; merge state is reported,
 * never a refusal.
 */
export async function submitChanges(
  environment: DeliveryEnvironment,
  request: SubmitRequest,
  given: SubmitChangeDeps = {},
): Promise<SubmitOutcome> {
  // One access for the run, so the check below and the recording fetch each branch once.
  const deps: SubmitChangeDeps = {
    ...given,
    repositoryAccess: given.repositoryAccess ?? repositoryAccessFor(environment, given),
  };
  const type =
    deps.artifactType ?? environment.artifactType ?? openspecArtifactType(deps.runOpenSpec);
  const cwd = environment.companionPath;
  const workflow = environment.workflow ?? (await loadSubmitWorkflow(cwd)).workflow;
  // Every change is refused or accepted before any record is written, so a refused later one
  // leaves no earlier record changed. The merge check runs here too: a delivery Git would settle
  // while its work tree holds uncommitted work is refused before that merge is recorded.
  for (const change of request.changes) {
    // oxlint-disable-next-line no-await-in-loop -- a few changes per run
    const checked = await recordDelivery(
      environment,
      {
        ...deliveryRequest(request, change),
        dryRun: true,
        refresh: true,
        refreshAll: true,
        ...(request.fetch ? { fetch: true } : {}),
        refuseUncommitted: true,
      },
      deps,
    );
    if ("refusal" in checked) return checked;
  }
  const steps: ({ result: SubmitResult } | { prepared: Prepared })[] = [];
  for (const change of request.changes) {
    // oxlint-disable-next-line no-await-in-loop -- warnings reach stderr change by change
    const step = await prepare(environment, request, change, type, workflow, deps);
    if ("refusal" in step) return step;
    steps.push(step);
  }
  const named = steps.flatMap((step) => ("prepared" in step ? [step.prepared] : []));
  const groups = new Set(named.map((entry) => entry.group));
  const siblings = await readySiblings(
    cwd,
    type,
    groups,
    request.changes,
    deps.openTasks ?? openTasks,
  );
  const prepareUnnamed = async (
    change: string,
    extra: Pick<SubmitRequest, "skipBranch"> = {},
  ): Promise<void> => {
    const step = await prepare(
      environment,
      { changes: [change], ...extra, ...(request.fetch ? { fetch: true } : {}) },
      change,
      type,
      workflow,
      deps,
    );
    if ("prepared" in step) steps.push(step);
  };
  // One that cannot be prepared stays active, so its group waits for it.
  for (const change of siblings) {
    // oxlint-disable-next-line no-await-in-loop -- warnings reach stderr change by change
    await prepareUnnamed(change);
  }
  // The archive alias pushes nothing, and its `--json` stays one object for one change.
  const edited = request.holdPush
    ? []
    : await editedSubmittedMembers(cwd, groups, request.changes, { ...deps, artifactType: type });
  const editedNames = new Set(edited.map((member) => member.name));
  // Accepted once already, so a change nobody named never answers `needs-branch`.
  for (const member of edited) {
    // oxlint-disable-next-line no-await-in-loop -- warnings reach stderr change by change
    await prepareUnnamed(member.name, { skipBranch: true });
  }
  const prepared = steps.flatMap((step) => ("prepared" in step ? [step.prepared] : []));

  // A group with a failed check is not pushed at all: it waits for the failing changes.
  const failing = new Map<string, string[]>();
  const hold = (group: string, change: string): void => {
    failing.set(group, [...(failing.get(group) ?? []), change]);
  };
  for (const entry of prepared.filter((each) => each.failure)) hold(entry.group, entry.change);
  // `submitGroups` would push one unprepared: a `submitted` member never makes a group wait there.
  for (const member of edited) {
    if (!prepared.some((entry) => entry.change === member.name)) hold(member.group, member.name);
  }
  // Left unnamed: `submitGroups` pushes them anyway, and a name would accept a pending block.
  const ready = prepared.filter(
    (entry) => !failing.has(entry.group) && !editedNames.has(entry.change),
  );
  const held: GroupSubmission[] = [...failing].map(([group, waitingFor]) => ({
    group,
    status: "waiting",
    waitingFor,
  }));
  const submissions: GroupSubmission[] = request.holdPush
    ? [...new Set(prepared.map((entry) => entry.group))].map((group) => ({
        group,
        status: "waiting",
        waitingFor: failing.get(group) ?? [],
      }))
    : [
        ...held,
        ...(ready.length > 0
          ? await (deps.submitGroups ?? submitGroups)(
              cwd,
              ready.map((entry) => entry.change),
              { ...deps, artifactType: type, ...(deps.now ? { now: deps.now } : {}) },
            )
          : []),
      ];

  const results = new Map<Prepared, SubmitResult>();
  for (const entry of prepared) {
    const { failure, ...fields } = entry;
    const base = { ...fields, waitingFor: [], pushed: false, commit: null, pendingBranch: null };
    // oxlint-disable-next-line no-await-in-loop -- a few changes per run
    const current = await submissionState(sourceDir(cwd, type, entry.change));
    if (failure) {
      results.set(entry, {
        ...base,
        status: "failed",
        state: current,
        reason: "check-failed",
        message: `mate: ${entry.change} failed its check; nothing was pushed.\n${failure}`,
      });
      continue;
    }
    const submission = submissions.find((each) => each.group === entry.group);
    if (!submission) throw new Error(`no submission for group ${entry.group}`);
    const push = submission.push;
    const landed = submission.status === "pushed" || submission.status === "unchanged";
    const state: SubmissionState = landed ? "submitted" : current;
    // The push leaves out an edited member whose copy on the pending branch stands.
    const carried = !editedNames.has(entry.change) || push?.changes.includes(entry.change) === true;
    results.set(entry, {
      ...base,
      status: landed ? "submitted" : submission.status === "waiting" ? "waiting" : "failed",
      waitingFor: submission.waitingFor,
      pushed: submission.status === "pushed" && carried,
      commit: push?.commit ?? null,
      pendingBranch: push?.pendingBranch ?? null,
      state,
      record: { ...entry.record, state },
      ...(push?.reason ? { reason: push.reason } : {}),
      ...(push?.secretFindings ? { secretFindings: push.secretFindings } : {}),
      message: groupMessage(entry.change, submission),
    });
  }
  return {
    results: steps.map((step) => ("result" in step ? step.result : results.get(step.prepared)!)),
  };
}

/** Drops each of `changes`; see {@link dropSubmitted}. */
export async function dropChanges(
  companionPath: string,
  changes: readonly string[],
  deps: Omit<SubmitDeps, "now"> & { dropSubmitted?: typeof dropSubmitted } = {},
): Promise<DropResult[]> {
  const drop = deps.dropSubmitted ?? dropSubmitted;
  const results: DropResult[] = [];
  for (const change of changes) {
    // oxlint-disable-next-line no-await-in-loop -- one push at a time
    results.push(await drop(companionPath, change, deps));
  }
  return results;
}
