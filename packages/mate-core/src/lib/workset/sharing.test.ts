import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

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
import { takeSubmitted } from "../delivery/staging/submit";
import { implicitRecord, readWorkInventory } from "./inventory";
import { createWorkset } from "./record";
import {
  changeFiles,
  compareWorkset,
  confirmShare,
  previewShare,
  readTeamBacklog,
  refreshTeam,
  remoteOnlyEntries,
  type ShareDeps,
} from "./sharing";

let team: GitTeam;
let author: string;
let teammate: string;

beforeEach(async () => {
  team = await gitTeam();
  author = team.clone("author");
  teammate = team.clone("teammate");
});

afterEach(() => team.cleanup());

const INBOX = "mate/inbox";

async function entryOf(companion: string, id: string) {
  const inventory = await readWorkInventory(companion);
  const entry = inventory.worksets.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`no ${id}`);
  return entry;
}

async function backlogOf(companion: string) {
  await refreshTeam(companion);
  return readTeamBacklog(companion);
}

async function previewOf(companion: string, id: string, include?: string[]) {
  const preview = await previewShare(
    companion,
    await entryOf(companion, id),
    await backlogOf(companion),
    { include },
  );
  if ("refusal" in preview) throw new Error(preview.refusal);
  return preview.preview;
}

async function confirm(
  companion: string,
  id: string,
  hash: string,
  extra: Partial<ShareDeps> & { include?: string[] } = {},
) {
  const { include, ...deps } = extra;
  return confirmShare(
    companion,
    { hash, include, transactionId: `tx-${id}-${Date.now()}` },
    { inventoryEntry: () => entryOf(companion, id), ...deps },
  );
}

async function share(companion: string, id: string, include?: string[]) {
  return confirm(companion, id, (await previewOf(companion, id, include)).hash, { include });
}

const remoteFiles = (rev = INBOX) =>
  git(team.remote, "ls-tree", "-r", "--name-only", rev).split("\n");

/** A proposal pushed to the inbox outside Studio. */
const pushChange = (companion: string, name: string, dependsOn?: string[]) => {
  writeChange(companion, name, dependsOn ? { dependsOn } : {});
  commitAll(companion, `propose ${name}`);
  git(companion, "push", "-q", "origin", `HEAD:refs/heads/${INBOX}`);
};

/** Edits `file` of the inbox directly, as a teammate's push would. */
function editOnInbox(companion: string, file: string, content: string): void {
  git(companion, "fetch", "-q", "origin", INBOX);
  git(companion, "checkout", "-q", "-B", "inbox-edit", "FETCH_HEAD");
  write(companion, file, content);
  commitAll(companion, `edit ${file}`);
  git(companion, "push", "-q", "origin", `HEAD:refs/heads/${INBOX}`);
  git(companion, "checkout", "-q", "main");
}

