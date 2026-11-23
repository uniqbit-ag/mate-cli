import { errorMessage } from "../../../runtime/error-message";
import { inboxText } from "../../../runtime/pending-records";
import { describeFailure } from "./apply-chain";
import { byFolderPath, bySubmitOrder } from "./pending";
import { chainContext, runChain, runMember, type ProjectDeps } from "./project";
import { localMembers } from "./submit";

/**
 * - `failed`: publication would refuse `change`, a member of the group (null: unknown)
 * - `skipped`: the group's `dependsOn` chain cannot be built or applied
 */
export type PreflightResult =
  | { status: "passed" }
  | { status: "failed"; change: string | null; message: string }
  | { status: "skipped"; message: string };

/**
 * Archives Delivery Group `group` as publication would, before `submitting`, its changes this run
 * pushes, are submitted: in a temporary worktree of the default branch, its unpublished
 * `dependsOn` chain, then its members in publication order. Members are its folders in this
 * checkout, then its changes on the pending branch this checkout lacks; a member this run does
 * not push is read from the pending branch when it is there. Submit order is the pending
 * branch's, then as Git lists the folders this run would add. Leaves the checkout untouched.
 * Never throws.
 */
export async function preflightGroup(
  companionPath: string,
  group: string,
  submitting: readonly string[],
  deps: ProjectDeps = {},
): Promise<PreflightResult> {
  const skipped = (cause: string): PreflightResult => ({
    status: "skipped",
    message: `the publication pre-flight of group ${group} was skipped: ${cause}.`,
  });
  try {
    const context = await chainContext(companionPath, deps);
    const { type, submitted, published } = context;
    const locals = await localMembers(companionPath, type);
    const here = new Set(locals.map((member) => member.name));
    const names = locals
      .filter(
        (member) =>
          member.group === group &&
          (member.state !== "dropped" || submitting.includes(member.name)),
      )
      .map((member) => member.name)
      .concat(
        submitted
          .filter((change) => change.group === group && !here.has(change.name))
          .map((change) => change.name),
      )
      .filter((name) => !published.has(name));
    const members = await Promise.all(
      names
        .toSorted(
          bySubmitOrder(
            submitted.map((change) => change.name),
            byFolderPath,
          ),
        )
        .map(async (name) => {
          const copy = submitted.find((change) => change.name === name);
          const pushed = !copy || submitting.includes(name);
          return {
            ...runMember(name, pushed ? await context.localDependencies(name) : null, copy),
            ...(copy?.blocked && pushed ? { rebased: true } : {}),
          };
        }),
    );
    if (members.length === 0) return { status: "passed" };

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
    if (run.status !== "conflict") return { status: "passed" };
    const { failure } = run;
    // describeFailure leaves out archive's own refusal once it parsed the delta; it names what to fix.
    const refusal =
      failure.kind === "apply" && failure.failure ? ` (${inboxText(failure.detail)})` : "";
    const reason = `${describeFailure(failure, run.branch)}${refusal}`;
    const { change } = failure;
    if (change !== null && run.chain.some((member) => member.name === change)) {
      return skipped(`its dependencies cannot be published: ${reason}`);
    }
    return {
      status: "failed",
      change,
      message: `publication would refuse group ${group}: ${reason}.`,
    };
  } catch (error) {
    return skipped(errorMessage(error));
  }
}
