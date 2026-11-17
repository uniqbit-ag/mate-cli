import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { git } from "../../test/git-checkouts";
import { seedPending } from "../../test/pending-inbox";
import { updateSubmittedFolders } from "./companion-git-state";
import {
  matchingArchive,
  pendingSubmittedChanges,
  pendingSubmittedCounts,
  pendingSubmittedLine,
  trackingRefs,
} from "./pending-records";
import { OPENSPEC_LAYOUT } from "./submitted-arrivals";
import { defaultArtifactType } from "../lib/delivery/staging/registry";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-pending-records-")));
  roots.push(root);
  return root;
}

const companionPath = (root: string): string => path.join(root, "acme-companion");

describe("pendingSubmittedCounts", () => {
  test("counts submitted changes on the fetched inbox, not active ones", async () => {
    const companion = seedPending(companionPath(tempRoot()), [
      { name: "acme-login", branch: "workset/acme-login" },
      { name: "acme-login-ui", branch: "workset/acme-login" },
      { name: "acme-draft", state: "active" },
    ]);

    expect(await pendingSubmittedCounts(companion)).toEqual({ submitted: 2, mine: 0, blocked: 0 });
  });

  test("leaves out an inbox folder whose name is not safe in a shell command", async () => {
    const companion = seedPending(companionPath(tempRoot()), [
      { name: "acme-login", branch: "workset/acme-login" },
      { name: "acme$(id)" },
      { name: "acme login" },
      { name: "-acme" },
    ]);

    expect((await pendingSubmittedChanges(companion)).map((change) => change.name)).toEqual([
      "acme-login",
    ]);
  });

  test("reads the inbox whatever branch the checkout tracks", async () => {
    const companion = seedPending(companionPath(tempRoot()), [{ name: "acme-login" }]);

    expect((await trackingRefs(companion))?.pendingRef).toBe("refs/remotes/origin/mate/inbox");
  });

  test("counts blocked Delivery Groups once each", async () => {
    const companion = seedPending(companionPath(tempRoot()), [
      { name: "acme-login", branch: "workset/acme-login", blocked: true },
      { name: "acme-login-ui", branch: "workset/acme-login", blocked: true },
      { name: "acme-glossary", blocked: true },
      { name: "acme-other", branch: "workset/acme-other" },
    ]);

    expect((await pendingSubmittedCounts(companion)).blocked).toBe(2);
  });

  test("counts changes this checkout submitted from its recorded folders", async () => {
    const companion = seedPending(companionPath(tempRoot()), [
      { name: "acme-login" },
      { name: "acme-theirs" },
    ]);

    expect(
      await pendingSubmittedCounts(companion, { "openspec/changes/acme-login": {} }),
    ).toMatchObject({
      submitted: 2,
      mine: 1,
    });
  });

  test("counts changes committed with this user's Git email, from any machine", async () => {
    const companion = seedPending(companionPath(tempRoot()), [
      { name: "acme-login", author: { name: "Acme Me", email: "Me@Acme.example" } },
      { name: "acme-theirs", author: { name: "Acme Dev", email: "dev@acme.example" } },
    ]);
    git(companion, "config", "user.email", "me@acme.example");

    expect(await pendingSubmittedCounts(companion)).toMatchObject({ submitted: 2, mine: 1 });
  });

  test("leaves out an inbox change the default branch already archived", async () => {
    const companion = seedPending(
      companionPath(tempRoot()),
      [{ name: "acme-login" }, { name: "acme-next" }],
      ["acme-login"],
    );

    expect((await pendingSubmittedCounts(companion)).submitted).toBe(1);
  });

  test("leaves out an archived inbox change whose files differ in line endings only", async () => {
    const companion = seedPending(
      companionPath(tempRoot()),
      [{ name: "acme-login" }, { name: "acme-next" }],
      ["acme-login"],
    );
    // The inbox stores CRLF as written; the default branch's attributes normalised the archive.
    const branch = git(companion, "symbolic-ref", "--short", "HEAD").trim();
    git(companion, "checkout", "-q", "--detach", "refs/remotes/origin/mate/inbox");
    fs.writeFileSync(
      path.join(companion, "openspec", "changes", "acme-login", "proposal.md"),
      "# acme-login\r\n",
    );
    git(companion, "-c", "core.autocrlf=false", "commit", "-qam", "submit with CRLF");
    git(companion, "update-ref", "refs/remotes/origin/mate/inbox", "HEAD");
    git(companion, "checkout", "-q", branch);

    expect((await pendingSubmittedCounts(companion)).submitted).toBe(1);
  });

  test("is zero without a fetched pending branch", async () => {
    const companion = seedPending(companionPath(tempRoot()), null);

    expect(await pendingSubmittedCounts(companion)).toEqual({ submitted: 0, mine: 0, blocked: 0 });
  });

  test("the runtime layout matches the built-in artifact type", async () => {
    const type = defaultArtifactType();

    expect([OPENSPEC_LAYOUT.source, OPENSPEC_LAYOUT.archiveRoot]).toEqual([
      type.source,
      type.archiveRoot,
    ]);
    expect(OPENSPEC_LAYOUT.recordName("2026-11-02-acme-login")).toBe(
      type.recordName("2026-11-02-acme-login"),
    );
  });
});

