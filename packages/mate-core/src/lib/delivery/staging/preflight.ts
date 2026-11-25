import { errorMessage } from "../../../runtime/error-message";
import { inboxText } from "../../../runtime/pending-records";
import { describeFailure, failureRemedy } from "./apply-chain";
import { isCommitId, readDeliveryRecord } from "../record";
import { sourceDir } from "./artifact-type";
import { byFolderPath, bySubmitOrder, deltaBase, sourcePathOf } from "./pending";
import {
  chainContext,
  runChain,
  runMember,
  type ChainContext,
  type ProjectDeps,
  type RunMember,
} from "./project";
import { defaultRef, pendingRef } from "./refs";
import { acceptsBlock, localPushes } from "./submit";

export type PreflightDeps = ProjectDeps & {
  stateHome?: string;
  /** Every group this run pushes, with the names it is given; their local folders are pushed. */
  pushing?: ReadonlyMap<string, readonly string[]>;
};

/**
 * - `passed`: `message` is set when the fetch failed and the last fetched refs were read
 * - `failed`: publication would refuse `change`, a member of the group (null: unknown)
 * - `blocked`: publication would block the group on the stale delta of `change`, which this run
 *   pushes; only its copy on the pending branch can be resolved, so the push goes ahead
 * - `skipped`: the group's `dependsOn` chain cannot be built or applied
 */
export type PreflightResult =
  | { status: "passed"; message?: string }
  | { status: "failed"; change: string | null; message: string }
  | { status: "blocked"; change: string; message: string }
  | { status: "skipped"; message: string };

/**
 * Archives Delivery Group `group` as publication would, before submit hands `names` to
 * `submitGroups`: in a temporary worktree of the default branch, its unpublished `dependsOn`
 * chain, each from the pending branch unless another group of `deps.pushing` pushes its local
 * folder, then its members in publication order. Members are the local folders that push puts on
 * the pending branch, then the group's other changes there, each as the push leaves it; a
 * blocked change of `names` takes the default tip as base where the push would. Submit order is
 * the pending branch's, then as Git lists the folders this run would add. Leaves the checkout
 * untouched. Never throws.
 */
export async function preflightGroup(
  companionPath: string,
  group: string,
  names: readonly string[],
  deps: PreflightDeps = {},
): Promise<PreflightResult> {
  let fetched = "";
  const skipped = (cause: string): PreflightResult => ({
    status: "skipped",
    message: `the publication pre-flight of group ${group}${fetched} was skipped: ${cause}.`,
  });
  try {
    const context = await chainContext(companionPath, deps);
    const { type, submitted, published, remote } = context;
    fetched = context.warning;
    const carried = await localPushes(
      companionPath,
      group,
      names,
      new Set(submitted.map((change) => change.name)),
      {
        artifactType: type,
        ...(deps.git ? { git: deps.git } : {}),
        ...(deps.stateHome ? { stateHome: deps.stateHome } : {}),
      },
    );
    if (carried === null) return skipped("Git could not tell which members changed locally");
    const local = new Set(carried);
    const members: RunMember[] = await Promise.all(
      [
        ...carried,
        ...submitted
          .filter((change) => change.group === group && !local.has(change.name))
          .map((change) => change.name),
      ]
        .filter((name) => !published.has(name))
        .toSorted(
          bySubmitOrder(
            submitted.map((change) => change.name),
            byFolderPath,
          ),
        )
        .map(async (name) => {
          const copy = submitted.find((change) => change.name === name);
          const member = runMember(
            name,
            local.has(name) ? await context.localDependencies(name) : null,
            copy,
          );
          const rebased =
            Boolean(copy?.blocked) &&
            names.includes(name) &&
            (member.source === "local" || (await pushAccepts(context, name)));
          return { ...member, ...(rebased ? { rebased: true } : {}) };
        }),
    );
    if (members.length === 0) return passed(context.fetchError, group);

    // Publication refuses a change it cannot date; submit dates every folder it pushes.
    if (remote) {
      for (const member of members) {
        if (member.source !== "submitted" || member.rebased || !member.submitted) continue;
        if (member.submitted.touches.length === 0) continue;
        // oxlint-disable-next-line no-await-in-loop -- a few members per group
        const base = await deltaBase(
          context.git,
          defaultRef(remote),
          pendingRef(remote),
          member.submitted,
          type,
        );
        if (base) continue;
        const name = inboxText(member.name);
        return {
          status: "failed",
          change: member.name,
          message: `publication would refuse group ${group}${fetched}: the commit ${name} was written against is unknown, so what changed on ${remote.defaultBranch} since cannot be checked. Submit ${name} again with \`mate artifact submit ${name}\`.`,
        };
      }
    }

    // Publication applies a dependency's pending copy; only one this run pushes is read here.
    const elsewhere = await pushedElsewhere(companionPath, group, context, deps);
    const onPending = new Set(submitted.map((change) => change.name));
    const chainReads: ChainContext =
      elsewhere === null
        ? context
        : {
            ...context,
            localDependencies: async (change) =>
              onPending.has(change) && !elsewhere.has(change)
                ? null
                : context.localDependencies(change),
          };
    const run = await runChain(
      chainReads,
      { dependencies: [...new Set(members.flatMap((member) => member.dependsOn))], members },
      async () => null,
    );
    if (run.status === "missing") {
      return skipped(
        `it depends on ${run.missing.map(inboxText).join(", ")}, which is neither here, submitted nor published`,
      );
    }
    if (run.status !== "conflict") return passed(context.fetchError, group);
    const { failure } = run;
    // describeFailure leaves out archive's own refusal once it parsed the delta; it names what to fix.
    const refusal =
      failure.kind === "apply" && failure.failure ? ` (${inboxText(failure.detail)})` : "";
    const reason = `${describeFailure(failure, run.branch)}${refusal}`;
    const { change } = failure;
    if (change !== null && run.chain.some((member) => member.name === change)) {
      return skipped(`its dependencies cannot be published: ${reason}`);
    }
    const failing = members.find((member) => member.name === change);
    if (failure.kind === "stale") {
      // Its base stays as recorded, so refusing would hold it here for good.
      if (failing?.source === "local" && !failing.submitted?.blocked) {
        return {
          status: "blocked",
          change: failing.name,
          message: `publication will block group ${group}${fetched}: ${reason}. It is pushed anyway, as only its copy on the pending branch can be resolved. ${failureRemedy(failure, [failing.name])} Do that before you publish: no member after it was checked.`,
        };
      }
      return {
        status: "failed",
        change,
        message: `publication would refuse group ${group}${fetched}: ${reason}. ${failureRemedy(failure, names)}`,
      };
    }
    return {
      status: "failed",
      change,
      message: `publication would refuse group ${group}${fetched}: ${reason}.`,
    };
  } catch (error) {
    return skipped(errorMessage(error));
  }
}