describe("team discovery", () => {
  test("an already pushed proposal is discovered without merging the checkout", async () => {
    pushChange(teammate, "acme-login");
    const head = git(author, "rev-parse", "HEAD");
    const backlog = await backlogOf(author);
    expect([...backlog.changes.keys()]).toEqual(["acme-login"]);
    expect(backlog.changes.get("acme-login")?.owner).toEqual({ status: "absent" });
    expect(backlog.changes.get("acme-login")?.state).toBe("active");
    expect(backlog.status.stale).toBe(false);
    expect(backlog.status.shared?.branch).toBe(INBOX);
    expect(backlog.status.fetchedAt).toBeString();
    expect(git(author, "rev-parse", "HEAD")).toBe(head);
    expect(fs.existsSync(path.join(author, "openspec/changes/acme-login"))).toBe(false);
    expect(remoteOnlyEntries(backlog, new Set()).map((entry) => entry.id)).toEqual(["acme-login"]);
  });

  test("a remote without an inbox has nothing shared and is not stale", async () => {
    const backlog = await backlogOf(author);
    expect(backlog.changes.size).toBe(0);
    expect(backlog.status.tip).toBeNull();
    expect(backlog.status.stale).toBe(false);
  });

  test("remote slices linked by dependsOn are one remote Workset", async () => {
    writeChange(teammate, "acme-api");
    writeChange(teammate, "acme-ui", { dependsOn: ["acme-api"] });
    commitAll(teammate, "propose");
    git(teammate, "push", "-q", "origin", `HEAD:refs/heads/${INBOX}`);
    const entries = remoteOnlyEntries(await backlogOf(author), new Set());
    expect(entries.map((entry) => [entry.id, entry.members.map((m) => m.name)])).toEqual([
      ["acme-api", ["acme-api", "acme-ui"]],
    ]);
  });

  test("submitted changes are marked; dropped ones are left out", async () => {
    writeChange(teammate, "acme-done");
    write(
      teammate,
      "openspec/changes/acme-done/delivery.yaml",
      "version: 1\nchange: acme-done\nstate: submitted\ndeliveries: []\n",
    );
    writeChange(teammate, "acme-gone");
    write(
      teammate,
      "openspec/changes/acme-gone/delivery.yaml",
      "version: 1\nchange: acme-gone\nstate: dropped\ndeliveries: []\n",
    );
    commitAll(teammate, "inbox");
    git(teammate, "push", "-q", "origin", `HEAD:refs/heads/${INBOX}`);
    const backlog = await backlogOf(author);
    expect([...backlog.changes].map(([name, change]) => [name, change.state])).toEqual([
      ["acme-done", "submitted"],
    ]);
  });

  test("a companion without a remote reports the prerequisite", async () => {
    git(author, "remote", "remove", "origin");
    const refreshed = await refreshTeam(author);
    expect("failure" in refreshed && refreshed.failure.kind).toBe("no-remote");
  });
});

