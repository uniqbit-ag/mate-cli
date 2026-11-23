import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ARTIFACT_TRAILER, INBOX_TRAILER, TRANSACTION_TRAILER } from "../../artifact-trailer";
import type { RunOpenSpec } from "../../openspec-cli";
import {
  companionGit,
  describeGitFailure,
  isTransientRemoteFailure,
  LITERAL_PATHSPECS,
  nulPaths,
  type CompanionGit,
  type GitResult,
  type NetworkGitResult,
} from "../../../runtime/companion-git";
import { adoptUpstream } from "../../../runtime/companion-sync";
import { errorMessage } from "../../../runtime/error-message";
import { inboxText } from "../../../runtime/pending-records";
import {
  scanPublication,
  type PublicationSecretScan,
} from "../../../runtime/publication-secret-scan";
import type { SecretFinding } from "../../../runtime/secret-scan";
import {
  isCommitId,
  readDeliveryRecord,
  readDeliveryState,
  writeDeliveryRecord,
  type DeliveryBlock,
  type DeliveryRecord,
} from "../record";
import {
  applyChain,
  describeFailure,
  failurePaths,
  failureRemedy,
  isChainFailure,
  type ChainFailure,
} from "./apply-chain";
import { artifactTrailerValue, sourceDir, type ArtifactType } from "./artifact-type";
import { isDeliveryGroup } from "./naming";
import {
  deliveryHold,
  deltaBase,
  groupsOf,
  isOthersAnswer,
  mergeClaims,
  publicationOrder,
  publishedAs,
  submittedAt,
  unpublishedDependencies,
  type MergeClaim,
  type SubmittedChange,
} from "./pending";
import { commitToPending } from "./pending-edit";
import {
  anchorsAt,
  defaultRef,
  fetchPendingBranches,
  fetchStaging,
  INBOX_BRANCH,
  isPushNotPermitted,
  isRejectedPush,
  pendingPlace,
  pendingRef,
  pushPending,
  recordsAt,
  stagingRemote,
  transactionsAt,
  type StagingRemote,
} from "./refs";
import { defaultArtifactType } from "./registry";
import { capabilitySpecPath } from "./replay";
import { withTemporaryWorktree, WITHOUT_HOOKS } from "./worktree";

/** Bound on one publication, every fetch, apply and push included. */
const PUBLICATION_BUDGET_MS = 180_000;

/**
 * - `held`: a delivery is not merged (`reason: unmerged`), a change depends on an unpublished
 *   change of another group that could not publish (`reason: dependency-unpublished`), or, with
 *   `ownAnswersOnly`, a merge was answered by someone else (`reason: unconfirmed-merge`)
 * - `awaiting-publisher`: ready, but the remote refused this user's push to the default branch
 * - `deferred`: the remote stayed unreachable; nothing was published
 */
export type PublicationStatus =
  | "ok"
  | "held"
  | "conflict"
  | "error"
  | "deferred"
  | "awaiting-publisher";

/** A requirement changed since its delta was written, with the texts to resolve it from. */
export interface PublicationConflict {
  change: string;
  capability: string;
  requirement: string;
  /** The requirement as the delta was written against it. */
  base: string;
  /** The change's version; null when it removes the requirement or only renames it. */
  ours: string | null;
  /** The default branch's version; null when removed there. */
  theirs: string | null;
}

export interface PublicationResult {
  status: PublicationStatus;
  /** The Delivery Group, once known. */
  group: string | null;
  /** Its submitted changes, in publication order. */
  changes: string[];
  /** The records they became, on `ok`. */
  records: string[];
  /** The commit pushed to the default branch. */
  commit?: string;
  /** Published by an earlier run or a teammate; at most the inbox was emptied. */
  alreadyPublished?: boolean;
  reason?: "unmerged" | "dependency-unpublished" | "unconfirmed-merge";
  /** `dependency-unpublished`: the changes of other groups it waits for. */
  heldBy?: string[];
  /** The final merge results the group's changes record and who recorded each. */
  merges?: PublishedClaim[];
  /** Groups its changes depend on, published first in this run. */
  dependencies?: PublicationResult[];
  conflictedPaths: string[];
  warnings: string[];
  conflict?: PublicationConflict;
  /** The conflict is recorded as `blocked` in the change's Delivery Record on the pending branch. */
  blocked?: boolean;
  secretFindings?: SecretFinding[];
  message: string;
}

/** A {@link MergeClaim} of one change of the group. */
export interface PublishedClaim extends MergeClaim {
  change: string;
}

