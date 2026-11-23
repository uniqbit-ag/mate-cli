import { ARTIFACT_TRAILER, archiveOfArtifact } from "../../../../lib/artifact-trailer";
import { changeNameOf, parseAnchor } from "../../../../lib/change-layout";
import {
  recordDelivery,
  type DeliveryEdit,
  type RecordDeliveryDeps,
} from "../../../../lib/delivery/record-delivery";
import type { ArtifactType } from "../../../../lib/delivery/staging/artifact-type";
import { isDeliveryGroup } from "../../../../lib/delivery/staging/naming";
import { groupOfChange } from "../../../../lib/delivery/staging/submit";
import { declaredSubmitType } from "../../../../lib/delivery/staging/registry";
import { errorMessage } from "../../../../runtime/error-message";
import { settleLinked } from "../../../../lib/delivery/staging/settle-linked";
import {
  publicationQueue,
  publishSubmitted,
  type PublicationQueue,
  type PublicationResult,
  type PublishDeps,
} from "../../../../lib/delivery/staging/publish";
import { stagingRemote } from "../../../../lib/delivery/staging/refs";
import { resolveForCapability } from "../../../../lib/orchestrator/framework-context";
import { companionGit, outputLines } from "../../../../runtime/companion-git";
import type { BranchOutcome } from "../../../../lib/delivery/refresh";
import { CONFIRM_FLAGS, confirmFlag } from "../delivery/branch-flags";
import { resolveDeliveryEnvironment, type DeliveryEnvironmentDeps } from "../delivery/environment";
import { renderOutcome } from "../delivery/output";
import type { LaunchContext } from "../../../../lib/orchestrator/framework-context";
import type { CapabilityConfig } from "../../../../lib/orchestrator/types";
import { WorkingRepoRequiredError } from "../../../../lib/orchestrator/types";
import { type BooleanFlagSet, parseFlags } from "../../../parse-flags";
import { ensureUnambiguousCompanion } from "../../shared/companion-selection";
import { discoverArchives, pendingArchives } from "../pending/discovery";
import { type FinishResult, printFinishResult, runFinishEngine } from "./engine";
import type { ArtifactFinisher, FinishContext, FinisherFactory } from "./finisher";
import { defaultGitOps, type GitOps } from "./git";
import {
  openspecSpecsFinisher,
  publicationHold,
  publicationHoldCache,
  resolveDriftedSpecs,
} from "./openspec";
import { DEFAULT_FINISHER_TYPE, knownFinisherTypes, selectFinisher } from "./registry";
import { type PublicationSecretScan, scanPublication } from "./secret-scan";
import { cleanUpCompletedWorksets, type WorktreeCleanupDeps } from "./worktree-cleanup";

