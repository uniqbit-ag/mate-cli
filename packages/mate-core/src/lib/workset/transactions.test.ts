import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  commitAll,
  git,
  type GitTeam,
  gitTeam,
  NOTES_TYPE,
  write,
  writeChange,
  writeNote,
} from "../../../../../test/workset-git";
import { readSubmittedFolders } from "../../runtime/companion-git-state";
import { readWorkInventory } from "./inventory";
import { confirmShare, previewShare, readTeamBacklog, refreshTeam } from "./sharing";
import { updateClaim } from "./transactions";

let team: GitTeam;
let author: string;
let alice: string;
let bob: string;
const ALICE = { id: "alice@acme.test", label: "Acme Alice" };
const BOB = { id: "bob@acme.test", label: "Acme Bob" };
const INBOX = "mate/inbox";

/** Pushes the author's checkout to the inbox, as a share outside Studio would. */
function pushInbox(): void {
  git(author, "push", "-q", "origin", `HEAD:refs/heads/${INBOX}`);
}

beforeEach(async () => {
  team = await gitTeam();
  author = team.clone("author");
  writeChange(author, "acme-api");
  writeChange(author, "acme-ui", { dependsOn: ["acme-api"] });
  commitAll(author, "propose");
  pushInbox();
  alice = team.clone("alice");
  bob = team.clone("bob");
});

afterEach(() => team.cleanup());

const members = ["acme-api", "acme-ui"];
const ownerFile = (change: string) =>
  git(team.remote, "show", `${INBOX}:openspec/changes/${change}/owner.yaml`);
const remoteFiles = () => git(team.remote, "ls-tree", "-r", "--name-only", INBOX).split("\n");