export interface PublishDeps {
  git?: (cwd: string) => CompanionGit;
  /**
   * Records the user's answers or a refresh into the Delivery Records of `changes` in `dir`, a
   * checkout of the pending branch; returns a refusal message or null.
   */
  settle?: (dir: string, changes: string[]) => Promise<string | null>;
  /** Settles a dependency's group published in the same run; never the user's answer. */
  settleDependency?: (dir: string, changes: string[]) => Promise<string | null>;
  scan?: (root: string, paths: string[], policyPath: string) => Promise<PublicationSecretScan>;
  /** Applies each change on the default branch; the bundled CLI by default. */
  runOpenSpec?: RunOpenSpec;
  artifactType?: ArtifactType;
  newTransaction?: () => string;
  /** The remote was just fetched; the first attempt reuses its refs. */
  fresh?: boolean;
  /** Publish the groups of unpublished dependencies first; true by default. */
  withDependencies?: boolean;
  /**
   * Hold a group back (`reason: unconfirmed-merge`) while a merge it rests on was answered by
   * someone else and found by no checkout: an unattended run takes nobody's word for it.
   */
  ownAnswersOnly?: boolean;
  /** The time a block is first recorded at. */
  now?: () => Date;
  tmpRoot?: string;
  /** Home of Mate's local companion state; `HOME` by default. */
  stateHome?: string;
}

const defaultGit = (cwd: string): CompanionGit =>
  companionGit(cwd, { prompt: "never", budgetMs: PUBLICATION_BUDGET_MS });

const absolute = (dir: string, relative: string): string => path.join(dir, ...relative.split("/"));

const head = async (git: CompanionGit, ref = "HEAD"): Promise<string> =>
  (await git.run(["rev-parse", "--verify", "-q", `${ref}^{commit}`])).stdout.trim();

/** What one publication run works with. */
interface Run {
  companionPath: string;
  type: ArtifactType;
  gitFor: (cwd: string) => CompanionGit;
  remote: StagingRemote;
  transaction: string;
  deps: PublishDeps;
}

function worktreeOptions(run: Run) {
  return {
    git: run.gitFor,
    types: [run.type],
    ...(run.deps.tmpRoot ? { tmpRoot: run.deps.tmpRoot } : {}),
  };
}

/**
 * Publishes a Delivery Group of submitted changes from any machine, once every delivery in it
 * is merged: in a temporary worktree of the fetched default branch its changes are applied in
 * `dependsOn` order, then submit order (stale check, the type's `apply`, `validate`), committed
 * once with a `Mate-Artifact` trailer per change and a `Mate-Transaction` trailer,
 * secret-scanned and pushed without force, rebuilt once on a rejected push. The group's
 * folders then leave the inbox in a second push. `target` is a Delivery Group or a submitted change.
 * The companion checkout then fast-forwards to the published commit when nothing blocks it.
 * Never throws.
 */
export async function publishSubmitted(
  companionPath: string,
  target: string,
  deps: PublishDeps = {},
): Promise<PublicationResult> {
  try {
    return await publishOnce(companionPath, target, deps, []);
  } catch (error) {
    return {
      ...emptyResult(null),
      message: `mate: publishing ${target} failed; nothing was published. ${errorMessage(error)}`,
    };
  }
}

function emptyResult(group: string | null): PublicationResult {
  return {
    status: "error",
    group,
    changes: [],
    records: [],
    conflictedPaths: [],
    warnings: [],
    message: "",
  };
}

