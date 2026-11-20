import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { git, type GitTeam, gitTeam, write, writeChange } from "../../../../../test/workset-git";
import { takeSubmitted } from "../delivery/staging/submit";
import { companionExecutorGuard, findEntry, ownershipFacts, startRefusal } from "./execution";
import { configuredOperator, workGit } from "./git-transaction";
import { readWorkInventory } from "./inventory";
import { bucketOf, type WorkFacts } from "./projection";
import { createOutcome } from "./record";
import { confirmShare, previewShare, readTeamBacklog, refreshTeam } from "./sharing";
import { updateClaim } from "./transactions";

/**
 * Two engineers' checkouts of one companion. The normal flow writes nothing beyond the
 * changes and their Delivery Records; only Claim adds `owner.yaml`.
 */

let team: GitTeam;
let author: string;
let teammate: string;
const members = ["acme-login-api", "acme-login-ui"];

beforeEach(async () => {
  team = await gitTeam();
  author = team.clone("author", { name: "Acme Author", email: "author@acme.test" });
  teammate = team.clone("teammate", { name: "Acme Teammate", email: "mate@acme.test" });
});

afterEach(() => team.cleanup());

async function operatorOf(companion: string) {
  const operator = await configuredOperator(workGit(companion));
  if (!operator) throw new Error("no Git identity");
  return operator;
}

/** The bucket a companion's Work shows the Workset in. */
async function bucketIn(companion: string, id: string) {
  await refreshTeam(companion);
  const [inventory, backlog] = await Promise.all([
    readWorkInventory(companion),
    readTeamBacklog(companion),
  ]);
  const entry = findEntry(inventory, backlog, id);
  if (!entry) throw new Error(`no ${id}`);
  const ownership = await ownershipFacts(companion, entry, backlog, await operatorOf(companion));
  return { bucket: bucketOf({ inventory: entry, ...ownership } as WorkFacts), ownership };
}

/** Previews and confirms Share of Workset `id` from `companion`. */
async function share(companion: string, id: string, transactionId: string) {
  await refreshTeam(companion);
  const entry = (await readWorkInventory(companion)).worksets.find((w) => w.id === id)!;
  const preview = await previewShare(companion, entry, await readTeamBacklog(companion));
  if ("refusal" in preview) throw new Error(preview.refusal);
  return confirmShare(
    companion,
    { hash: preview.preview.hash, transactionId },
    { inventoryEntry: async () => entry },
  );
}

describe("shared executable work end to end", () => {
  test("a taken, claimed change shared again stays takeable while unchanged", async () => {
    const change = "acme-login-api";
    writeChange(author, change);
    expect((await share(author, change, "tx-author")).status).toBe("shared");
    const claimed = await updateClaim(teammate, {
      action: "claim",
      members: [change],
      operator: await operatorOf(teammate),
      transactionId: "tx-claim",
    });
    expect(claimed).toMatchObject({ status: "accepted", needsTake: [change] });
    expect((await takeSubmitted(teammate, change)).status).toBe("taken");
    // The taken folder holds the owner file, which Share leaves out.
    expect(fs.existsSync(path.join(teammate, "openspec/changes", change, "owner.yaml"))).toBe(true);

    write(teammate, `openspec/changes/${change}/tasks.md`, "- [ ] 1.1 Edited by the teammate\n");
    expect((await share(teammate, change, "tx-teammate")).status).toBe("shared");
    // Unchanged since that share: take catches up instead of refusing an edited copy.
    expect((await takeSubmitted(teammate, change)).status).toBe("taken");
  });

  test("propose, share, discover, race to claim, continue without the author, release", async () => {
    writeChange(author, "acme-login-api");
    writeChange(author, "acme-login-ui", { dependsOn: ["acme-login-api"] });
    const before = fs.readdirSync(path.join(author, "openspec/changes/acme-login-api")).toSorted();
    expect(before).not.toContain("owner.yaml");
    expect((await bucketIn(author, "acme-login-api")).bucket).toBe("local");

    // Not committed: Share pushes to the inbox and leaves the checkout as it is.
    const head = git(author, "rev-parse", "HEAD");
    await refreshTeam(author);
    const entry = (await readWorkInventory(author)).worksets.find(
      (w) => w.id === "acme-login-api",
    )!;
    expect(entry.members.map((member) => member.name)).toEqual(members);
    const preview = await previewShare(author, entry, await readTeamBacklog(author));
    if ("refusal" in preview) throw new Error(preview.refusal);
    const shared = await confirmShare(
      author,
      { hash: preview.preview.hash, transactionId: "tx-share" },
      { inventoryEntry: async () => entry },
    );
    expect(shared.status).toBe("shared");
    expect(git(author, "rev-parse", "HEAD")).toBe(head);
    // Shared without a claim: available, so the author sees it in Remote work too.
    expect((await bucketIn(author, "acme-login-api")).bucket).toBe("remote");
    expect((await bucketIn(teammate, "acme-login-api")).bucket).toBe("remote");
    expect(await startRefusal(teammate, "acme-login-api", { needsPlan: true })).toBe(
      "claim it first",
    );

    const [mine, theirs] = await Promise.all([
      updateClaim(teammate, {
        action: "claim",
        members,
        operator: await operatorOf(teammate),
        transactionId: "tx-mate",
      }),
      updateClaim(author, {
        action: "claim",
        members,
        operator: await operatorOf(author),
        transactionId: "tx-author",
      }),
    ]);
    expect([mine.status, theirs.status].filter((status) => status === "accepted")).toHaveLength(1);
    const winner = mine.status === "accepted" ? teammate : author;
    const loser = winner === teammate ? author : teammate;
    // Only the teammate's checkout lacks the shared changes; take brings them in.
    const accepted = mine.status === "accepted" ? mine : theirs;
    expect(accepted.status === "accepted" && accepted.needsTake).toEqual(
      winner === teammate ? members : [],
    );
    if (accepted.status === "accepted") {
      for (const change of accepted.needsTake) {
        // oxlint-disable-next-line no-await-in-loop -- one change at a time
        expect((await takeSubmitted(winner, change)).status).toBe("taken");
      }
    }
    expect((await bucketIn(winner, "acme-login-api")).bucket).toBe("local");
    expect(await startRefusal(winner, "acme-login-api", { needsPlan: true })).toBeNull();
    const other = await bucketIn(loser, "acme-login-api");
    expect(other.bucket).toBe("remote");
    expect(other.ownership.claim.kind).toBe("other");
    expect(await startRefusal(loser, "acme-login-api", { needsPlan: true })).toContain(
      "claimed by",
    );

    expect(
      await updateClaim(winner, {
        action: "release",
        members,
        operator: await operatorOf(winner),
        transactionId: "tx-release",
      }),
    ).toMatchObject({ status: "accepted" });
    const released = await bucketIn(loser, "acme-login-api");
    expect(released.ownership.claim.kind).toBe("none");
  });

  test("a Scratchpad idea never reaches Git and a pulled legacy start never runs", async () => {
    await createOutcome(author, { text: "Make onboarding easier.", start: true }, ["acme/web"]);
    // Nothing to commit: the scratchpad ignores itself.
    expect(git(author, "status", "--porcelain")).toBe("");
    expect(await companionExecutorGuard(author).authorized("make-onboarding-easier")).toBe(true);

    write(
      teammate,
      "worksets/acme-legacy.yaml",
      "id: acme-legacy\nrepositories: [acme/web]\nchanges: []\nqueuedAt: 2026-11-01T00:00:00.000Z\n",
    );
    expect(await companionExecutorGuard(teammate).authorized("acme-legacy")).toBe(false);
  });
});