describe("claims", () => {
  test("Claim writes owner.yaml into every member in one commit on the inbox", async () => {
    const head = git(alice, "rev-parse", "HEAD");
    const outcome = await updateClaim(alice, {
      action: "claim",
      members,
      operator: ALICE,
      transactionId: "tx-alice",
      workset: "acme-api",
    });
    expect(outcome).toMatchObject({ status: "accepted", needsTake: members });
    expect(ownerFile("acme-api")).toContain("alice@acme.test");
    expect(ownerFile("acme-ui")).toContain("Acme Alice");
    expect(git(team.remote, "log", "-1", "--name-only", "--format=%s", INBOX).split("\n")).toEqual([
      "chore(openspec): claim acme-api",
      "",
      "openspec/changes/acme-api/owner.yaml",
      "openspec/changes/acme-ui/owner.yaml",
    ]);
    expect(git(alice, "rev-parse", "HEAD")).toBe(head);
    expect(git(alice, "status", "--porcelain")).toBe("");
  });

  test("two checkouts claiming from the same revision: exactly one wins", async () => {
    const [first, second] = await Promise.all([
      updateClaim(alice, { action: "claim", members, operator: ALICE, transactionId: "tx-a" }),
      updateClaim(bob, { action: "claim", members, operator: BOB, transactionId: "tx-b" }),
    ]);
    const statuses = [first.status, second.status].toSorted();
    expect(statuses[0]).toBe("accepted");
    expect(["refused", "stale"]).toContain(statuses[1]);
    const winner = first.status === "accepted" ? ALICE : BOB;
    const loser = winner === ALICE ? bob : alice;
    const again = await updateClaim(loser, {
      action: "claim",
      members,
      operator: winner === ALICE ? BOB : ALICE,
      transactionId: "tx-again",
    });
    expect(again).toMatchObject({ status: "refused", reason: `claimed by ${winner.label}` });
  });

  test("a claim bound to other members is stale; work in progress is not claimable", async () => {
    expect(
      await updateClaim(alice, {
        action: "claim",
        members: ["acme-api"],
        operator: ALICE,
        transactionId: "tx-x",
      }),
    ).toMatchObject({ status: "stale" });
    write(
      author,
      "openspec/changes/acme-api/delivery.yaml",
      "version: 1\nchange: acme-api\ndeliveries:\n  - repository: acme/web\n    branch: workset/acme-api\n",
    );
    commitAll(author, "apply");
    pushInbox();
    expect(
      await updateClaim(alice, {
        action: "claim",
        members,
        operator: ALICE,
        transactionId: "tx-y",
      }),
    ).toMatchObject({ status: "refused", reason: "in progress on workset/acme-api" });
  });

  test("only the owner releases; release removes the files", async () => {
    await updateClaim(alice, { action: "claim", members, operator: ALICE, transactionId: "tx-a" });
    expect(
      await updateClaim(bob, { action: "release", members, operator: BOB, transactionId: "tx-b" }),
    ).toMatchObject({ status: "refused", kind: "access" });
    expect(
      await updateClaim(alice, {
        action: "release",
        members,
        operator: ALICE,
        transactionId: "tx-r",
      }),
    ).toMatchObject({ status: "accepted" });
    expect(remoteFiles().some((file) => file.endsWith("owner.yaml"))).toBe(false);
  });

  test("disagreeing owner files block claims", async () => {
    write(author, "openspec/changes/acme-api/owner.yaml", "owner: { id: x@acme.test, label: X }\n");
    commitAll(author, "hand edit");
    pushInbox();
    expect(
      await updateClaim(alice, { action: "claim", members, operator: ALICE, transactionId: "tx" }),
    ).toMatchObject({ status: "refused", reason: "only some of its changes are claimed" });
  });

  test("a submitted change is not claimable", async () => {
    write(
      author,
      "openspec/changes/acme-api/delivery.yaml",
      "version: 1\nchange: acme-api\nstate: submitted\ndeliveries: []\n",
    );
    commitAll(author, "submit");
    pushInbox();
    expect(
      await updateClaim(alice, { action: "claim", members, operator: ALICE, transactionId: "tx" }),
    ).toMatchObject({ status: "refused", reason: "it is submitted for publication" });
  });

  test("another artifact type is claimed in its own folders, named by its type", async () => {
    writeNote(author, "acme-note");
    commitAll(author, "note");
    pushInbox();
    const outcome = await updateClaim(
      alice,
      {
        action: "claim",
        members: ["acme-note"],
        operator: ALICE,
        transactionId: "tx-note",
        workset: "acme-note",
      },
      { artifactType: NOTES_TYPE },
    );
    expect(outcome).toMatchObject({ status: "accepted", needsTake: ["acme-note"] });
    expect(git(team.remote, "show", `${INBOX}:notes/acme-note/owner.yaml`)).toContain(ALICE.id);
    expect(git(team.remote, "log", "-1", "--format=%s", INBOX)).toBe(
      "chore(acme-notes): claim acme-note",
    );
  });

  test("a claimer who has the changes needs no take; its record follows the inbox", async () => {
    const sharer = team.clone("sharer");
    writeChange(sharer, "acme-solo");
    const inventory = await readWorkInventory(sharer);
    const entry = inventory.worksets.find((candidate) => candidate.id === "acme-solo")!;
    await refreshTeam(sharer);
    const preview = await previewShare(sharer, entry, await readTeamBacklog(sharer));
    if ("refusal" in preview) throw new Error(preview.refusal);
    await confirmShare(
      sharer,
      { hash: preview.preview.hash, transactionId: "tx-share" },
      { inventoryEntry: async () => entry },
    );
    const folder = "openspec/changes/acme-solo";
    const shared = readSubmittedFolders(sharer)[folder]!;
    const claimed = await updateClaim(sharer, {
      action: "claim",
      members: ["acme-solo"],
      operator: { id: "sharer@acme.test", label: "Acme sharer" },
      transactionId: "tx-claim",
    });
    expect(claimed).toMatchObject({ status: "accepted", needsTake: [] });
    const after = readSubmittedFolders(sharer)[folder]!;
    expect(after.content).not.toBe(shared.content);
    expect(after.shared).toBe(shared.shared);
  });
});