async function publishOnce(
  companionPath: string,
  target: string,
  deps: PublishDeps,
  visiting: readonly string[],
): Promise<PublicationResult> {
  const gitFor = deps.git ?? defaultGit;
  const git = gitFor(companionPath);
  const configured = await stagingRemote(git);
  if (!configured) {
    return { ...emptyResult(null), message: "mate: the companion has no upstream to publish to." };
  }
  const type = deps.artifactType ?? defaultArtifactType(deps.runOpenSpec);
  const transaction = (deps.newTransaction ?? randomUUID)();

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let remote = configured;
    if (attempt > 1 || !deps.fresh) {
      // oxlint-disable-next-line no-await-in-loop -- each attempt starts from a fresh fetch
      const fetched = await fetchPendingBranches(git, configured);
      if ("error" in fetched) {
        return {
          ...emptyResult(null),
          status: fetched.transient ? "deferred" : "error",
          message: `mate: ${fetched.error}; nothing was published.`,
        };
      }
      remote = fetched;
    }
    const run: Run = { companionPath, type, gitFor, remote, transaction, deps };
    // oxlint-disable-next-line no-await-in-loop -- same attempt
    const submitted = await submittedAt(git, pendingRef(remote), type, deps.tmpRoot);
    // oxlint-disable-next-line no-await-in-loop -- same attempt
    const resolved = await resolveTarget(run, git, target, submitted);
    if ("result" in resolved) return resolved.result;
    const { group } = resolved;
    const base = { ...emptyResult(group), changes: resolved.members.map((change) => change.name) };

    if (resolved.members.length === 0) {
      // oxlint-disable-next-line no-await-in-loop -- returns
      const cleared = await clearInbox(run, group, resolved.inbox);
      return {
        ...base,
        status: "ok",
        alreadyPublished: true,
        ...(cleared ? { warnings: [cleared] } : {}),
        message: `${group} is already published on ${remote.defaultBranch}; nothing to do.`,
      };
    }

    // oxlint-disable-next-line no-await-in-loop -- same attempt
    const dependencies = await publishDependencies(run, resolved, submitted, visiting);
    if (dependencies && "held" in dependencies) return { ...base, ...dependencies.held };
    if (dependencies) {
      // The dependencies changed both branches; publish this group on their result.
      // oxlint-disable-next-line no-await-in-loop -- returns
      const own = await publishOnce(companionPath, group, { ...deps, fresh: false }, [
        ...visiting,
        group,
      ]);
      return { ...own, dependencies: [...dependencies.published, ...(own.dependencies ?? [])] };
    }

    // oxlint-disable-next-line no-await-in-loop -- same attempt
    const settled = await settleGroup(run, base, resolved.members);
    if (settled === "retry") continue;
    if (!("deliveries" in settled)) return settled;

    // oxlint-disable-next-line no-await-in-loop -- same attempt
    const merges = await claimsOf(run, resolved.members, settled);
    const answered = merges.filter(isOthersAnswer);
    if (deps.ownAnswersOnly && answered.length > 0) {
      // What a refresh just found is kept for the publication by name.
      if (settled.changed) {
        // oxlint-disable-next-line no-await-in-loop -- returns
        await recordOnPending(run, group, resolved.members, settled.deliveries, null);
      }
      return {
        ...base,
        status: "held",
        reason: "unconfirmed-merge",
        merges,
        message: `mate: ${group} is held back: ${describeClaims(answered)}. Publish ${group} by name to accept that.`,
      };
    }

    // oxlint-disable-next-line no-await-in-loop -- same attempt
    const outcome = await withTemporaryWorktree(
      companionPath,
      defaultRef(remote),
      (dir) =>
        publishIn(run, {
          dir,
          work: gitFor(dir),
          base,
          members: resolved.members,
          pendingCommit: settled.commit,
          deliveries: settled.deliveries,
        }),
      worktreeOptions(run),
    );
    if (outcome === "retry") continue;
    // oxlint-disable-next-line no-await-in-loop -- returns
    const result = await finish(run, outcome, resolved, settled);
    if (merges.length === 0) return result;
    const note =
      result.status === "ok" && answered.length > 0
        ? ` It rests on ${describeClaims(answered)}.`
        : "";
    return { ...result, merges, message: `${result.message}${note}` };
  }
  return {
    ...emptyResult(null),
    status: "conflict",
    message: `mate: the remote moved twice while publishing ${target}; publish again.`,
  };
}

/** The merge claims of `members`, as their settled records read. */
async function claimsOf(
  run: Run,
  members: readonly SubmittedChange[],
  settled: Settled,
): Promise<PublishedClaim[]> {
  const git = run.gitFor(run.companionPath);
  const claims = await Promise.all(
    members.map((change) =>
      mergeClaims(
        git,
        settled.commit,
        change.path,
        settled.records.get(change.name) ?? null,
        run.type,
      ),
    ),
  );
  return members.flatMap((change, index) =>
    claims[index]!.map((claim) => ({ change: change.name, ...claim })),
  );
}

/** Whose answers `claims` are, for a message. */
function describeClaims(claims: readonly PublishedClaim[]): string {
  return claims
    .map(
      (claim) =>
        `${claim.change} is ${claim.state} in ${inboxText(claim.repository)} by the answer of ${claim.recordedBy ? inboxText(claim.recordedBy) : "someone else"}, which no checkout checked`,
    )
    .join("; ");
}

/** Records the block or the settlement a publication left behind, and empties the inbox. */
async function finish(
  run: Run,
  outcome: Outcome,
  { members, inbox }: ResolvedTarget,
  settled: Settled,
): Promise<PublicationResult> {
  const group = outcome.group!;
  if (outcome.status === "ok") {
    const cleared = await clearInbox(run, group, inbox);
    // The checkout takes the published commit: its specs and archives are current at once.
    await adoptUpstream(run.companionPath, run.remote.defaultBranch, {
      homeDir: run.deps.stateHome,
    });
    return cleared ? { ...outcome, warnings: [...outcome.warnings, cleared] } : outcome;
  }
  const block =
    outcome.status === "conflict" && outcome.blocker
      ? { ...outcome.blocker, paths: outcome.conflictedPaths }
      : null;
  // Answers given for a group that did not publish are kept for the next attempt.
  const deliveries = settled.changed ? settled.deliveries : new Map<string, string>();
  if (!block && deliveries.size === 0) return strip(outcome);
  const recorded = await recordOnPending(run, group, members, deliveries, block);
  if (recorded.failure) {
    return strip({ ...outcome, warnings: [...outcome.warnings, recorded.failure] });
  }
  return strip({ ...outcome, ...(block ? { blocked: true } : {}) });
}

