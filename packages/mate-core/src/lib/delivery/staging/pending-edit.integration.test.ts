import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { git, initRepo } from "../../../../test/git-checkouts";
import { makeStagingFixture, showAt, type StagingFixture } from "../../../../test/staging-fixture";
import { companionGit, type CompanionGit } from "../../../runtime/companion-git";
import { commitToPending, type PendingCommitDeps, type PendingCommitInput } from "./pending-edit";

/** Each case runs real Git several times. */
const TIMEOUT = 120_000;
const INBOX = "mate/inbox";
const NOTE = "notes/acme.md";
const fixtures: StagingFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

const realGit = (cwd: string): CompanionGit =>
  companionGit(cwd, { prompt: "never", budgetMs: TIMEOUT });

async function companion() {
  const fixture = await makeStagingFixture();
  fixtures.push(fixture);
  return { fixture, companion: fixture.clone("acme-companion") };
}

/** Writes `text` to `file` in the pending checkout and reports it touched. */
const write =
  (file: string, text: string): PendingCommitInput<never>["edit"] =>
  async (dir) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
    return [file];
  };

function commit<T = never>(
  fixture: StagingFixture,
  companionPath: string,
  edit: PendingCommitInput<T>["edit"],
  options: Partial<PendingCommitInput<T>> & Partial<PendingCommitDeps> = {},
) {
  const { git: gitFor = realGit, scan, newTransaction, ...input } = options;
  return commitToPending<T>(
    { companionPath, subject: "chore(acme): edit the inbox", edit, ...input },
    {
      git: gitFor,
      tmpRoot: fixture.root,
      scan: scan ?? (async () => ({ skipped: false, findings: [] })),
      ...(newTransaction ? { newTransaction } : {}),
    },
  );
}

/** Commit count of the inbox on the remote; 0 before it exists. */
function inboxCommits(fixture: StagingFixture): number {
  try {
    return Number(git(fixture.remote, "rev-list", "--count", INBOX, "--").trim());
  } catch {
    return 0;
  }
}

