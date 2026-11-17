import {
  companionGit,
  describeGitFailure,
  type CompanionGit,
} from "../../../runtime/companion-git";
import { errorMessage } from "../../../runtime/error-message";
import { inboxText } from "../../../runtime/pending-records";
import type { PublicationSecretScan } from "../../../runtime/publication-secret-scan";
import type { SecretFinding } from "../../../runtime/secret-scan";
import { isCommitId, readDeliveryRecord, writeDeliveryRecord } from "../record";
import { sourceDir, type ArtifactType, type StalePart } from "./artifact-type";
import { deltaBase, staleParts, submittedAt, type SubmittedChange } from "./pending";
import { commitToPending, type PendingCommitFailure } from "./pending-edit";
import { defaultRef, pendingPlace, pendingRef, type StagingRemote } from "./refs";
import { defaultArtifactType } from "./registry";
import type { DeltaFailure } from "./replay";

/** Bound on one resolution, every fetch and push included. */
const RESOLVE_BUDGET_MS = 120_000;

/** One part of a change and the text it should read. */
export interface PartResolution {
  part: StalePart;
  text: string;
}

export interface ResolveResult {
  change: string;
  status: "resolved" | "unchanged" | "refused";
  group: string | null;
  /**
   * Other parts of the change that changed on the default branch since its delta was written
   * and were not resolved in the same call. The new delta base would hide them from
   * publication's stale check, so the resolution is refused until they are passed too.
   */
  unresolved?: StalePart[];
  secretFindings?: SecretFinding[];
  message: string;
}

export interface ResolveDeps {
  git?: (cwd: string) => CompanionGit;
  scan?: (root: string, paths: string[], policyPath: string) => Promise<PublicationSecretScan>;
  artifactType?: ArtifactType;
  newTransaction?: () => string;
  tmpRoot?: string;
}

const defaultGit = (cwd: string): CompanionGit =>
  companionGit(cwd, { prompt: "never", budgetMs: RESOLVE_BUDGET_MS });

interface Resolution {
  change: SubmittedChange;
  parts: PartResolution[];
  type: ArtifactType;
  remote: StagingRemote;
  gitFor: (cwd: string) => CompanionGit;
}

function refusal(change: string, group: string | null, message: string): ResolveResult {
  return { change, status: "refused", group, message };
}

const samePart = (a: StalePart, b: StalePart): boolean =>
  a.capability === b.capability && a.requirement === b.requirement;

const describeParts = (parts: readonly StalePart[]): string =>
  parts
    .map((entry) => `${inboxText(entry.capability)} "${inboxText(entry.requirement)}"`)
    .join(", ");

/**
 * The parts being resolved that changed between the default tip the change's block names and
 * `tip`: they were resolved against text that is gone, and the new base would hide that from
 * publication. Empty when the block names no tip, or one `tip` does not descend from.
 */
async function movedSinceReported(
  r: Resolution,
  work: CompanionGit,
  tip: string,
): Promise<DeltaFailure[]> {
  const seen = r.change.blocked?.tip;
  if (!seen || seen === tip || !isCommitId(tip)) return [];
  const held = await work.run(["merge-base", "--is-ancestor", seen, tip]);
  if (held.status !== 0) return [];
  const stale = await staleParts(r.type, work, "HEAD", r.change.path, seen, tip);
  return stale.filter((entry) => r.parts.some(({ part }) => samePart(entry, part)));
}

/**
 * Rewrites the parts in the pending checkout `dir`, records the fetched default tip as the delta
 * base and clears the block; returns the paths to commit. Refused while another
 * stale part of the change is not among them, as the new base would hide it from publication's
 * stale check, and when a part changed again on the default branch after the tip its block
 * names.
 */