/** The result without the internal blocker. */
function strip(result: PublicationResult & { blocker?: unknown }): PublicationResult {
  const { blocker: _blocker, ...rest } = result;
  return rest;
}

interface ResolvedTarget {
  group: string;
  /** Its submitted changes not yet published, in publication order. */
  members: SubmittedChange[];
  /** Every change of it the inbox holds, published ones included. */
  inbox: string[];
}

/** The Delivery Group `target` names, or the result that ends the run. */
async function resolveTarget(
  run: Run,
  git: CompanionGit,
  target: string,
  submitted: readonly SubmittedChange[],
): Promise<ResolvedTarget | { result: PublicationResult }> {
  const { type, remote } = run;
  const named = isDeliveryGroup(target)
    ? target
    : submitted.find((change) => change.name === target)?.group;
  if (!named) {
    const published = (await anchorsAt(git, defaultRef(remote), type)).some(
      (id) => type.recordName(id) === target,
    );
    return {
      result: {
        ...emptyResult(null),
        ...(published ? { status: "ok", alreadyPublished: true } : {}),
        message: published
          ? `${target} is already published on ${remote.defaultBranch}; nothing to do.`
          : isDeliveryGroup(target)
            ? `mate: no Delivery Group ${target} with submitted changes on ${pendingPlace(remote)}.`
            : `mate: ${target} is not submitted. Submit it first with \`mate artifact submit ${target}\`.`,
      },
    };
  }
  const group = groupsOf(submitted).find((entry) => entry.group === named);
  if (!group) {
    return {
      result: {
        ...emptyResult(named),
        message: `mate: no Delivery Group ${named} with submitted changes on ${pendingPlace(remote)}.`,
      },
    };
  }
  // An earlier publication the inbox was not emptied after: only taken out of the inbox.
  const records = await recordsAt(git, defaultRef(remote), type);
  const published = await Promise.all(
    group.changes.map((change) =>
      publishedAs(git, defaultRef(remote), pendingRef(remote), type, change.name, records),
    ),
  );
  return {
    group: named,
    members: group.changes.filter((_, index) => published[index] === null),
    inbox: group.changes.map((change) => change.name),
  };
}

/**
 * Publishes the groups of the unpublished dependencies first; null when there are none. A
 * dependency that does not publish holds this group back.
 */
async function publishDependencies(
  run: Run,
  resolved: ResolvedTarget,
  submitted: readonly SubmittedChange[],
  visiting: readonly string[],
): Promise<{ held: Partial<PublicationResult> } | { published: PublicationResult[] } | null> {
  const { remote, type } = run;
  const git = run.gitFor(run.companionPath);
  const depended = unpublishedDependencies(
    { group: resolved.group, changes: resolved.members },
    submitted,
  );
  // Published, but the inbox was not emptied yet: no longer waited for.
  const records = depended.length > 0 ? await recordsAt(git, defaultRef(remote), type) : [];
  const archived = await Promise.all(
    depended.map((change) =>
      publishedAs(git, defaultRef(remote), pendingRef(remote), type, change.name, records),
    ),
  );
  const waiting = depended.filter((_, index) => archived[index] === null);
  if (waiting.length === 0) return null;
  const heldBy = waiting.map((change) => change.name);
  const held = (detail: string, dependencies: PublicationResult[] = []) => ({
    held: {
      status: "held" as const,
      reason: "dependency-unpublished" as const,
      heldBy,
      ...(dependencies.length > 0 ? { dependencies } : {}),
      message: `mate: ${resolved.group} is held back: it depends on ${heldBy.join(", ")}, ${detail}. Publish it once those are published.`,
    },
  });
  const groups = [...new Set(waiting.map((change) => change.group))];
  if (
    run.deps.withDependencies === false ||
    visiting.includes(resolved.group) ||
    groups.some((group) => visiting.includes(group))
  ) {
    return held("not published yet");
  }
  const published: PublicationResult[] = [];
  for (const group of groups) {
    // oxlint-disable-next-line no-await-in-loop -- dependencies publish one after another
    const result = await publishOnce(
      run.companionPath,
      group,
      {
        ...run.deps,
        fresh: false,
        newTransaction: randomUUID,
        settle: run.deps.settleDependency,
      },
      [...visiting, resolved.group],
    );
    published.push(result);
    if (result.status !== "ok")
      return held(`which could not publish (${result.status})`, published);
  }
  return { published };
}

