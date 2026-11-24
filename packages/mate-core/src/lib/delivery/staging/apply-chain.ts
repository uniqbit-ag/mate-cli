import { nulPaths, type CompanionGit } from "../../../runtime/companion-git";
import { inboxText } from "../../../runtime/pending-records";
import type { ArtifactType, ValidationFailure } from "./artifact-type";
import { sourcePathOf } from "./pending";
import type { DeltaFailure } from "./replay";

/** A change to apply, with the commit its delta was written against (null: unknown). */
export interface ChainMember {
  name: string;
  base: string | null;
}

/** Why a chain cannot be applied, with the change that failed when known. */
export type ChainFailure =
  | { kind: "stale"; change: string; failure: DeltaFailure }
  | { kind: "apply"; change: string; failure?: DeltaFailure; detail: string }
  | { kind: "invalid"; change: string | null; failure: ValidationFailure };

export interface AppliedChain {
  /** The record each change became, in order. */
  records: string[];
  /** Files the chain changed against `start`, removals left out. */
  changed: string[];
}

export interface ApplyChainOptions {
  type: ArtifactType;
  /** Git in the checkout `dir`. */
  work: CompanionGit;
  dir: string;
  /** In order; each source folder is in `dir` and in `ref`. */
  members: readonly ChainMember[];
  /** A commit holding the members' folders, which the stale check reads. */
  ref: string;
  /** The default tip the chain starts from; only what others changed since a base is stale. */
  start: string;
}

async function tree(work: CompanionGit): Promise<string> {
  // Forced, as submit adds: an archived file the publisher's ignore rules match must not drop out.
  await work.run(["add", "-f", "-A"]);
  return (await work.run(["write-tree"])).stdout.trim();
}

async function changedBetween(work: CompanionGit, from: string, to: string): Promise<string[]> {
  const diff = await work.run([
    "diff-tree",
    "-r",
    "-z",
    "--name-only",
    "--no-renames",
    "--diff-filter=d",
    from,
    to,
  ]);
  return nulPaths(diff.stdout);
}

/**
 * Applies `members` in order in the checkout `dir`, as publication and the projection do: each
 * change's stale check against its base, then its type's `apply`; then the type validates the
 * changed files. A group's earlier changes never make a later one stale. Leaves the result in
 * the working tree and index, uncommitted.
 */
export async function applyChain(options: ApplyChainOptions): Promise<AppliedChain | ChainFailure> {
  const { type, work, dir, members, ref, start } = options;
  const startTree = (await work.run(["rev-parse", `${start}^{tree}`])).stdout.trim();
  let previous = startTree;
  const owners = new Map<string, string>();
  const records: string[] = [];
  for (const member of members) {
    // A part someone changed since goes to a human: applying would overwrite that change.
    const stale =
      member.base && type.stale
        ? // oxlint-disable-next-line no-await-in-loop -- each change applies on the one before
          await type.stale(work, ref, sourcePathOf(type, member.name), member.base, start)
        : null;
    if (stale) return { kind: "stale", change: member.name, failure: stale };
    // oxlint-disable-next-line no-await-in-loop -- same change
    const applied = await type.apply(dir, member.name);
    if (!applied.ok) {
      return {
        kind: "apply",
        change: member.name,
        detail: applied.detail,
        ...(applied.failure ? { failure: applied.failure } : {}),
      };
    }
    records.push(applied.record);
    // oxlint-disable-next-line no-await-in-loop -- same change
    const next = await tree(work);
    // oxlint-disable-next-line no-await-in-loop -- same change
    for (const file of await changedBetween(work, previous, next)) owners.set(file, member.name);
    previous = next;
  }
  const changed = await changedBetween(work, startTree, previous);
  const invalid = type.validate ? await type.validate(dir, changed) : null;
  if (invalid) {
    return { kind: "invalid", change: owners.get(invalid.path) ?? null, failure: invalid };
  }
  return { records, changed };
}

/** True for a {@link ChainFailure}. */
export function isChainFailure(result: AppliedChain | ChainFailure): result is ChainFailure {
  return "kind" in result;
}

/** Paths a failure concerns: the spec a delta names, or the invalid file. */
export function failurePaths(
  failure: ChainFailure,
  pathOf: (capability: string) => string,
): string[] {
  if (failure.kind === "invalid") return [failure.failure.path];
  return failure.failure ? [pathOf(failure.failure.capability)] : [];
}

/**
 * What a failure means, for messages and the recorded block. Names and details come from
 * teammates' specs, so each is printed as {@link inboxText}.
 */
export function describeFailure(failure: ChainFailure, defaultBranch: string): string {
  if (failure.kind === "invalid") {
    return `${inboxText(failure.failure.path)} is invalid once applied to ${defaultBranch} (${inboxText(failure.failure.detail)})`;
  }
  const change = inboxText(failure.change);
  if (failure.kind === "stale") {
    return `${change}: "${inboxText(failure.failure.requirement)}" in ${inboxText(failure.failure.capability)} changed on ${defaultBranch} since the delta was written`;
  }
  if (!failure.failure) {
    return `${change}: it no longer applies to ${defaultBranch} (${inboxText(failure.detail)})`;
  }
  const { capability, requirement, reason } = failure.failure;
  return `${change}: its ${inboxText(capability)} delta for "${inboxText(requirement)}" no longer applies to ${defaultBranch}${reason ? ` (${inboxText(reason)})` : ""}`;
}

/** `value` as one POSIX shell word: names come from teammates' specs. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** How to get past a failure. */
export function failureRemedy(failure: ChainFailure): string {
  const versions = failure.kind === "stale" ? failure.failure.versions : undefined;
  // A name that does not print as it is cannot be passed on a command line.
  const printable =
    failure.kind === "stale" &&
    [failure.change, failure.failure.capability, failure.failure.requirement].every(
      (name) => inboxText(name) === name,
    );
  if (
    failure.kind === "stale" &&
    printable &&
    versions &&
    versions.ours !== null &&
    versions.theirs !== null
  ) {
    return `Resolve it from any machine: write the requirement as it should read to a file, run \`mate artifact resolve ${shellQuote(failure.change)} --capability ${shellQuote(failure.failure.capability)} --requirement ${shellQuote(failure.failure.requirement)} --file <file>\` (one triple per requirement it reports unresolved), then publish again.`;
  }
  const change = failure.change === null ? "the change that changes it" : inboxText(failure.change);
  const keep =
    failure.kind === "stale" && failure.failure.overwrites === false && versions?.ours === null
      ? " To keep it as it is, submit it again unchanged: that accepts the conflict."
      : "";
  return `Fix the delta spec of ${change}, submit it again with \`mate artifact submit\`, then publish again.${keep}`;
}
