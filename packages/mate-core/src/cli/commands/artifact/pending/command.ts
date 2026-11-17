import path from "node:path";

import { readDeliveryState, type DeliveryState } from "../../../../lib/delivery/record";
import {
  discoverSubmitted,
  type DiscoverSubmittedOptions,
  type MergeClaim,
  type SubmittedChangeView,
  type SubmittedDiscovery,
} from "../../../../lib/delivery/staging/pending";
import { hasOpenspecCapability } from "../../../../lib/orchestrator/capabilities";
import { resolveForCapability } from "../../../../lib/orchestrator/framework-context";
import type { LaunchContext } from "../../../../lib/orchestrator/framework-context";
import type { CapabilityConfig } from "../../../../lib/orchestrator/types";
import { WorkingRepoRequiredError } from "../../../../lib/orchestrator/types";
import { errorMessage } from "../../../../runtime/error-message";
import { inboxText } from "../../../../runtime/pending-records";
import { type BooleanFlagSet, parseFlags } from "../../../parse-flags";
import { ensureUnambiguousCompanion } from "../../shared/companion-selection";
import { defaultGitOps, type GitOps, type WorkingTreeChange } from "../finish/git";
import {
  discoverArchives,
  pendingArchives,
  unattributedSpecs,
  type ArchiveEntry,
  type UnattributedSpec,
} from "./discovery";