/** A group ready to publish, with its settled Delivery Records by change. */
interface Settled {
  deliveries: ReadonlyMap<string, string>;
  /** The same records, parsed; a change without a readable one is left out. */
  records: ReadonlyMap<string, DeliveryRecord>;
  /** Settlement changed a record; kept on the pending branch if the publication fails. */
  changed: boolean;
  /** The pending-branch commit the records were read from. */
  commit: string;
}

/**
 * Settles the group's deliveries in a worktree of the pending branch and reads them. A group
 * held back gets its answers pushed to the pending branch; a publishable one hands them to the
 * publication, which publishes them with the changes.
 */
async function settleGroup(
  run: Run,
  base: PublicationResult,
  members: readonly SubmittedChange[],
): Promise<Settled | PublicationResult | "retry"> {
  const { type, remote, deps } = run;
  const names = members.map((change) => change.name);
  return withTemporaryWorktree(
    run.companionPath,
    pendingRef(remote),
    async (dir): Promise<Settled | PublicationResult | "retry"> => {
      const work = run.gitFor(dir);
      const companion = run.gitFor(run.companionPath);
      // The commit the worktree checked for links; a fetch may move the ref meanwhile.
      const commit = await head(work);
      if (deps.settle) {
        const refusal = await deps.settle(dir, names);
        if (refusal) return { ...base, message: refusal };
      }
      const held: string[] = [];
      const deliveries = new Map<string, string>();
      const records = new Map<string, DeliveryRecord>();
      for (const change of members) {
        const folder = sourceDir(dir, type, change.name);
        // oxlint-disable-next-line no-await-in-loop -- a handful of changes per group
        const delivery = await readDeliveryState(folder);
        const hold = deliveryHold({ ...change, delivery });
        if (hold) held.push(hold);
        if (delivery.record) records.set(change.name, delivery.record);
        const file = path.join(folder, type.deliveryFile);
        // oxlint-disable-next-line no-await-in-loop -- same change
        const text = await fs.readFile(file, "utf8").catch(() => null);
        if (text !== null) deliveries.set(change.name, text);
      }
      await work.run([
        ...LITERAL_PATHSPECS,
        "add",
        "-f",
        "-A",
        "--",
        ...members.map((change) => change.path),
      ]);
      const changed = (await work.run(["diff", "--cached", "--quiet"])).status !== 0;
      if (held.length === 0) return { deliveries, records, changed, commit };
      if (changed) {
        const findings = await stagedSecrets(run, work, dir);
        if (findings.length > 0) {
          return {
            ...base,
            secretFindings: findings,
            message: `mate: refusing to record the delivery of ${base.group}: it contains secrets. Nothing was pushed or published.`,
          };
        }
        const pushed = await commitAndPush(
          work,
          remote,
          `chore(${type.name}): record delivery of ${base.group}`,
          `${run.transaction}-record`,
        );
        // A cut-off push may still have been accepted; the trailer settles it. Fetched from the
        // companion checkout: in this worktree a relative `core.hooksPath` names inbox content.
        const recorded =
          pushed.status === 0 ||
          ("transport" in pushed &&
            !isRejectedPush(pushed) &&
            (await fetchStaging(companion, remote)).status === 0 &&
            (await transactionsAt(companion, pendingRef(remote))).includes(
              `${run.transaction}-record`,
            ));
        if (!recorded) {
          // The remote moved: rebuilt on a fresh fetch, or a conflict after the last attempt.
          if ("transport" in pushed && isRejectedPush(pushed)) return "retry";
          return {
            ...base,
            status:
              "transport" in pushed && isTransientRemoteFailure(pushed) ? "deferred" : "error",
            message: `mate: recording the delivery of ${base.group} on ${pendingPlace(remote)} failed; nothing was published. ${describeGitFailure(pushed)}`,
          };
        }
      }
      return {
        ...base,
        status: "held",
        reason: "unmerged",
        message: `mate: ${base.group} is held back: ${held.join(", ")}. Publish it once every delivery is merged.`,
      };
    },
    worktreeOptions(run),
  );
}

/** Secret findings in the files staged in `work` at `dir`; none when the policy skips the scan. */
async function stagedSecrets(run: Run, work: CompanionGit, dir: string): Promise<SecretFinding[]> {
  const staged = await work.run(["diff", "--cached", "--name-only", "--diff-filter=d", "-z"]);
  const scanned = await (run.deps.scan ?? scanPublication)(
    dir,
    nulPaths(staged.stdout),
    run.companionPath,
  );
  return scanned.skipped ? [] : scanned.findings;
}