export interface PublishCommandDeps {
  ensureUnambiguousCompanion?: (cwd: string) => Promise<boolean>;
  resolveContext?: (cwd: string) => Promise<LaunchContext>;
  loadCapabilities?: (context: LaunchContext) => Promise<CapabilityConfig[]>;
  selectFinisher?: (type: string) => FinisherFactory | undefined;
  git?: (companionPath: string, workingRepoPath?: string) => GitOps;
  /** Injectable clock; a spec publication's anchor is the calendar date it runs on. */
  now?: () => Date;
  /** Injectable spec-publication finisher; mirrors `selectFinisher` for the other unit. */
  specsFinisher?: (context: FinishContext, paths: string[], now: () => Date) => ArtifactFinisher;
  /** Injectable pre-commit secret scan over a publication's staged outputs. */
  scanPublication?: (
    companionPath: string,
    commitPaths: string[],
  ) => Promise<PublicationSecretScan>;
  /** Injectable readers and prune for the cleanup after a Workset becomes Done. */
  worktreeCleanup?: WorktreeCleanupDeps;
  /** Publishes a Delivery Group of submitted changes; see {@link publishSubmitted}. */
  publishSubmitted?: (
    companionPath: string,
    target: string,
    deps: PublishDeps,
  ) => Promise<PublicationResult>;
  /** True when the companion has an upstream a Delivery Group publishes to. */
  hasRemote?: (companionPath: string) => Promise<boolean>;
  /** True when an earlier publication of the target is committed on `HEAD` but not pushed. */
  unpushedPublication?: (companionPath: string, target: string) => Promise<boolean>;
  /** The Delivery Groups `--all` publishes; see {@link publicationQueue}. */
  publicationQueue?: (companionPath: string) => Promise<PublicationQueue>;
  /** Builds the delivery environment `--refresh` and `--confirm-*` settle with. */
  deliveryEnvironment?: DeliveryEnvironmentDeps & RecordDeliveryDeps;
  /** `--refresh`: records the merges linked checkouts settle first; see {@link settleLinked}. */
  settleLinked?: typeof settleLinked;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** Presence-only flags; every other `--flag` consumes the following token as its value. */
const BOOLEAN_FLAGS: BooleanFlagSet = new Set([
  "no-push",
  "json",
  "specs",
  "all",
  "refresh",
  ...CONFIRM_FLAGS,
]);

async function defaultHasRemote(companionPath: string): Promise<boolean> {
  return (await stagingRemote(companionGit(companionPath, { prompt: "never" }))) !== null;
}

/**
 * An earlier publication of `target` committed on `HEAD` that never reached the upstream: a
 * `--no-push` commit, or a tag an older Mate version created. It is pushed from the checkout.
 */
export async function unpushedPublication(companionPath: string, target: string): Promise<boolean> {
  const git = companionGit(companionPath, { prompt: "never" });
  const upstream = (await git.upstreamTarget())?.ref;
  if (!upstream) return false;
  const log = await git.run([
    "log",
    `--format=%(trailers:key=${ARTIFACT_TRAILER},valueonly,separator=%x0a)`,
    "--end-of-options",
    `${upstream}..HEAD`,
  ]);
  const matches = (anchor: string): boolean =>
    anchor === target || (parseAnchor(anchor) !== null && changeNameOf(anchor) === target);
  const published = log.status === 0 ? outputLines(log.stdout).map(archiveOfArtifact) : [];
  if (published.some((anchor) => anchor !== null && matches(anchor))) return true;
  const tags = await git.run([
    "for-each-ref",
    "--format=%(refname:strip=3)",
    "refs/tags/openspec/",
  ]);
  if (tags.status !== 0) return false;
  for (const anchor of outputLines(tags.stdout).filter(matches)) {
    const tag = `refs/tags/openspec/${anchor}`;
    // A tag left on a commit a rebase replaced is not on HEAD, so it marks nothing to push.
    // oxlint-disable-next-line no-await-in-loop -- one tag per archive of the change
    const onHead = await git.run(["merge-base", "--is-ancestor", tag, "HEAD"]);
    if (onHead.status !== 0) continue;
    // oxlint-disable-next-line no-await-in-loop -- same tag
    const reached = await git.run(["merge-base", "--is-ancestor", tag, upstream]);
    if (reached.status === 1) return true;
  }
  return false;
}

/** A Delivery Group publication as the publish result the skill reads. */
function publicationResult(
  type: string,
  target: string,
  publication: PublicationResult,
): FinishResult {
  const ok = publication.status === "ok";
  return {
    type,
    name: target,
    anchorName: publication.records[0] ?? null,
    tag: null,
    ...(publication.commit ? { commit: publication.commit } : {}),
    ...(publication.group ? { group: publication.group } : {}),
    changes: publication.changes,
    anchors: publication.records,
    ...(publication.reason ? { reason: publication.reason } : {}),
    ...(publication.heldBy ? { heldBy: publication.heldBy } : {}),
    ...(publication.merges ? { merges: publication.merges } : {}),
    ...(publication.blocked ? { blocked: true } : {}),
    ...(publication.conflict ? { conflict: publication.conflict } : {}),
    ...(publication.dependencies
      ? {
          dependencies: publication.dependencies.map((dependency) =>
            publicationResult(type, dependency.group ?? target, dependency),
          ),
        }
      : {}),
    resumed: publication.alreadyPublished === true,
    step: ok ? "done" : publication.status === "held" ? "resolve" : "publish",
    status: publication.status,
    conflictedPaths: publication.conflictedPaths,
    local: { committed: ok, tagged: false, pushed: ok },
    message: publication.message,
    ...(publication.secretFindings ? { secretFindings: publication.secretFindings } : {}),
    ...(publication.warnings.length > 0 ? { warning: publication.warnings.join(" ") } : {}),
  };
}

/** Every result a publication carries: its own and those of dependencies published first. */
function flattened(results: readonly FinishResult[]): FinishResult[] {
  return results.flatMap((result) => [...flattened(result.dependencies ?? []), result]);
}

/** A deferral halts too: the remote is likely still unreachable. */
function halted(result: FinishResult): boolean {
  return result.status === "conflict" || result.status === "error" || result.status === "deferred";
}

/** The archives an `ok` result published. */
function publishedBy(result: FinishResult): string[] {
  if (result.status !== "ok") return [];
  return result.anchors ?? (result.anchorName ? [result.anchorName] : []);
}

function deliveryRefusal(changes: string[], reason: string): string {
  return `mate: the delivery of ${changes.join(", ")} could not be recorded (${reason}).`;
}

/**
 * Every non-flag token, in order. Consumes the value of a value-taking flag exactly as
 * {@link parseFlags} does, so the positionals and the flags can never disagree about
 * which token belongs to whom.
 */
function positionalNames(argv: string[]): string[] {
  const names: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      names.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key.includes("=") || BOOLEAN_FLAGS.has(key)) continue;
    index += 1;
  }
  return names;
}