describe("sharing", () => {
  test("only the selected Workset reaches the inbox; the checkout stays as it is", async () => {
    writeChange(author, "acme-unrelated");
    commitAll(author, "local only");
    writeChange(author, "acme-login");
    write(author, "notes.txt", "staged\n");
    git(author, "add", "notes.txt");
    write(author, "draft.txt", "untracked\n");
    const head = git(author, "rev-parse", "HEAD");
    const outcome = await share(author, "acme-login");
    expect(outcome.status).toBe("shared");

    const files = remoteFiles();
    expect(files).toContain("openspec/changes/acme-login/proposal.md");
    expect(files).toContain("openspec/changes/acme-login/delivery.yaml");
    expect(files.some((file) => file.includes("acme-unrelated"))).toBe(false);
    expect(files).not.toContain("notes.txt");
    expect(files.some((file) => file.endsWith("owner.yaml"))).toBe(false);
    expect(remoteFiles("main").some((file) => file.includes("acme-login"))).toBe(false);
    expect(git(team.remote, "log", "-1", "--format=%B", INBOX)).toContain("Mate-Transaction: tx-");
    expect(git(team.remote, "log", "-1", "--format=%s", INBOX)).toBe(
      "chore(openspec): share acme-login",
    );

    expect(git(author, "rev-parse", "HEAD")).toBe(head);
    expect(git(author, "diff", "--cached", "--name-only")).toBe("notes.txt");
    expect(git(author, "status", "--porcelain", "--untracked-files=all", "openspec")).toContain(
      "?? openspec/changes/acme-login/proposal.md",
    );
    const recorded = readSubmittedFolders(author)["openspec/changes/acme-login"];
    expect(recorded?.shared).toBeString();
    expect(recorded?.content).toBeString();
  });

  test("Scratchpad files are never shared", async () => {
    await createWorkset(author, {
      id: "acme-idea",
      title: "Acme idea",
      intent: "An idea",
      repository: "acme/web",
    });
    writeChange(author, "acme-login");
    await share(author, "acme-login");
    expect(remoteFiles().some((file) => file.startsWith(".mate/"))).toBe(false);
    expect(git(author, "status", "--porcelain", "--ignored", ".mate")).toContain("!! .mate/");
  });

  test("a change after the preview makes the confirmation stale", async () => {
    writeChange(author, "acme-login");
    const preview = await previewOf(author, "acme-login");
    write(author, "openspec/changes/acme-login/design.md", "# Changed\n");
    expect((await confirm(author, "acme-login", preview.hash)).status).toBe("stale");
  });

  test("an unrelated push landing first is rebuilt on and accepted", async () => {
    writeChange(author, "acme-login");
    const preview = await previewOf(author, "acme-login");
    pushChange(teammate, "acme-other");
    expect((await confirm(author, "acme-login", preview.hash)).status).toBe("shared");
    const files = remoteFiles();
    expect(files).toContain("openspec/changes/acme-login/proposal.md");
    expect(files).toContain("openspec/changes/acme-other/proposal.md");
  });

  test("a folder changed on the inbox since the preview is refused", async () => {
    writeChange(author, "acme-login");
    expect((await share(author, "acme-login")).status).toBe("shared");
    write(author, "openspec/changes/acme-login/design.md", "# Mine\n");
    const preview = await previewOf(author, "acme-login");
    editOnInbox(teammate, "openspec/changes/acme-login/tasks.md", "- [ ] 1.1 Theirs\n");
    const outcome = await confirm(author, "acme-login", preview.hash);
    expect(outcome.status).toBe("stale");
    expect(git(team.remote, "show", `${INBOX}:openspec/changes/acme-login/design.md`)).toBe(
      "# Design",
    );
  });

  test("a secret in a shared file refuses the share and pushes nothing", async () => {
    writeChange(author, "acme-login");
    const preview = await previewOf(author, "acme-login");
    const outcome = await confirm(author, "acme-login", preview.hash, {
      scan: async (_root, paths) => ({
        skipped: false,
        findings: [{ path: paths[0]!, line: 1, ruleId: "acme-token" }],
      }),
    } as Partial<ShareDeps>);
    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.reason).toContain("acme-token");
    expect(() => git(team.remote, "rev-parse", "--verify", "-q", INBOX)).toThrow();
  });

  test("an unshared external dependency must be included", async () => {
    writeChange(author, "acme-base");
    writeChange(author, "acme-login", { dependsOn: ["acme-base"] });
    // Separate Delivery Branches keep them apart, so acme-base is external to acme-login.
    write(
      author,
      "openspec/changes/acme-base/delivery.yaml",
      "version: 1\nchange: acme-base\ndeliveries:\n  - repository: acme/web\n    branch: workset/acme-base\n",
    );
    write(
      author,
      "openspec/changes/acme-login/delivery.yaml",
      "version: 1\nchange: acme-login\ndeliveries:\n  - repository: acme/web\n    branch: workset/acme-login\n",
    );
    expect((await previewOf(author, "acme-login")).externalDependencies).toEqual(["acme-base"]);
    expect((await share(author, "acme-login", ["acme-base"])).status).toBe("shared");
  });

  test("another artifact type is shared from its own folders, named by its type", async () => {
    writeNote(author, "acme-memo");
    const entry = {
      id: "acme-memo",
      implicit: true,
      record: implicitRecord("acme-memo", ["acme-memo"], []),
      members: [{ name: "acme-memo", kind: "active" as const }],
      diagnostics: [],
      actionable: true,
    };
    await refreshTeam(author);
    const backlog = await readTeamBacklog(author, undefined, NOTES_TYPE);
    const preview = await previewShare(author, entry, backlog, { artifactType: NOTES_TYPE });
    if ("refusal" in preview) throw new Error(preview.refusal);
    expect(preview.preview.problems).toEqual([]);
    const outcome = await confirmShare(
      author,
      { hash: preview.preview.hash, transactionId: "tx-memo" },
      { inventoryEntry: async () => entry, artifactType: NOTES_TYPE },
    );
    expect(outcome.status).toBe("shared");
    expect(remoteFiles()).toEqual(["notes/acme-memo/delivery.yaml", "notes/acme-memo/note.md"]);
    expect(git(team.remote, "log", "-1", "--format=%s", INBOX)).toBe(
      "chore(acme-notes): share acme-memo",
    );
    expect((await readTeamBacklog(author, undefined, NOTES_TYPE)).changes.has("acme-memo")).toBe(
      true,
    );
  });

  test("changeFiles refuses links and secrets and leaves the owner file to Claim", async () => {
    writeChange(author, "acme-login");
    write(author, "openspec/changes/acme-login/.env", "TOKEN=x\n");
    write(author, "openspec/changes/acme-login/owner.yaml", "owner: {}\n");
    fs.symlinkSync("/etc/hosts", path.join(author, "openspec/changes/acme-login/hosts.md"));
    const listed = await changeFiles(author, "acme-login");
    expect(listed.refusals.length).toBe(2);
    expect(listed.excluded.map((entry) => entry.path)).toEqual([
      "openspec/changes/acme-login/owner.yaml",
    ]);
  });
});