async function commitAndPush(
  work: CompanionGit,
  remote: StagingRemote,
  subject: string,
  transaction: string,
): Promise<GitResult | NetworkGitResult> {
  const committed = await work.run([
    ...WITHOUT_HOOKS,
    "commit",
    "-q",
    "-m",
    subject,
    "-m",
    `${TRANSACTION_TRAILER}: ${transaction}`,
  ]);
  return committed.status === 0 ? pushPending(work, remote) : committed;
}

interface PublishIn {
  dir: string;
  work: CompanionGit;
  base: PublicationResult;
  members: readonly SubmittedChange[];
  /** The pending-branch commit the changes are read from, as {@link settleGroup} checked it. */
  pendingCommit: string;
  deliveries: ReadonlyMap<string, string>;
}

type Outcome = PublicationResult & {
  blocker?: { change: string | null; reason: string; tip: string };
};

/** Applies, commits, scans and pushes the group on the checked-out default tip. */
async function publishIn(run: Run, input: PublishIn): Promise<Outcome | "retry"> {
  const { type, remote, transaction } = run;
  const { dir, work, base, members, pendingCommit } = input;
  const start = await head(work);
  const paths = members.map((change) => change.path);
  // A folder committed while active goes first: a file the submitted one dropped must not stay.
  await work.run([...LITERAL_PATHSPECS, "rm", "-r", "-q", "--ignore-unmatch", "--", ...paths]);
  // Without hooks: `post-checkout` would run on a teammate's pending tree.
  const read = await work.run([
    ...WITHOUT_HOOKS,
    ...LITERAL_PATHSPECS,
    "checkout",
    "-q",
    pendingCommit,
    "--",
    ...paths,
  ]);
  if (read.status !== 0) {
    return {
      ...base,
      message: `mate: reading ${base.group} from the inbox failed; nothing was published. ${describeGitFailure(read)}`,
    };
  }
  for (const change of members) {
    const folder = absolute(dir, change.path);
    const settled = input.deliveries.get(change.name);
    // oxlint-disable-next-line no-await-in-loop -- a handful of changes per group
    if (settled !== undefined) await fs.writeFile(path.join(folder, type.deliveryFile), settled);
    // Publication clears a block; the published record never carries one.
    // oxlint-disable-next-line no-await-in-loop -- same change
    const record = await readDeliveryRecord(folder).catch(() => null);
    if (record?.blocked) {
      delete record.blocked;
      // oxlint-disable-next-line no-await-in-loop -- same change
      await writeDeliveryRecord(folder, record);
    }
  }
  const git = run.gitFor(run.companionPath);
  const bases = await Promise.all(
    members.map((change) => deltaBase(git, defaultRef(remote), pendingCommit, change, type)),
  );
  // Without a base nothing can be found stale: a part changed since would be overwritten unseen.
  const undated = members.find((change, index) => !bases[index] && change.touches.length > 0);
  if (undated) {
    return {
      ...base,
      status: "conflict",
      message: `mate: ${base.group} cannot be published: the commit ${undated.name} was written against is unknown, so what changed on ${remote.defaultBranch} since cannot be checked. Nothing was published. Submit ${undated.name} again with \`mate artifact submit ${undated.name}\`, then publish again.`,
    };
  }
  const applied = await applyChain({
    type,
    work,
    dir,
    members: members.map((change, index) => ({ name: change.name, base: bases[index] ?? null })),
    ref: pendingCommit,
    start,
  });
  if (isChainFailure(applied)) return chainConflict(run, base, applied, start);

  const scanned = await (run.deps.scan ?? scanPublication)(dir, applied.changed, run.companionPath);
  if (!scanned.skipped && scanned.findings.length > 0) {
    return {
      ...base,
      secretFindings: scanned.findings,
      message: `mate: refusing to publish ${base.group}: it contains secrets. Nothing was pushed.`,
    };
  }
  // Without the companion's hooks, as every commit made in a temporary worktree: one written
  // for the checkout would abort the publication.
  const committed = await work.run([
    ...WITHOUT_HOOKS,
    "commit",
    "-q",
    "-m",
    `chore(${type.name}): publish ${base.group}`,
    "-m",
    [
      ...applied.records.map(
        (record) => `${ARTIFACT_TRAILER}: ${artifactTrailerValue(type, record)}`,
      ),
      // Without an archive, how a later submission of the same name is told apart.
      ...(type.archiveRoot === undefined ? [`${INBOX_TRAILER}: ${pendingCommit}`] : []),
      `${TRANSACTION_TRAILER}: ${transaction}`,
    ].join("\n"),
  ]);
  if (committed.status !== 0) {
    return {
      ...base,
      message: `mate: committing ${base.group} on ${remote.defaultBranch} failed; nothing was published. ${describeGitFailure(committed)}`,
    };
  }
  const commit = await head(work);
  const pushed = await work.push(
    [remote.remote, `HEAD:refs/heads/${remote.defaultBranch}`],
    WITHOUT_HOOKS,
  );
  if (pushed.status !== 0) {
    // The remote moved: rebuilt on a fresh fetch, or a conflict after the last attempt.
    if (isRejectedPush(pushed)) return "retry";
    if (isPushNotPermitted(pushed)) {
      return {
        ...base,
        status: "awaiting-publisher",
        message: `${base.group} is ready, but the companion refused your push to ${remote.defaultBranch}. Someone with push rights publishes it; its changes stay submitted.`,
      };
    }
    // A cut-off push may still have been accepted; the trailer settles it. Fetched from the
    // companion checkout, so no hook path resolves inside this worktree.
    const accepted =
      (await fetchStaging(git, remote)).status === 0 &&
      (await transactionsAt(git, defaultRef(remote))).includes(transaction);
    if (!accepted) {
      return {
        ...base,
        status: isTransientRemoteFailure(pushed) ? "deferred" : "error",
        message: `mate: pushing ${remote.defaultBranch} failed; nothing was published. ${describeGitFailure(pushed)}`,
      };
    }
  }
  return {
    ...base,
    status: "ok",
    records: applied.records,
    commit,
    message: `Published ${base.group} (${applied.records.join(", ")}) to ${remote.defaultBranch}.`,
  };
}

