import { errorMessage } from "../../../runtime/error-message";
import { inboxText } from "../../../runtime/pending-records";
import { describeFailure, failureRemedy } from "./apply-chain";
import { byFolderPath, bySubmitOrder, deltaBase } from "./pending";
import { chainContext, runChain, runMember, type ProjectDeps, type RunMember } from "./project";
import { defaultRef, pendingRef } from "./refs";
import { localPushes } from "./submit";

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
 * chain, then its members in publication order. Members are the local folders that push puts on
 * the pending branch, then the group's other changes there, each as the push leaves it; a
 * blocked change of `names` takes the default tip as base where the push would. Submit order is
 * the pending branch's, then as Git lists the folders this run would add. Leaves the checkout
 * untouched. Never throws.
 */
export async function preflightGroup(
  companionPath: string,
  group: string,
  names: readonly string[],
  deps: ProjectDeps & { stateHome?: string } = {},
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
          return {
            ...runMember(
              name,
              local.has(name) ? await context.localDependencies(name) : null,
              copy,
            ),
            ...(copy?.blocked && names.includes(name) ? { rebased: true } : {}),
          };
        }),
    );
    if (members.length === 0) return passed(fetched, group);

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

    const run = await runChain(
      context,
      { dependencies: [...new Set(members.flatMap((member) => member.dependsOn))], members },
      async () => null,
    );
    if (run.status === "missing") {
      return skipped(
        `it depends on ${run.missing.map(inboxText).join(", ")}, which is neither here, submitted nor published`,
      );
    }
    if (run.status !== "conflict") return passed(fetched, group);
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
      const remedy = failureRemedy(failure);
      // Its base stays as recorded, so refusing would hold it here for good.
      if (failing?.source === "local" && !failing.submitted?.blocked) {
        return {
          status: "blocked",
          change: failing.name,
          message: `publication will block group ${group}${fetched}: ${reason}. It is pushed anyway, as only its copy on the pending branch can be resolved; no member after it was checked. ${remedy}`,
        };
      }
      return {
        status: "failed",
        change,
        message: `publication would refuse group ${group}${fetched}: ${reason}. ${remedy}`,
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

function passed(fetched: string, group: string): PreflightResult {
  return fetched
    ? {
        status: "passed",
        message: `the publication pre-flight of group ${group}${fetched} passed; publication may still refuse it.`,
      }
    : { status: "passed" };
}