async function resolveIn(dir: string, r: Resolution): Promise<string[] | ResolveResult> {
  const { change, type, remote, parts } = r;
  const { name, group } = change;
  const work = r.gitFor(dir);
  const tip = (
    await work.run(["rev-parse", "--verify", "-q", `${defaultRef(remote)}^{commit}`])
  ).stdout.trim();
  const moved = await movedSinceReported(r, work, tip);
  if (moved.length > 0) {
    return refusal(
      name,
      group,
      `mate: ${name} cannot be resolved: ${describeParts(moved)} changed again on ${remote.defaultBranch} since the conflict was reported. Publish ${group} again to see the current text, then resolve from that.`,
    );
  }
  const base = await deltaBase(work, defaultRef(remote), "HEAD", change, type);
  const stale = base ? await staleParts(type, work, "HEAD", change.path, base, tip) : [];
  for (const { part } of parts) {
    const own = stale.find((entry) => samePart(entry, part));
    if (own?.versions?.theirs === null) {
      return refusal(
        name,
        group,
        `mate: ${name} cannot be resolved: "${part.requirement}" was removed from ${part.capability} on ${remote.defaultBranch}. Fix the change's delta and submit it again.`,
      );
    }
    if (own?.versions?.ours === null) {
      return refusal(
        name,
        group,
        `mate: ${name} cannot be resolved: its delta removes or only renames "${part.requirement}". To keep that, submit the change again unchanged; else fix its delta and submit it again.`,
      );
    }
  }
  // What the delta does not overwrite needs no text: the new base accepts it as it is.
  const unresolved = stale
    .filter((entry) => entry.overwrites !== false)
    .filter((entry) => !parts.some(({ part }) => samePart(entry, part)))
    .map(({ capability, requirement }) => ({ capability, requirement }));
  if (unresolved.length > 0) {
    return {
      ...refusal(
        name,
        group,
        `mate: ${name} cannot be resolved in part: ${describeParts(unresolved)} also changed on ${remote.defaultBranch} since the delta was written. Resolve them in the same call.`,
      ),
      unresolved,
    };
  }
  const folder = sourceDir(dir, type, name);
  for (const { part, text } of parts) {
    // oxlint-disable-next-line no-await-in-loop -- each rewrite edits the same delta files
    const why = await type.resolve!(folder, part, text);
    if (why) return refusal(name, group, `mate: ${name} cannot be resolved: ${why}.`);
  }
  const record = await readDeliveryRecord(folder).catch(() => null);
  if (record && isCommitId(tip)) {
    delete record.blocked;
    await writeDeliveryRecord(folder, { ...record, specBase: tip });
  }
  return [change.path];
}

/**
 * Writes each part's text into submitted change `name`, from any machine: its folder on the
 * pending branch is rewritten through its type's `resolve`, its block cleared and its
 * `specBase` set to the fetched default tip, so the next publication applies the resolved
 * versions. Refused, naming them, while another part changed since the delta base that the
 * change would overwrite is not resolved in the same call; a part removed on the default branch, or one the delta removes or
 * renames, is refused too: the delta is fixed and submitted again. Pushed without force. Never
 * throws.
 */
export async function resolveSubmitted(
  companionPath: string,
  name: string,
  parts: readonly PartResolution[],
  deps: ResolveDeps = {},
): Promise<ResolveResult> {
  if (parts.length === 0) return refusal(name, null, "mate: nothing to resolve.");
  const type = deps.artifactType ?? defaultArtifactType();
  if (!type.resolve) {
    return refusal(name, null, `mate: ${type.name} changes cannot be resolved here.`);
  }
  const gitFor = deps.git ?? defaultGit;
  const git = gitFor(companionPath);
  // The change as last read, for messages after the edit.
  const seen: { change?: SubmittedChange } = {};
  try {
    const result = await commitToPending<ResolveResult>(
      {
        companionPath,
        subject: `chore(${type.name}): resolve ${name}`,
        edit: async (dir, remote) => {
          const change = (await submittedAt(git, pendingRef(remote), type, deps.tmpRoot)).find(
            (entry) => entry.name === name,
          );
          seen.change = change;
          if (!change) {
            const message = `mate: ${name} is not submitted on ${pendingPlace(remote)}.`;
            return { stop: refusal(name, null, message) };
          }
          const resolved = await resolveIn(dir, {
            change,
            parts: [...parts],
            type,
            remote,
            gitFor,
          });
          return Array.isArray(resolved) ? resolved : { stop: resolved };
        },
      },
      { ...deps, git: gitFor, artifactType: type },
    );
    const group = seen.change?.group ?? null;
    switch (result.status) {
      case "stopped":
        return result.value!;
      case "unchanged":
        return {
          change: name,
          status: "unchanged",
          group,
          message: `${name} already reads that way; publish ${group} again.`,
        };
      case "pushed":
        return {
          change: name,
          status: "resolved",
          group,
          message: `Resolved ${describeParts(parts.map(({ part }) => part))} in ${name} on ${pendingPlace(result.remote)}; publish ${group} again.`,
        };
      case "failed":
        return refused(name, group, result);
    }
  } catch (error) {
    return refusal(name, null, `mate: resolving ${name} failed. ${errorMessage(error)}`);
  }
}

/** A failed pending-branch commit of `name`, in resolve's words. */
function refused(name: string, group: string | null, failure: PendingCommitFailure): ResolveResult {
  switch (failure.reason) {
    case "no-remote":
      return refusal(name, null, "mate: the companion has no upstream.");
    case "fetch-failed":
      return refusal(name, null, `mate: ${failure.detail}`);
    case "secret":
      return {
        ...refusal(name, group, `mate: refusing to resolve ${name}: the text contains secrets.`),
        secretFindings: failure.secretFindings,
      };
    case "commit-failed":
      return refusal(
        name,
        group,
        `mate: committing ${name} failed. ${describeGitFailure(failure.git)}`,
      );
    case "conflict":
      return refusal(
        name,
        null,
        `mate: ${pendingPlace(failure.remote)} kept moving while resolving ${name}. ${describeGitFailure(failure.git)}`,
      );
    case "not-permitted":
    case "push-failed":
      return refusal(name, group, `mate: pushing failed. ${describeGitFailure(failure.git)}`);
  }
}