/** A chain that cannot be applied on default tip `tip`, as a conflict that published nothing. */
function chainConflict(
  run: Run,
  base: PublicationResult,
  failure: ChainFailure,
  tip: string,
): Outcome {
  const reason = describeFailure(failure, run.remote.defaultBranch);
  const versions = failure.kind === "stale" ? failure.failure.versions : undefined;
  return {
    ...base,
    status: "conflict",
    conflictedPaths: failurePaths(failure, capabilitySpecPath),
    blocker: { change: failure.change, reason, tip },
    ...(failure.kind === "stale" && versions
      ? {
          conflict: {
            change: failure.change,
            capability: failure.failure.capability,
            requirement: failure.failure.requirement,
            ...versions,
          },
        }
      : {}),
    message: `mate: ${base.group} cannot be published: ${reason}. Nothing was published and the submitted changes are unchanged. ${failureRemedy(failure)}`,
  };
}

/**
 * Commits `edit` to the pending branch the run fetched from; `edit` returns the paths it touched.
 * Best effort: returns the failure, or null when done or not needed.
 */
async function editPendingBranch(
  run: Run,
  subject: string,
  transaction: string,
  edit: (work: CompanionGit, dir: string) => Promise<string[]>,
): Promise<string | null> {
  const result = await commitToPending<string>(
    {
      companionPath: run.companionPath,
      subject,
      remote: run.remote,
      transaction,
      edit: async (dir) => {
        try {
          return await edit(run.gitFor(dir), dir);
        } catch (error) {
          // Runs after the publication's outcome is settled; it must not turn into a failed one.
          return {
            stop: describeGitFailure({ status: 1, stdout: "", stderr: errorMessage(error) }),
          };
        }
      },
    },
    {
      git: run.gitFor,
      artifactType: run.type,
      ...(run.deps.scan ? { scan: run.deps.scan } : {}),
      ...(run.deps.tmpRoot ? { tmpRoot: run.deps.tmpRoot } : {}),
    },
  );
  if (result.status === "stopped") return result.value ?? null;
  if (result.status !== "failed") return null;
  if (result.reason === "secret") {
    const files = [...new Set(result.secretFindings.map((finding) => finding.path))];
    return `it contains secrets at ${files.join(", ")}`;
  }
  return "git" in result ? describeGitFailure(result.git) : result.detail;
}

/**
 * Takes the published changes of `group` out of the inbox: those of `names`, its changes there,
 * the default branch holds an archive of. Both branches are read fresh, and only those folders,
 * so a later publication resumes an interrupted one. Returns a warning when they stay.
 */