async function defaultLoadCapabilities(context: LaunchContext): Promise<CapabilityConfig[]> {
  const config = await context.configStore.load();
  return config.capabilities ?? [];
}

/** A publication the pipeline never ran: nothing was resolved, committed, or pushed. */
function nothingToPublish(name: string, message: string): FinishResult {
  return {
    type: DEFAULT_FINISHER_TYPE,
    name,
    anchorName: null,
    tag: null,
    resumed: false,
    step: "done",
    status: "skipped",
    conflictedPaths: [],
    local: { committed: false, tagged: false, pushed: false },
    message,
  };
}

function refusalResult(type: string, name: string, message: string): FinishResult {
  return {
    type,
    name,
    anchorName: null,
    tag: null,
    resumed: false,
    step: "resolve",
    status: "error",
    conflictedPaths: [],
    local: { committed: false, tagged: false, pushed: false },
    message,
  };
}

/**
 * @command mate artifact publish <target>
 * @description Publishes artifacts to the companion's default branch. A submitted change is
 * published with its whole Delivery Group, from any machine, once every delivery in it is
 * merged: in a temporary worktree of the fetched default branch its changes are applied in
 * `dependsOn` order, then submit order (stale check against `specBase`, `openspec archive`,
 * spec validation), committed once with a `Mate-Artifact` trailer per change and a
 * `Mate-Transaction` trailer, secret-scanned and pushed without force, rebuilt once. The
 * group then leaves the inbox `mate/inbox`. A conflict publishes nothing and records `blocked`
 * in the change's `delivery.yaml` on the pending branch; a refused push is
 * `awaiting-publisher`. The checkout and its `HEAD` are not touched. A change depending on an
 * unpublished change of another group publishes that group first, or is held
 * (`dependency-unpublished`). Archives an earlier Mate left uncommitted in this checkout,
 * drifted canonical specs (`--specs`), `--no-push`, and companions without a remote use the
 * commit pipeline on `HEAD` (resolve, branch guard, cap sync, secret scan, commit,
 * sync-with-remote, push). No tag is created; results carry the published `commit`.
 * @flags
 * - `<target>` — a Delivery Group (`<repository>/<branch>`, `change/<name>`), a submitted change
 *   name, or the dated anchor (`YYYY-MM-DD-<name>`) or name of a local archive from an earlier
 *   Mate. Mutually exclusive with `--specs` and `--all`.
 * - `--refresh` — before publishing, record the merges this machine's linked checkouts settle
 *   for every submitted change, then check each branch of the group's changes in its linked
 *   checkout, recorded in its `delivery.yaml` on the pending branch (published with the group,
 *   else pushed there alone).
 * - `--confirm-merged` / `--confirm-open` / `--confirm-dropped` — the user's answer for the
 *   group's Working Repository delivery, recorded the same way. One at a time; never with
 *   `--all`, `--specs` or `--no-push`.
 * - `--specs [<path>...]` — publish drifted canonical specs as their own publication. Bare, it
 *   publishes every drifted spec; with paths, only those. A bare name alongside it is a change
 *   target and is refused.
 * - `--all` — publish every submitted Delivery Group, dependencies first, then every local
 *   archive of an earlier Mate, then one spec publication for the drift that remains. Skips
 *   what is held or awaits a publisher, and a group resting on a merge someone else answered
 *   that no checkout found (`unconfirmed-merge`; publish it by name to accept the answer); a group's conflict blocks only that group and the run
 *   goes on, exiting 1 at the end. Halts at the first error or deferral; with `--json` it emits
 *   a single array of results in execution order.
 * - `--type <type>` — finisher type to use; see `knownFinisherTypes()`. `--specs` and
 *   `--all` are openspec-only.
 * - `--no-push` — commit a local archive on `HEAD` but skip the remote sync and push.
 * - `--json` — emit machine-readable JSON instead of human-readable text.
 * @remarks No-ops (with a message on stderr) when the selected finisher is disabled for the
 * repo's configured capabilities — nothing is resolved or mutated in that case.
 */
