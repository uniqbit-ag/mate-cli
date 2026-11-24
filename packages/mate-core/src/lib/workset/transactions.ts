import fs from "node:fs/promises";
import path from "node:path";

import type { ArtifactType } from "../delivery/staging/artifact-type";
import { commitToPending } from "../delivery/staging/pending-edit";
import { pendingPlace } from "../delivery/staging/refs";
import { defaultArtifactType } from "../delivery/staging/registry";
import {
  groupClaim,
  type GroupClaim,
  type Operator,
  OWNER_FILE,
  type OwnerRead,
  parseOwner,
  serializeOwner,
} from "./claims";
import type { GitFailure } from "./git-transaction";
import { type ChangeLinks, deriveGroups, readFolderLinks } from "./groups";
import {
  folderOf,
  pendingCommitDeps,
  pendingContent,
  pendingGit,
  recordPendingContent,
  stateOf,
  transactionFailure,
  withWorkLock,
  type WorkGitDeps,
} from "./sharing";

/**
 * Claim and Release: one commit on the inbox that adds or removes the owner file in every
 * active member of the Workset, through the pending-branch transaction. What the person
 * confirmed is verified in the transaction's worktree, so a rebuild after a rejected push
 * checks it again; a claim someone else won stops there.
 */

export type RefusalKind = "prerequisite" | "access" | "conflict";

export type ClaimOutcome =
  | {
      status: "accepted";
      commit: string;
      members: string[];
      /** Members this checkout lacks; `mate artifact take` brings them in. */
      needsTake: string[];
    }
  | { status: "refused"; kind: RefusalKind; reason: string }
  | { status: "stale"; reason: string }
  | { status: "failed"; failure: GitFailure };

export interface ClaimRequest {
  action: "claim" | "release";
  /** The members the person confirmed; another current membership makes it stale. */
  members: readonly string[];
  operator: Operator;
  transactionId: string;
  /** The Workset's id for the commit subject; the first member's name without it. */
  workset?: string;
}

function refused(kind: RefusalKind, reason: string): ClaimOutcome {
  return { status: "refused", kind, reason };
}

/** Whether both name the same members, in any order. */
export function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  const right = [...b].toSorted();
  return a.length === b.length && [...a].toSorted().every((name, i) => name === right[i]);
}

async function readOptional(file: string): Promise<string | null> {
  return fs.readFile(file, "utf8").catch(() => null);
}

interface InboxChange {
  links: ChangeLinks;
  owner: OwnerRead;
  submitted: boolean;
}

/** The change folders of the inbox checked out at `dir`, dropped ones left out. */
async function inboxChanges(dir: string, type: ArtifactType): Promise<Map<string, InboxChange>> {
  const root = path.join(dir, ...type.source.split("/"));
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const changes = new Map<string, InboxChange>();
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && folderOf(type, entry.name) !== type.archiveRoot)
      .map(async ({ name }) => {
        const folder = path.join(root, name);
        const [links, owner, delivery] = await Promise.all([
          readFolderLinks(folder, name),
          readOptional(path.join(folder, OWNER_FILE)),
          readOptional(path.join(folder, type.deliveryFile)),
        ]);
        const state = stateOf(delivery);
        if (state === "dropped") return;
        changes.set(name, { links, owner: parseOwner(owner), submitted: state === "submitted" });
      }),
  );
  return changes;
}

/** Claim needs an unclaimed group nobody builds; Release needs the owner. */
function ownerRefusal(
  request: ClaimRequest,
  claim: GroupClaim,
  branch: string | undefined,
): ClaimOutcome | null {
  const mine = claim.kind === "owned" && claim.owner.id === request.operator.id;
  if (request.action === "claim") {
    if (claim.kind === "owned") {
      return refused("conflict", mine ? "already yours" : `claimed by ${claim.owner.label}`);
    }
    return branch ? refused("conflict", `in progress on ${branch}`) : null;
  }
  return mine ? null : refused("access", "only its owner can release it");
}