describe("pendingSubmittedChanges", () => {
  test("names each change's submitter, the latest one for a change submitted again", async () => {
    const companion = seedPending(companionPath(tempRoot()), [
      { name: "acme-login", author: { name: "Acme Me", email: "me@acme.example" } },
      { name: "acme-theirs", author: { name: "Acme Dev", email: "dev@acme.example" } },
    ]);
    git(companion, "config", "user.email", "me@acme.example");
    // Dropped, then submitted again by someone else.
    git(companion, "checkout", "-q", "--detach", "refs/remotes/origin/mate/inbox");
    git(companion, "rm", "-q", "-r", "openspec/changes/acme-theirs");
    git(companion, "commit", "-q", "-m", "drop acme-theirs");
    git(companion, "checkout", "-q", "HEAD~1", "--", "openspec/changes/acme-theirs");
    git(
      companion,
      "-c",
      "user.name=Acme Ops",
      "-c",
      "user.email=ops@acme.example",
      "commit",
      "-q",
      "-m",
      "submit acme-theirs",
    );
    git(companion, "update-ref", "refs/remotes/origin/mate/inbox", "HEAD");
    git(companion, "checkout", "-q", "main");

    expect(await pendingSubmittedChanges(companion)).toEqual([
      { name: "acme-login", group: "", blocked: false, mine: true, author: "Acme Me" },
      { name: "acme-theirs", group: "", blocked: false, mine: false, author: "Acme Ops" },
    ]);
  });

  test("a change this checkout submitted is the user's under any Git email", async () => {
    const companion = seedPending(companionPath(tempRoot()), [
      { name: "acme-login", author: { name: "Acme Laptop", email: "laptop@acme.example" } },
    ]);

    expect(
      (await pendingSubmittedChanges(companion, { "openspec/changes/acme-login": {} }))[0],
    ).toMatchObject({ mine: true, author: "Acme Laptop" });
  });
});

describe("matchingArchive", () => {
  const source = new Map([
    ["proposal.md", "a1"],
    ["tasks.md", "b1"],
  ]);
  const archived = async () =>
    new Map([
      ["proposal.md", "a1"],
      ["tasks.md", "b2"],
    ]);

  test("takes blobs that differ as one file only when sameBlob says so", async () => {
    const ids = ["2026-11-01-acme"];
    expect(await matchingArchive(ids, source, archived)).toBeNull();
    expect(await matchingArchive(ids, source, archived, async () => false)).toBeNull();
    expect(
      await matchingArchive(ids, source, archived, async (a, b) => a === "b1" && b === "b2"),
    ).toBe("2026-11-01-acme");
  });

  test("an archive with other files never matches", async () => {
    const other = async () => new Map([["proposal.md", "a1"]]);
    expect(await matchingArchive(["2026-11-01-acme"], source, other, async () => true)).toBeNull();
  });
});

describe("trackingRefs", () => {
  test("without an upstream or origin/HEAD, takes origin/main", async () => {
    const companion = seedPending(companionPath(tempRoot()), []);
    const branch = git(companion, "symbolic-ref", "--short", "HEAD").trim();
    git(companion, "config", "--unset", `branch.${branch}.merge`);

    expect(await trackingRefs(companion)).toEqual({
      defaultRef: "refs/remotes/origin/main",
      pendingRef: "refs/remotes/origin/mate/inbox",
    });
  });
});

describe("pendingSubmittedLine", () => {
  test("names the count, the user's own and blocked groups", async () => {
    const root = tempRoot();
    const companion = seedPending(companionPath(root), [
      { name: "acme-login", branch: "workset/acme-login", blocked: true },
      { name: "acme-theirs" },
    ]);
    const home = path.join(root, "home");
    updateSubmittedFolders(
      companion,
      { "openspec/changes/acme-login": { digest: "d", submittedAt: "2026-11-12T10:00:00.000Z" } },
      [],
      home,
    );

    expect(await pendingSubmittedLine(companion, home)).toBe(
      "2 submitted awaiting publication · 1 yours · 1 group blocked",
    );
  });

  test("only others' changes", async () => {
    const root = tempRoot();
    const companion = seedPending(companionPath(root), [{ name: "acme-login" }]);

    expect(await pendingSubmittedLine(companion, path.join(root, "home"))).toBe(
      "1 submitted awaiting publication",
    );
  });

  test("none submitted adds no line", async () => {
    const root = tempRoot();
    const companion = seedPending(companionPath(root), [{ name: "acme-draft", state: "active" }]);

    expect(await pendingSubmittedLine(companion, path.join(root, "home"))).toBe(null);
  });
});