export async function runArtifactPublishCommand(
  argv: string[],
  deps: PublishCommandDeps = {},
): Promise<void> {
  const emitOut = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emitErr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  const flags = parseFlags(argv, BOOLEAN_FLAGS);
  const noPush = flags["no-push"] === true;
  const json = flags.json === true;
  const type = typeof flags.type === "string" ? flags.type : DEFAULT_FINISHER_TYPE;
  const specsMode = flags.specs === true;
  const allMode = flags.all === true;
  const positionals = positionalNames(argv);

  /** With `--specs`, a path narrows the publication; a bare name is a change target. */
  const specPaths = specsMode ? positionals.filter((token) => token.includes("/")) : [];
  const changeTargets = specsMode
    ? positionals.filter((token) => !token.includes("/"))
    : positionals;

  /** Argument refusals go to stderr in every mode: nothing was resolved to report on. */
  const refuse = (message: string): void => {
    emitErr(message);
    process.exitCode = 1;
  };

  if (allMode && (specsMode || positionals.length > 0)) {
    refuse(
      "mate: --all already publishes both pending changes and drifted specs; drop the extra target.",
    );
    return;
  }
  if (specsMode && changeTargets.length > 0) {
    refuse(
      `mate: "${changeTargets[0]}" is a change target and --specs publishes canonical specs; they are different publication units. Pass one or the other.`,
    );
    return;
  }
  if (!allMode && !specsMode && positionals.length === 0) {
    refuse(
      "mate: artifact publish requires a Delivery Group, a change name or archive anchor, --specs, or --all.",
    );
    return;
  }
  const confirmation = confirmFlag(flags);
  if ("error" in confirmation) {
    refuse(confirmation.error);
    return;
  }
  const { confirm } = confirmation;
  const refresh = flags.refresh === true;
  const settling = refresh || confirm !== undefined;
  if (confirm !== undefined && (allMode || specsMode)) {
    refuse(
      "mate: --confirm-* answers for the Delivery Group of one target; name it instead of --all or --specs.",
    );
    return;
  }
  if (settling && (specsMode || noPush)) {
    refuse(
      "mate: --refresh and --confirm-* record on the pending branch, which --specs and --no-push never reach; record with `mate artifact link` instead.",
    );
    return;
  }
  if ((allMode || specsMode) && type !== DEFAULT_FINISHER_TYPE) {
    refuse(`mate: --specs and --all are only available for the ${DEFAULT_FINISHER_TYPE} type.`);
    return;
  }

  const selectFinisherFn = deps.selectFinisher ?? selectFinisher;
  const finisherFactory = selectFinisherFn(type);
  if (!finisherFactory) {
    emitErr(
      `mate: unknown artifact type "${type}". Known types: ${knownFinisherTypes().join(", ")}.`,
    );
    process.exitCode = 1;
    return;
  }

  const ensureCompanion = deps.ensureUnambiguousCompanion ?? ensureUnambiguousCompanion;
  if (!(await ensureCompanion(process.cwd()))) {
    process.exitCode = 1;
    return;
  }

  const resolveContext = deps.resolveContext ?? ((cwd: string) => resolveForCapability(cwd));
  let context: LaunchContext;
  try {
    context = await resolveContext(process.cwd());
  } catch (err) {
    if (err instanceof WorkingRepoRequiredError) {
      emitErr(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const loadCapabilities = deps.loadCapabilities ?? defaultLoadCapabilities;
  const capabilities = await loadCapabilities(context);

  // The declared type the companion's submit handles; an invalid declaration publishes nothing.
  let declaredType: ArtifactType | undefined;
  try {
    declaredType = await declaredSubmitType(context.companionPath);
  } catch (err) {
    emitErr(`mate: ${errorMessage(err)}`);
    process.exitCode = 1;
    return;
  }
  const typeDeps = declaredType ? { artifactType: declaredType } : {};

  let git: GitOps;
  const finishContext: FinishContext = {
    companionPath: context.companionPath,
    repositoryId: context.repositoryId,
    repository: context.repository,
    // Resolution runs only after `git` is set below.
    changedPaths: () => git.changedPaths(),
    holdCache: publicationHoldCache(),
  };
  const finisher = finisherFactory(finishContext);
  if (!finisher.isEnabled(capabilities)) {
    // No-op with message: nothing was validated, produced, or mutated.
    emitErr(finisher.disabledReason);
    return;
  }

  try {
    git = (deps.git ?? defaultGitOps)(
      context.companionPath,
      context.repository?.path ?? process.env.MATE_REPO_PATH,
    );
  } catch (err) {
    const message = `mate: publish Git guard rejected the target: ${String(err)}`;
    if (json) emitOut(JSON.stringify(refusalResult(type, positionals[0] ?? "", message)));
    else emitErr(message);
    process.exitCode = 1;
    return;
  }

  const now = deps.now ?? (() => new Date());
  /**
   * Under `--all --json` the array is the whole output, so the per-publication emission is
   * suppressed; every other mode lets the engine report each publication as it finishes.
   */
  const quiet = allMode && json;
  const scanPublicationFn = deps.scanPublication ?? scanPublication;
  const engineDeps = {
    git,
    json: !allMode && json,
    stdout: quiet ? (): void => {} : emitOut,
    stderr: quiet ? (): void => {} : emitErr,
    secretScan: (commitPaths: string[]) => scanPublicationFn(context.companionPath, commitPaths),
  };

  const deliveryEnvironment = () =>
    resolveDeliveryEnvironment({
      ensureUnambiguousCompanion: async () => true,
      resolveContext: async () => context,
      loadCapabilities: async () => capabilities,
      ...deps.deliveryEnvironment,
    });

  /** `--refresh`: the merges linked checkouts settle are recorded once per run, before any group. */
  let linkedSettled: Promise<boolean> | undefined;
  /** True when it pushed a record, which leaves refs fetched before it stale. */
  const settleLinkedOnce = (): Promise<boolean> =>
    (linkedSettled ??= (async () => {
      const environment = await deliveryEnvironment();
      if ("error" in environment) return false;
      const settled = await (deps.settleLinked ?? settleLinked)(
        environment,
        deps.deliveryEnvironment ?? {},
      );
      if (settled.warning && !quiet) emitErr(`mate: ${settled.warning}`);
      return settled.recorded.length > 0;
    })());

  /** What `--refresh` found per change, kept for the result of a group it leaves held. */
  const refreshOutcomes = new Map<string, BranchOutcome[]>();
  /** Names why a group held as unmerged still waits: the lookups that need the user's answer. */
  const withOutcomes = (result: FinishResult): FinishResult => {
    const dependencies = result.dependencies?.map(withOutcomes);
    const next = dependencies ? { ...result, dependencies } : result;
    if (result.status !== "held" || result.reason !== "unmerged") return next;
    const seen = new Set<string>();
    const outcomes = (result.changes ?? [])
      .flatMap((change) => refreshOutcomes.get(change) ?? [])
      .filter((outcome) => {
        const key = `${outcome.repository}\n${outcome.branch}`;
        if (!outcome.needsAnswer || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (outcomes.length === 0) return next;
    const lines = outcomes.flatMap(renderOutcome);
    return {
      ...next,
      outcomes,
      message: `${result.message}\n${lines.join("\n")}\n  Answer with --confirm-merged, --confirm-open or --confirm-dropped.`,
    };
  };

  /** Records `--refresh` and, unless `refreshOnly`, `--confirm-*` into the changes in `dir`. */
  const settleWith =
    (refreshOnly: boolean) =>
    async (dir: string, changes: string[]): Promise<string | null> => {
      const environment = await deliveryEnvironment();
      if ("error" in environment) return environment.error;
      const answer = refreshOnly ? undefined : confirm;
      const record = (names: string[], edit: DeliveryEdit = {}, repository?: string) =>
        recordDelivery(
          { ...environment, companionPath: dir },
          {
            changes: names,
            repository,
            refresh: edit.confirm === undefined && refresh,
            refreshAll: true,
            edit,
            // The worktree's HEAD is the publication tip; a base set here would hide staleness.
            leaveSpecBase: true,
          },
          deps.deliveryEnvironment ?? {},
        );
      if (refresh) {
        const outcome = await record(changes);
        if ("refusal" in outcome) return deliveryRefusal(changes, outcome.refusal.reason);
        if ("results" in outcome) {
          for (const entry of outcome.results) refreshOutcomes.set(entry.change, entry.outcomes);
        }
      }
      if (!answer) return null;
      // The answer is for the Working Repository's delivery, else, as in the companion, for the
      // repository the group is named after; changes without that delivery keep theirs.
      const working = environment.workingRepo;
      const repositoryOf = async (change: string) =>
        working?.slug || working?.umbrellaChildren
          ? undefined
          : (await groupOfChange(dir, change, declaredType)).repository;
      let confirmed = 0;
      for (const change of changes) {
        // oxlint-disable-next-line no-await-in-loop -- one record at a time, in group order
        const outcome = await record([change], { confirm: answer }, await repositoryOf(change));
        if (!("refusal" in outcome)) confirmed += 1;
        else if (outcome.refusal.reason !== "no-delivery-branch") {
          return deliveryRefusal([change], outcome.refusal.reason);
        }
      }
      return confirmed > 0 ? null : deliveryRefusal(changes, "no-delivery-branch");
    };

  const hasRemote = !noPush && (await (deps.hasRemote ?? defaultHasRemote)(context.companionPath));

  /** One capability sync per run, however many groups `--all` publishes. */
  let capSynced: Promise<boolean> | undefined;
  /** Set by the `--all` queue's fetch; the next publication reuses it instead of fetching again. */
  let refsFresh = false;
  const publishGroup = async (target: string, inQueue = false): Promise<FinishResult> => {
    capSynced ??= finisher.capSync ? finisher.capSync() : Promise.resolve(true);
    if (!(await capSynced)) {
      process.exitCode = 1;
      return refusalResult(type, target, "mate: cap sync failed; nothing was published.");
    }
    if (refresh && (await settleLinkedOnce())) refsFresh = false;
    const fresh = refsFresh;
    refsFresh = false;
    const publication = await (deps.publishSubmitted ?? publishSubmitted)(
      context.companionPath,
      target,
      {
        ...(settling ? { settle: settleWith(false) } : {}),
        ...(refresh ? { settleDependency: settleWith(true) } : {}),
        ...(fresh ? { fresh } : {}),
        // `--all` publishes dependencies in queue order instead, and takes nobody's answer.
        ...(inQueue ? { withDependencies: false, ownAnswersOnly: true } : {}),
        scan: scanPublicationFn,
        ...typeDeps,
      },
    );
    const result = withOutcomes(publicationResult(type, target, publication));
    if (result.status === "conflict" || result.status === "error") process.exitCode = 1;
    return result;
  };

  /** Uncommitted archives of an earlier Mate, which publish from this checkout only. */
  const localPendingArchives = async (changed = git.changedPaths()) => {
    const paths = await changed;
    const changeKinds = (await git.changedPathKinds?.()) ?? {};
    return pendingArchives(await discoverArchives(context.companionPath, paths, changeKinds));
  };

  /**
   * Names of the checkout's pending archives, read once per run: publishing commits one but never
   * adds one.
   */
  let pendingArchiveNames: Promise<Set<string>> | undefined;

  /**
   * Publishes from this checkout what only it holds (an archive of an earlier Mate, an unpushed
   * earlier publication) and everything without a remote; otherwise the Delivery Group.
   */
  const usesCheckout = async (target: string): Promise<boolean> => {
    if (!hasRemote) return true;
    if (isDeliveryGroup(target)) return false;
    if (parseAnchor(target)) return true;
    pendingArchiveNames ??= localPendingArchives().then(
      (entries) => new Set(entries.map((entry) => entry.name)),
    );
    if ((await pendingArchiveNames).has(target)) return true;
    return (deps.unpushedPublication ?? unpushedPublication)(context.companionPath, target);
  };

  /** Never prints: the caller does, once cleanup has attached `worktrees`. */
  const runChange = async (target: string): Promise<FinishResult> => {
    if (!hasRemote && isDeliveryGroup(target)) {
      process.exitCode = 1;
      return refusalResult(
        type,
        target,
        `mate: ${target} is a Delivery Group, which publishes to the companion remote; ${noPush ? "drop --no-push" : "the companion has no remote"}.`,
      );
    }
    if (!(await usesCheckout(target))) return await publishGroup(target);
    if (!settling) {
      return runFinishEngine(
        finisher,
        { name: target, noPush },
        { ...engineDeps, printResult: false },
      );
    }
    process.exitCode = 1;
    return refusalResult(
      type,
      target,
      `mate: ${target} is not submitted, so --refresh or --confirm-* has nothing to record on; record with \`mate artifact link\`, then publish again.`,
    );
  };

  /**
   * Cleans up the Worksets these change results made Done and attaches each outcome to the
   * result that completed it. Runs after every status and exit code is final; never throws.
   */
  const cleanUpWorktrees = async (changeResults: readonly FinishResult[]): Promise<void> => {
    const all = flattened(changeResults);
    const outcomes = await cleanUpCompletedWorksets(
      context.companionPath,
      all.flatMap((result) =>
        publishedBy(result).map((anchor) => ({
          anchor,
          ...(result.commit ? { commit: result.commit } : {}),
        })),
      ),
      deps.worktreeCleanup,
    );
    for (const result of all) {
      const outcome = publishedBy(result)
        .map((anchor) => outcomes.get(anchor))
        .find((found) => found !== undefined);
      if (outcome) result.worktrees = outcome;
    }
  };

  const printWorktrees = (changeResults: readonly FinishResult[]): void => {
    if (json) return;
    for (const { worktrees } of flattened(changeResults)) {
      for (const entry of worktrees?.removed ?? []) emitErr(`mate: removed worktree ${entry.path}`);
      for (const entry of worktrees?.kept ?? []) {
        emitErr(`mate: kept worktree ${entry.path} (${entry.reason})`);
      }
      for (const warning of worktrees?.warnings ?? []) emitErr(`warning: ${warning}`);
    }
  };

  const runSpecs = async (requested: string[]): Promise<FinishResult | null> => {
    const drift = await resolveDriftedSpecs(context.companionPath, git, requested);
    if (!drift.ok) {
      if (!quiet && !json) emitErr(drift.message);
      process.exitCode = 1;
      return refusalResult(type, "--specs", drift.message);
    }
    if (drift.paths.length === 0) return null;
    const makeSpecsFinisher = deps.specsFinisher ?? openspecSpecsFinisher;
    const specsFinisher = makeSpecsFinisher(finishContext, drift.paths, now);
    return runFinishEngine(specsFinisher, { name: "--specs", noPush }, engineDeps);
  };

  if (allMode) {
    const results: FinishResult[] = [];
    const changeResults: FinishResult[] = [];
    let blocked = false;
    const stop = async (): Promise<void> => {
      // Worksets completed before the halt are still cleaned up.
      await cleanUpWorktrees(changeResults);
      printWorktrees(changeResults);
      if (json) emitOut(JSON.stringify(results));
    };

    if (hasRemote) {
      const queue = await (deps.publicationQueue ?? publicationQueue)(
        context.companionPath,
        typeDeps,
      );
      // A queue read from stale refs: the first publication fetches for itself.
      refsFresh = queue.fresh;
      for (const group of queue.groups) {
        // oxlint-disable-next-line no-await-in-loop -- publications push one after another
        const result = await publishGroup(group, true);
        if (!quiet) printFinishResult(result, { json, stdout: emitOut, stderr: emitErr });
        results.push(result);
        // A group waiting on a merge, a dependency or a publisher does not stop the others.
        if (result.status === "held" || result.status === "awaiting-publisher") continue;
        changeResults.push(result);
        // A group publication never touches the checkout, so its conflict blocks only that group.
        if (result.status === "conflict") {
          blocked = true;
          continue;
        }
        if (halted(result)) {
          // oxlint-disable-next-line no-await-in-loop -- ends the loop
          await stop();
          return;
        }
      }
      refsFresh = false;
    }

    const changed = git.changedPaths();
    for (const entry of await localPendingArchives(changed)) {
      // A held-back archive waits for its merge; it does not stop the merged ones.
      // Same cache as the finisher's resolve step, so both see one pending set and agree.
      // oxlint-disable-next-line no-await-in-loop -- one archive after another
      const hold = await publicationHold(
        context.companionPath,
        entry.anchor,
        () => changed,
        finishContext.holdCache,
      );
      if (hold) {
        if (!quiet) emitErr(hold);
        results.push(nothingToPublish(entry.anchor, hold));
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- one archive after another
      const result = await runFinishEngine(
        finisher,
        { name: entry.anchor, noPush },
        { ...engineDeps, printResult: true },
      );
      results.push(result);
      changeResults.push(result);
      if (halted(result)) {
        // oxlint-disable-next-line no-await-in-loop -- ends the loop
        await stop();
        return;
      }
    }

    /** Drift is recomputed: a spec a change just committed is no longer drifted. */
    const specResult = await runSpecs([]);
    if (specResult) results.push(specResult);
    if (blocked) process.exitCode = 1;

    await cleanUpWorktrees(changeResults);
    printWorktrees(changeResults);
    if (json) emitOut(JSON.stringify(results));
    else if (results.length === 0) emitOut("Nothing to publish.");
    return;
  }

  if (specsMode) {
    const result = await runSpecs(specPaths);
    const emitted =
      result ?? nothingToPublish("--specs", "No drifted canonical specs; nothing to publish.");
    if (json) {
      if (result === null) emitOut(JSON.stringify(emitted));
    } else if (result === null) {
      emitOut(emitted.message);
    }
    return;
  }

  // Printed here, after cleanup, so `--json` stays one object that carries `worktrees`.
  const result = await runChange(positionals[0]);
  await cleanUpWorktrees([result]);
  printFinishResult(result, { json, stdout: emitOut, stderr: emitErr });
  printWorktrees([result]);
}