async function presentLocally(companionPath: string, folder: string): Promise<boolean> {
  return fs
    .stat(path.join(companionPath, ...folder.split("/")))
    .then((stat) => stat.isDirectory())
    .catch(() => false);
}

/** Claims or releases a shared Workset. */
export async function updateClaim(
  companionPath: string,
  request: ClaimRequest,
  deps: WorkGitDeps = {},
): Promise<ClaimOutcome> {
  if (request.members.length === 0) return refused("prerequisite", "the Workset has no changes");
  const type = deps.artifactType ?? defaultArtifactType();
  const gitFor = deps.git ?? pendingGit;
  const contents = new Map<string, string>();
  let members: string[] = [];
  const result = await withWorkLock(companionPath, () =>
    commitToPending<ClaimOutcome>(
      {
        companionPath,
        subject: `chore(${type.name}): ${request.action} ${request.workset ?? request.members[0]}`,
        transaction: request.transactionId,
        edit: async (dir, remote) => {
          contents.clear();
          const inbox = await inboxChanges(dir, type);
          const first = request.members[0]!;
          if (inbox.get(first)?.submitted) {
            return { stop: refused("conflict", "it is submitted for publication") };
          }
          const active = [...inbox.values()].filter((change) => !change.submitted);
          const group = deriveGroups(active.map((change) => change.links)).find((candidate) =>
            candidate.members.includes(first),
          );
          if (!group) {
            return {
              stop: refused("prerequisite", `it is not on ${pendingPlace(remote)}; share it first`),
            };
          }
          if (!sameMembers(group.members, request.members)) {
            return {
              stop: {
                status: "stale",
                reason: `its changes are now ${group.members.join(", ")}; review it again`,
              },
            };
          }
          const claim = groupClaim(group.members.map((name) => inbox.get(name)!.owner));
          if (claim.kind === "conflict") return { stop: refused("conflict", claim.diagnostic) };
          const branch = group.members.flatMap((name) => inbox.get(name)!.links.branches).at(0);
          const refusal = ownerRefusal(request, claim, branch);
          if (refusal) return { stop: refusal };
          members = group.members;
          const work = gitFor(dir);
          const paths: string[] = [];
          for (const name of group.members) {
            const folder = folderOf(type, name);
            const file = path.join(dir, ...folder.split("/"), OWNER_FILE);
            if (request.action === "claim") {
              // oxlint-disable-next-line no-await-in-loop -- one small file per member
              await fs.writeFile(file, serializeOwner(request.operator), "utf8");
            } else {
              // oxlint-disable-next-line no-await-in-loop -- one small file per member
              await fs.rm(file, { force: true });
            }
            paths.push(`${folder}/${OWNER_FILE}`);
            // oxlint-disable-next-line no-await-in-loop -- same member
            const content = await pendingContent(dir, folder, type, work);
            if (content) contents.set(folder, content);
          }
          return paths;
        },
      },
      pendingCommitDeps(gitFor, type, deps),
    ),
  );
  switch (result.status) {
    // The lock's own refusal carries no kind.
    case "refused":
      return refused("conflict", result.reason);
    case "failed": {
      const failure = transactionFailure(result);
      return failure.status === "refused" ? refused("prerequisite", failure.reason) : failure;
    }
    case "stopped":
      return result.value ?? refused("conflict", `the ${request.action} was stopped`);
    case "unchanged":
      return refused("conflict", `nothing to ${request.action}`);
    case "pushed": {
      // Submit later compares the inbox folder with what this checkout recorded of it.
      recordPendingContent(companionPath, contents, deps.stateHome);
      const present = await Promise.all(
        members.map((name) => presentLocally(companionPath, folderOf(type, name))),
      );
      return {
        status: "accepted",
        commit: result.commit,
        members,
        needsTake: members.filter((_, index) => !present[index]),
      };
    }
  }
}