describe("sync state", () => {
  const compare = async (companion: string) =>
    compareWorkset(companion, await entryOf(companion, "acme-login"), await backlogOf(companion));

  test("in sync, ahead after a local edit, behind after a teammate's, diverged with both", async () => {
    writeChange(author, "acme-login");
    await share(author, "acme-login");
    expect((await compare(author)).sync).toBe("in-sync");

    write(author, "openspec/changes/acme-login/design.md", "# Mine\n");
    expect((await compare(author)).sync).toBe("ahead");
    write(author, "openspec/changes/acme-login/design.md", "# Design\n");

    expect((await takeSubmitted(teammate, "acme-login")).status).toBe("taken");
    write(teammate, "openspec/changes/acme-login/design.md", "# Theirs\n");
    expect((await share(teammate, "acme-login")).status).toBe("shared");
    expect((await compare(author)).sync).toBe("behind");

    write(author, "openspec/changes/acme-login/tasks.md", "- [ ] 1.1 Mine\n");
    expect((await compare(author)).sync).toBe("diverged");
  });

  test("a differing folder this checkout never pushed is diverged", async () => {
    pushChange(teammate, "acme-login");
    writeChange(author, "acme-login");
    write(author, "openspec/changes/acme-login/design.md", "# Mine\n");
    expect((await compare(author)).sync).toBe("diverged");
  });

  test("unshared work is local; members missing on the inbox are partial", async () => {
    writeChange(author, "acme-api");
    writeChange(author, "acme-ui", { dependsOn: ["acme-api"] });
    expect(
      (await compareWorkset(author, await entryOf(author, "acme-api"), await backlogOf(author)))
        .presence,
    ).toBe("local");
    pushChange(teammate, "acme-api");
    const facts = await compareWorkset(
      author,
      await entryOf(author, "acme-api"),
      await backlogOf(author),
    );
    expect(facts.presence).toBe("partial");
    expect(facts.missingMembers).toEqual(["acme-ui"]);
  });
});

describe("taking shared work", () => {
  test("take writes a shared change, catches up an unchanged copy and refuses an edited one", async () => {
    writeChange(author, "acme-login");
    await share(author, "acme-login");

    const head = git(teammate, "rev-parse", "HEAD");
    expect((await takeSubmitted(teammate, "acme-login")).status).toBe("taken");
    expect(fs.existsSync(path.join(teammate, "openspec/changes/acme-login/proposal.md"))).toBe(
      true,
    );
    expect(git(teammate, "rev-parse", "HEAD")).toBe(head);

    write(author, "openspec/changes/acme-login/design.md", "# Revised\n");
    await share(author, "acme-login");
    expect((await takeSubmitted(teammate, "acme-login")).status).toBe("taken");
    expect(
      fs.readFileSync(path.join(teammate, "openspec/changes/acme-login/design.md"), "utf8"),
    ).toBe("# Revised\n");

    write(teammate, "openspec/changes/acme-login/tasks.md", "- [ ] 1.1 Mine\n");
    const refused = await takeSubmitted(teammate, "acme-login");
    expect(refused).toMatchObject({ status: "refused", reason: "exists" });
  });
});