describe("commitToPending", () => {
  test(
    "pushes the edit as one commit with a transaction trailer",
    async () => {
      const { fixture, companion: dir } = await companion();
      const status = git(dir, "status", "--porcelain");

      const result = await commit(fixture, dir, write(NOTE, "hello\n"), {
        newTransaction: () => "acme-transaction",
      });

      expect(result).toMatchObject({ status: "pushed", remote: { pendingBranch: INBOX } });
      expect(showAt(fixture.remote, INBOX, NOTE)).toBe("hello\n");
      expect(git(fixture.remote, "log", "-1", "--format=%s%n%b", INBOX, "--")).toContain(
        "chore(acme): edit the inbox\nMate-Transaction: acme-transaction",
      );
      // The checkout is never touched.
      expect(git(dir, "status", "--porcelain")).toBe(status);
    },
    TIMEOUT,
  );

  test(
    "an edit that changes nothing adds no commit",
    async () => {
      const { fixture, companion: dir } = await companion();
      await commit(fixture, dir, write(NOTE, "hello\n"));
      const before = inboxCommits(fixture);

      const result = await commit(fixture, dir, write(NOTE, "hello\n"));

      expect(result.status).toBe("unchanged");
      expect(inboxCommits(fixture)).toBe(before);
    },
    TIMEOUT,
  );

  test(
    "a secret finding refuses the commit and pushes nothing",
    async () => {
      const { fixture, companion: dir } = await companion();

      const result = await commit(fixture, dir, write(NOTE, "token\n"), {
        scan: async (_root, paths) => ({
          skipped: false,
          findings: [{ path: paths[0]!, line: 1, ruleId: "acme-token" }],
        }),
      });

      expect(result).toMatchObject({
        status: "failed",
        reason: "secret",
        secretFindings: [{ path: NOTE, line: 1, ruleId: "acme-token" }],
      });
      expect(inboxCommits(fixture)).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "a policy that skips the scan refuses nothing",
    async () => {
      const { fixture, companion: dir } = await companion();

      const result = await commit(fixture, dir, write(NOTE, "token\n"), {
        scan: async () => ({ skipped: true }),
      });

      expect(result.status).toBe("pushed");
    },
    TIMEOUT,
  );

  test(
    "a commit that only removes files is not scanned",
    async () => {
      const { fixture, companion: dir } = await companion();
      await commit(fixture, dir, write(NOTE, "hello\n"));
      let scans = 0;

      const result = await commit(
        fixture,
        dir,
        async (checkout) => {
          fs.rmSync(path.join(checkout, NOTE));
          return [NOTE];
        },
        {
          scan: async () => {
            scans += 1;
            return { skipped: false, findings: [] };
          },
        },
      );

      expect(result.status).toBe("pushed");
      expect(scans).toBe(0);
      expect(showAt(fixture.remote, INBOX, NOTE)).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "a renamed file is scanned under its new path",
    async () => {
      const { fixture, companion: dir } = await companion();
      await commit(fixture, dir, write(NOTE, "hello\n"));
      const scanned: string[][] = [];

      const result = await commit(
        fixture,
        dir,
        async (checkout) => {
          fs.renameSync(path.join(checkout, NOTE), path.join(checkout, "notes/renamed.md"));
          return ["notes"];
        },
        {
          scan: async (_root, paths) => {
            scanned.push(paths);
            return { skipped: false, findings: [] };
          },
        },
      );

      expect(result.status).toBe("pushed");
      expect(scanned).toEqual([["notes/renamed.md"]]);
    },
    TIMEOUT,
  );

  test(
    "a rejected push is rebuilt on the new tip",
    async () => {
      const { fixture, companion: dir } = await companion();
      const rival = fixture.clone("acme-rival");
      let edits = 0;

      const result = await commit(fixture, dir, async (checkout, remote) => {
        edits += 1;
        if (edits === 1) await commit(fixture, rival, write("notes/rival.md", "rival\n"));
        return write(NOTE, "hello\n")(checkout, remote);
      });

      expect(result.status).toBe("pushed");
      expect(edits).toBe(2);
      expect(showAt(fixture.remote, INBOX, NOTE)).toBe("hello\n");
      expect(showAt(fixture.remote, INBOX, "notes/rival.md")).toBe("rival\n");
    },
    TIMEOUT,
  );

  test(
    "a pending branch that keeps moving is a conflict after the last attempt",
    async () => {
      const { fixture, companion: dir } = await companion();
      const rival = fixture.clone("acme-rival");
      let edits = 0;

      const result = await commit(fixture, dir, async (checkout, remote) => {
        edits += 1;
        await commit(fixture, rival, write("notes/rival.md", `rival ${edits}\n`));
        return write(NOTE, "hello\n")(checkout, remote);
      });

      expect(result).toMatchObject({ status: "failed", reason: "conflict" });
      expect(edits).toBe(3);
      expect(showAt(fixture.remote, INBOX, NOTE)).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "a push the remote refuses for this user is not permitted",
    async () => {
      const { fixture, companion: dir } = await companion();
      fs.writeFileSync(
        path.join(fixture.remote, "hooks", "pre-receive"),
        `#!/bin/sh\necho "GH006: Protected branch update failed." >&2\nexit 1\n`,
        { mode: 0o755 },
      );

      const result = await commit(fixture, dir, write(NOTE, "hello\n"));

      expect(result).toMatchObject({ status: "failed", reason: "not-permitted" });
      expect(result.status === "failed" && result.detail).toContain("GH006");
      expect(inboxCommits(fixture)).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "a cut-off push counts as pushed once its transaction reached the remote",
    async () => {
      const { fixture, companion: dir } = await companion();
      const cutOff = (cwd: string): CompanionGit => {
        const real = realGit(cwd);
        return {
          ...real,
          push: async (args, gitOptions) => {
            const pushed = await real.push(args, gitOptions);
            return { ...pushed, status: 1, stderr: "fatal: the remote end hung up unexpectedly" };
          },
        };
      };

      const result = await commit(fixture, dir, write(NOTE, "hello\n"), { git: cutOff });

      expect(result.status).toBe("pushed");
      expect(inboxCommits(fixture)).toBe(2);
    },
    TIMEOUT,
  );

  test(
    "a companion without an upstream has no pending branch",
    async () => {
      const { fixture } = await companion();
      const alone = initRepo(path.join(fixture.root, "acme-alone"));

      const result = await commit(fixture, alone, write(NOTE, "hello\n"));

      expect(result).toMatchObject({ status: "failed", reason: "no-remote", remote: null });
    },
    TIMEOUT,
  );

  test(
    "beforeCommit is asked after the scan and stops the commit",
    async () => {
      const { fixture, companion: dir } = await companion();
      const order: string[] = [];

      const result = await commit(fixture, dir, write(NOTE, "hello\n"), {
        scan: async () => {
          order.push("scan");
          return { skipped: false, findings: [] };
        },
        beforeCommit: () => {
          order.push("beforeCommit");
          return false;
        },
      });

      expect(result).toMatchObject({ status: "stopped", value: undefined });
      expect(order).toEqual(["scan", "beforeCommit"]);
      expect(inboxCommits(fixture)).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "an edit may stop with a value of its own",
    async () => {
      const { fixture, companion: dir } = await companion();

      const result = await commit<string>(fixture, dir, async () => ({ stop: "not needed" }));

      expect(result).toMatchObject({ status: "stopped", value: "not needed" });
      expect(inboxCommits(fixture)).toBe(0);
    },
    TIMEOUT,
  );
});