async function clearInbox(
  run: Run,
  group: string,
  names: readonly string[],
): Promise<string | null> {
  const { type, remote } = run;
  const failure = await editPendingBranch(
    run,
    `chore(${type.name}): clear published ${group}`,
    `${run.transaction}-clear`,
    async (work) => {
      const present = await submittedAt(work, "HEAD", type, run.deps.tmpRoot, names);
      const records = present.length > 0 ? await recordsAt(work, defaultRef(remote), type) : [];
      const published = await Promise.all(
        present.map((change) =>
          publishedAs(work, defaultRef(remote), "HEAD", type, change.name, records),
        ),
      );
      const paths = present.filter((_, index) => published[index] !== null).map((c) => c.path);
      if (paths.length === 0) return [];
      const removed = await work.run([
        ...LITERAL_PATHSPECS,
        "rm",
        "-r",
        "-q",
        "--ignore-unmatch",
        "--",
        ...paths,
      ]);
      if (removed.status !== 0) throw new Error(describeGitFailure(removed));
      return paths;
    },
  );
  return failure === null
    ? null
    : `${group} is published, but its changes stay in the inbox ${INBOX_BRANCH} (${failure}); the next publication of the group takes them out.`;
}

/** True when `a` and `b` name the same block, whenever and on whichever tip it was seen. */
function sameBlock(a: DeliveryBlock, b: Pick<DeliveryBlock, "reason" | "paths">): boolean {
  return a.reason === b.reason && a.paths.join("\n") === b.paths.join("\n");
}

/**
 * Keeps a group's settled Delivery Records and its block on the pending branch: `block` goes into
 * the record of the change that caused it, or of every member when none is known, unless the
 * same block is recorded already for the same default tip; a block seen again keeps its `since`.
 * Committed only when something changed.
 */
async function recordOnPending(
  run: Run,
  group: string,
  members: readonly SubmittedChange[],
  deliveries: ReadonlyMap<string, string>,
  block: { change: string | null; reason: string; paths: string[]; tip: string } | null,
): Promise<{ failure: string | null }> {
  const { type, remote } = run;
  const failure = await editPendingBranch(
    run,
    block
      ? `chore(${type.name}): block ${group}`
      : `chore(${type.name}): record delivery of ${group}`,
    `${run.transaction}-${block ? "block" : "record"}`,
    async (_work, dir) => {
      const paths: string[] = [];
      const tip = block && isCommitId(block.tip) ? block.tip : undefined;
      for (const change of members) {
        const folder = sourceDir(dir, type, change.name);
        // oxlint-disable-next-line no-await-in-loop -- a handful of changes per group
        if (!(await fs.stat(folder).catch(() => null))) continue;
        paths.push(change.path);
        const settled = deliveries.get(change.name);
        if (settled !== undefined) {
          // oxlint-disable-next-line no-await-in-loop -- same change
          await fs.writeFile(path.join(folder, type.deliveryFile), settled);
        }
        if (!block || (block.change !== null && block.change !== change.name)) continue;
        // oxlint-disable-next-line no-await-in-loop -- same change
        const record = await readDeliveryRecord(folder).catch(() => null);
        if (!record) continue;
        const known = record.blocked && sameBlock(record.blocked, block) ? record.blocked : null;
        if (known && known.tip === tip) continue;
        const since = known?.since ?? (run.deps.now ?? (() => new Date()))().toISOString();
        // oxlint-disable-next-line no-await-in-loop -- same change
        await writeDeliveryRecord(folder, {
          ...record,
          blocked: { reason: block.reason, paths: block.paths, since, ...(tip ? { tip } : {}) },
        });
      }
      return paths;
    },
  );
  return {
    failure:
      failure === null
        ? null
        : `recording ${block ? `${group} as blocked` : `the delivery of ${group}`} on ${pendingPlace(remote)} failed (${failure}).`,
  };
}

export interface PublicationQueue {
  /** The Delivery Groups `publish --all` publishes, dependencies first. */
  groups: string[];
  /** The remote was fetched for it; false when the groups come from the last fetched refs. */
  fresh: boolean;
}

/** The Delivery Groups `publish --all` publishes, dependencies first. */
export async function publicationQueue(
  companionPath: string,
  deps: Pick<PublishDeps, "git" | "artifactType" | "tmpRoot"> = {},
): Promise<PublicationQueue> {
  const type = deps.artifactType ?? defaultArtifactType();
  const git = (deps.git ?? defaultGit)(companionPath);
  const configured = await stagingRemote(git);
  if (!configured) return { groups: [], fresh: false };
  // A failed fetch leaves the last fetched refs; each publication then fetches for itself.
  const fetched = await fetchPendingBranches(git, configured);
  const fresh = !("error" in fetched);
  const remote = "error" in fetched ? configured : fetched;
  const submitted = await submittedAt(git, pendingRef(remote), type, deps.tmpRoot);
  return {
    groups: publicationOrder(groupsOf(submitted), submitted).map((group) => group.group),
    fresh,
  };
}