export interface PendingCommandDeps {
  ensureUnambiguousCompanion?: (cwd: string) => Promise<boolean>;
  resolveContext?: (cwd: string) => Promise<LaunchContext>;
  loadCapabilities?: (context: LaunchContext) => Promise<CapabilityConfig[]>;
  git?: (companionPath: string, workingRepoPath?: string) => GitOps;
  discover?: (
    companionPath: string,
    uncommittedPaths: string[],
    changeKinds?: Readonly<Record<string, WorkingTreeChange>>,
  ) => Promise<ArchiveEntry[]>;
  /** Submitted changes on the pending branch; fetched first in Git mode `auto`. */
  discoverSubmitted?: (
    companionPath: string,
    options: DiscoverSubmittedOptions,
  ) => Promise<SubmittedDiscovery>;
  /** True when the companion's Git mode is `auto`. */
  loadGitAutoMode?: (context: LaunchContext) => Promise<boolean>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** Presence-only flags; every other `--flag` consumes the following token as its value. */
const BOOLEAN_FLAGS: BooleanFlagSet = new Set(["json"]);

/**
 * Whether `mate artifact publish --all` would publish this entry. Discovery does not know
 * about publication modes, so the marking is applied here rather than in the entry types.
 */
export interface AllCoverage {
  coveredByAll: boolean;
}

/**
 * The archive's Delivery Record and its settlement; held back unless `isPublishable`.
 * `error` names an unreadable record.
 */
export interface PendingDelivery {
  delivery: DeliveryState;
}

/** Machine-readable result emitted with `--json`. */
export interface PendingResult {
  type: string;
  companionPath: string;
  /** Local archives of an earlier Mate, publishable from this checkout only. */
  count: number;
  pending: Array<ArchiveEntry & AllCoverage & PendingDelivery>;
  /** Submitted changes on the pending branch by Delivery Group. */
  submitted: SubmittedDiscovery;
  /** Uncommitted canonical specs no pending change accounts for, each with its attribution. */
  unattributedSpecs: Array<UnattributedSpec & AllCoverage>;
}

/**
 * `--all` publishes every pending change and then every remaining drifted spec, so both
 * reported sets are covered in full — an unattributed spec included, whatever its
 * attribution, because a spec publication needs no archive to carry it.
 */
function markCoveredByAll<T>(entries: T[]): Array<T & AllCoverage> {
  return entries.map((entry) => ({ ...entry, coveredByAll: true }));
}

async function defaultLoadGitAutoMode(context: LaunchContext): Promise<boolean> {
  return (await context.configStore.load()).git === "auto";
}

async function defaultLoadCapabilities(context: LaunchContext): Promise<CapabilityConfig[]> {
  const config = await context.configStore.load();
  return config.capabilities ?? [];
}

/** Attribution is printed as candidate archives, never as a claim about which one is responsible. */
function renderUnattributed(specs: Array<UnattributedSpec & AllCoverage>): string[] {
  if (specs.length === 0) return [];
  return [
    "",
    `${specs.length} uncommitted spec${specs.length === 1 ? "" : "s"} not accounted for by a pending change:`,
    ...specs.flatMap((spec) => [
      `  ${spec.path}  [${spec.kind}]${spec.coveredByAll ? "  [--all]" : ""}`,
      ...(spec.touchedByArchives.length === 0
        ? ["       no archive names this spec"]
        : spec.touchedByArchives.map(
            (archive) => `       publishes via ${archive.anchor}  (archive ${archive.state})`,
          )),
    ]),
  ];
}

async function withDelivery<T extends ArchiveEntry>(
  companionPath: string,
  entries: T[],
): Promise<Array<T & PendingDelivery>> {
  return Promise.all(
    entries.map(async (entry) => {
      const delivery = await readDeliveryState(path.join(companionPath, entry.path));
      return { ...entry, delivery };
    }),
  );
}

/** A damaged record is shown with its error, so it is fixed rather than re-linked over. */
function renderDeliveryStatus(delivery: DeliveryState): string {
  return delivery.error === undefined
    ? delivery.status
    : `unreadable (${inboxText(delivery.error)})`;
}

/** `yours`, else the submitter's name when Git knows it. */
function renderOrigin(change: SubmittedChangeView): string {
  if (change.origin === "yours") return "yours";
  return change.author ? inboxText(change.author) : "others";
}

/** Whose claim a merge result is: the record is a teammate's push, so it is named, not trusted. */
function renderClaim(claim: MergeClaim): string {
  const who = claim.recordedBy ? inboxText(claim.recordedBy) : "someone else";
  return claim.source === "git"
    ? `found by Git on ${who}'s machine`
    : `answered by ${who}, not checked by Git`;
}

function renderSubmitted(submitted: SubmittedDiscovery): string[] {
  const fetched = submitted.fetchedAt ? `fetched ${submitted.fetchedAt}` : "never fetched";
  const freshness = submitted.stale
    ? `last known state, ${fetched}${submitted.error ? `: ${submitted.error}` : ""}`
    : fetched;
  if (submitted.groups.length === 0) {
    return submitted.error ? [`No submitted changes known (${freshness}).`, ""] : [];
  }
  const count = submitted.groups.reduce((sum, group) => sum + group.changes.length, 0);
  return [
    `${count} submitted change${count === 1 ? "" : "s"} on ${submitted.pendingBranch} by Delivery Group (${freshness}):`,
    ...submitted.groups.flatMap((group) => [
      `  ${inboxText(group.group)}${group.publishable ? "  publishable" : ""}${group.blocked ? "  blocked" : ""}`,
      ...(group.heldBy.length > 0
        ? [`       held by unpublished ${group.heldBy.map(inboxText).join(", ")}`]
        : []),
      ...group.changes.flatMap((change) => [
        `       ${inboxText(change.name)}  delivery: ${renderDeliveryStatus(change.delivery)}  (${renderOrigin(change)})`,
        ...change.touches.map(
          (part) =>
            `         touches ${inboxText(part.capability)} › ${inboxText(part.requirement)}`,
        ),
        ...change.merges
          .filter((claim) => !claim.yours)
          .map(
            (claim) =>
              `         ${claim.state} in ${inboxText(claim.repository)}: ${renderClaim(claim)}`,
          ),
        ...(change.blocked
          ? [
              `         blocked: ${inboxText(change.blocked.reason)} (since ${inboxText(change.blocked.since)})`,
            ]
          : []),
      ]),
    ]),
    "",
  ];
}

function renderHuman(result: PendingResult): string[] {
  const pending =
    result.count === 0
      ? ["No archived changes have uncommitted content."]
      : [
          `${result.count} archived change${result.count === 1 ? "" : "s"} from an earlier Mate pending publication, from this checkout only:`,
          ...result.pending.flatMap((entry, index) => [
            `  ${index + 1}. ${entry.name}  ${entry.path}${entry.coveredByAll ? "  [--all]" : ""}  delivery: ${renderDeliveryStatus(entry.delivery)}`,
            ...entry.uncommittedPaths.map((uncommitted) => `       ${uncommitted}`),
            ...entry.uncommittedSpecs.map((spec) => `       ${spec}`),
          ]),
        ];
  return [
    ...renderSubmitted(result.submitted),
    ...pending,
    ...renderUnattributed(result.unattributedSpecs),
  ];
}

/**
 * @command mate artifact pending
 * @description Lists what awaits publication. `submitted` holds the submitted changes on the
 * companion's pending branch, the inbox `mate/inbox`, by Delivery Group, each with its delivery,
 * `blocked` entry, origin (`yours` when committed with your Git email or submitted from this
 * checkout, else `others`), `author` (the submitter's name, from the pending branch's history),
 * `touches` (the capability and requirement it rewrites or removes) and `path`, its folder on
 * the pending branch: `git show <submitted.ref>:<path>/<file>` reads a file of it. Each group
 * carries `publishable`, `blocked` and `heldBy` (unpublished dependencies whose group cannot
 * publish). In Git mode `auto` the default and pending branches are fetched first; otherwise, or
 * when the fetch fails, the last fetched state is reported as `stale`. Separately, `pending` lists archives an earlier Mate left uncommitted, publishable
 * from this checkout only: archived OpenSpec changes whose own files — the archive directory or
 * the active directory archiving deleted — are still uncommitted in the companion working
 * tree, each with the uncommitted canonical specs it applied to, so the publication
 * workflow can offer exact selectable entries instead of parsing OpenSpec prose.
 * Uncommitted specs no pending change accounts for are reported separately, each with the
 * archives whose delta specs name it. Every reported entry carries `coveredByAll`, marking
 * what `mate artifact publish --all` would publish. Read-only:
 * nothing is validated, produced, committed, or pushed.
 * @flags
 * - `--json` — emit a machine-readable {@link PendingResult} instead of human-readable text.
 * @remarks No-ops (with a message on stderr) when the openspec capability is disabled for
 * this repo. Exits non-zero only when the companion, launch context, or Git guard rejects.
 */
export async function runArtifactPendingCommand(
  argv: string[],
  deps: PendingCommandDeps = {},
): Promise<void> {
  const emitOut = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emitErr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const json = parseFlags(argv, BOOLEAN_FLAGS).json === true;

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
  if (!hasOpenspecCapability(await loadCapabilities(context))) {
    emitErr("mate: the openspec capability must be enabled to list pending artifacts.");
    return;
  }

  let git: GitOps;
  try {
    git = (deps.git ?? defaultGitOps)(
      context.companionPath,
      context.repository?.path ?? process.env.MATE_REPO_PATH,
    );
  } catch (err) {
    emitErr(`mate: pending Git guard rejected the target: ${String(err)}`);
    process.exitCode = 1;
    return;
  }

  const discover = deps.discover ?? discoverArchives;
  const changed = await git.changedPaths();
  const changeKinds = (await git.changedPathKinds?.()) ?? {};
  const archives = await discover(context.companionPath, changed, changeKinds);
  const pending = pendingArchives(archives);
  const gitAutoMode = await (deps.loadGitAutoMode ?? defaultLoadGitAutoMode)(context).catch(
    () => false,
  );
  // The local listing stands on its own; a failed discovery is reported, not fatal.
  const submitted = await (deps.discoverSubmitted ?? discoverSubmitted)(context.companionPath, {
    fetch: gitAutoMode,
  }).catch((error: unknown): SubmittedDiscovery => ({
    pendingBranch: null,
    fetchedAt: null,
    stale: true,
    error: errorMessage(error),
    groups: [],
  }));
  const result: PendingResult = {
    type: "openspec",
    companionPath: context.companionPath,
    count: pending.length,
    pending: await withDelivery(context.companionPath, markCoveredByAll(pending)),
    submitted,
    unattributedSpecs: markCoveredByAll(
      await unattributedSpecs(context.companionPath, changed, archives, changeKinds),
    ),
  };

  if (json) emitOut(JSON.stringify(result));
  else for (const line of renderHuman(result)) emitOut(line);
}