/** The local folders the other groups of `deps.pushing` push; null when Git cannot tell. */
async function pushedElsewhere(
  companionPath: string,
  group: string,
  context: ChainContext,
  deps: PreflightDeps,
): Promise<Set<string> | null> {
  const found = new Set<string>();
  const onPending = new Set(context.submitted.map((change) => change.name));
  for (const [other, names] of deps.pushing ?? []) {
    if (other === group) continue;
    // oxlint-disable-next-line no-await-in-loop -- a few groups per run
    const carried = await localPushes(companionPath, other, names, onPending, {
      artifactType: context.type,
      ...(deps.git ? { git: deps.git } : {}),
      ...(deps.stateHome ? { stateHome: deps.stateHome } : {}),
    });
    if (carried === null) return null;
    for (const name of carried) found.add(name);
  }
  return found;
}

/**
 * Whether the push moves unchanged blocked `name`'s base to the default tip, deciding as
 * `pushGroup` does: on the local record's `specBase` and the copy on the pending branch.
 */
async function pushAccepts(context: ChainContext, name: string): Promise<boolean> {
  const { git, remote, type } = context;
  if (!remote) return false;
  const tip = (
    await git.run(["rev-parse", "--verify", "-q", `${defaultRef(remote)}^{commit}`])
  ).stdout.trim();
  const record = await readDeliveryRecord(sourceDir(context.companionPath, type, name)).catch(
    () => null,
  );
  const specBase = record?.specBase;
  if (!specBase || !isCommitId(specBase) || !isCommitId(tip)) return false;
  const shared = await git.run(["merge-base", specBase, tip]);
  const commit = shared.stdout.trim();
  const base = shared.status === 0 && isCommitId(commit) ? commit : specBase;
  if (base === tip) return false;
  return acceptsBlock(type, git, pendingRef(remote), sourcePathOf(type, name), base, tip);
}

function passed(fetchError: string | undefined, group: string): PreflightResult {
  return fetchError
    ? {
        status: "passed",
        message: `the publication pre-flight of group ${group} passed on the last fetched state only; publication may still refuse it. Cause: ${fetchError}`,
      }
    : { status: "passed" };
}
