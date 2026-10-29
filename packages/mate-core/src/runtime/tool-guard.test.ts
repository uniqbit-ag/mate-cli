import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createTempDir } from "../../../../test/fixtures";
import { ARTIFACT_REFUSAL_HEADLINE } from "./artifact-refusal";
import { companionLinkPath } from "./repo-local";
import {
  checkToolCall,
  type GuardedToolCall,
  type ToolGuardScope,
  type WriteMode,
} from "./tool-guard";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await createTempDir(prefix);
  tempRoots.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  spawnSync("git", args, { cwd, stdio: "ignore" });
}

function commitAll(repo: string): void {
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Mate", "-c", "user.email=mate@example.test", "commit", "-qm", "x");
}

/** A Git Working Repository with a companion folder inside it, as most cases need. */
async function fixture(prefix: string): Promise<{ repo: string; companion: string }> {
  const repo = await makeTempDir(prefix);
  const companion = path.join(repo, "companion");
  await fs.mkdir(companion, { recursive: true });
  git(repo, "init", "-q");
  return { repo, companion };
}

function scopeFor(
  repo: string,
  companion: string,
  extra: Partial<ToolGuardScope> = {},
): ToolGuardScope {
  return {
    companionPath: companion,
    repositoryPath: repo,
    runtimeStateRoots: [],
    env: { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
    ...extra,
  };
}

const write = (filePath: string, mode: WriteMode = "create", content = ""): GuardedToolCall => ({
  kind: "write",
  writes: [{ path: filePath, content, mode }],
});
const shell = (command: string): GuardedToolCall => ({ kind: "shell", command });

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("check order and refusal shape", () => {
  const trailer = "Co-Authored-By: Claude <noreply@anthropic.com>";

  test("a refusal names its check and carries the check's message", async () => {
    const { repo, companion } = await fixture("mate-tg-attribution-");
    const refusal = await checkToolCall(
      shell(`git commit -m "fix: x" -m "${trailer}"`),
      scopeFor(repo, companion),
    );
    expect(refusal?.check).toBe("attribution");
    expect(refusal?.message).toContain("No commit was created");
  });

  test("attribution wins over an artifact redirect target", async () => {
    const { repo, companion } = await fixture("mate-tg-attribution-redirect-");
    const refusal = await checkToolCall(
      shell(`git commit -m "${trailer}" > design.md`),
      scopeFor(repo, companion),
    );
    expect(refusal?.check).toBe("attribution");
  });

  test("the secret check wins over attribution", async () => {
    const { repo, companion } = await fixture("mate-tg-secret-first-");
    const refusal = await checkToolCall(
      shell(`git commit -m "${trailer}" && cat .env`),
      scopeFor(repo, companion),
    );
    expect(refusal?.check).toBe("secret");
  });

  test("a secret refusal wins over an artifact refusal for the same write", async () => {
    const { repo, companion } = await fixture("mate-tg-secret-artifact-");
    const refusal = await checkToolCall(
      write(path.join(repo, "openspec", "changes", ".env")),
      scopeFor(repo, companion),
    );
    expect(refusal?.check).toBe("secret");
  });

  test("an ordinary commit and an allowed write return no refusal", async () => {
    const { repo, companion } = await fixture("mate-tg-allowed-");
    expect(
      await checkToolCall(
        shell(`git commit -m "Co-Authored-By: Jane <jane@acme.example>"`),
        scopeFor(repo, companion),
      ),
    ).toBeNull();
    expect(
      await checkToolCall(write(path.join(repo, "src", "index.ts")), scopeFor(repo, companion)),
    ).toBeNull();
  });
});

describe("artifact classification and exemptions", () => {
  test("allows writes under the companion path", async () => {
    const { repo, companion } = await fixture("mate-tg-companion-");
    expect(
      await checkToolCall(write(path.join(companion, "design.md")), scopeFor(repo, companion)),
    ).toBeNull();
  });

  test("allows non-artifact source writes and README.md", async () => {
    const { repo, companion } = await fixture("mate-tg-source-");
    for (const target of [path.join(repo, "src", "index.ts"), path.join(repo, "README.md")]) {
      // oxlint-disable-next-line no-await-in-loop -- one target at a time
      expect(await checkToolCall(write(target), scopeFor(repo, companion))).toBeNull();
    }
  });

  test("classifies artifact names, markers and Markdown files", async () => {
    const { repo, companion } = await fixture("mate-tg-classify-");
    for (const target of [
      "design.md",
      "CLAUDE.md",
      "notes.md",
      "openspec/changes/x/notes.txt",
      "docs/adr/0001.txt",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one target at a time
      const refusal = await checkToolCall(write(target), scopeFor(repo, companion));
      expect(refusal?.check).toBe("artifact");
    }
  });

  test("allows gitignored working-repo artifact paths", async () => {
    const { repo, companion } = await fixture("mate-tg-ignored-");
    await fs.writeFile(path.join(repo, ".gitignore"), "scratch/*.md\n", "utf8");
    expect(
      await checkToolCall(write(path.join(repo, "scratch", "note.md")), scopeFor(repo, companion)),
    ).toBeNull();
  });

  test("blocks non-gitignored working-repo artifact paths", async () => {
    const { repo, companion } = await fixture("mate-tg-blocked-");
    const refusal = await checkToolCall(
      write(path.join(repo, "scratch", "note.md")),
      scopeFor(repo, companion),
    );
    expect(refusal?.check).toBe("artifact");
    expect(refusal?.message).toContain(ARTIFACT_REFUSAL_HEADLINE);
  });

  test("notes the companion CLAUDE.md location when blocking CLAUDE.md", async () => {
    const { repo, companion } = await fixture("mate-tg-claudemd-");
    const refusal = await checkToolCall(
      write(path.join(repo, "CLAUDE.md")),
      scopeFor(repo, companion),
    );
    expect(refusal?.message).toContain(`${companion}/CLAUDE.md`);
  });

  test("suggests a companion path for an absolute in-repo target", async () => {
    const repo = await makeTempDir("mate-tg-abs-");
    const companion = await makeTempDir("mate-tg-abs-companion-");
    git(repo, "init", "-q");
    const refusal = await checkToolCall(
      write(path.join(repo, "scratch", "plan.md")),
      scopeFor(repo, companion),
    );
    expect(refusal?.message).toContain(` suggested: ${path.join(companion, "scratch", "plan.md")}`);
    expect(refusal?.message).not.toContain("resolved:");
  });

  test("suggests nothing for a target outside the working repo", async () => {
    const repo = await makeTempDir("mate-tg-out-");
    const companion = await makeTempDir("mate-tg-out-companion-");
    const elsewhere = await makeTempDir("mate-tg-out-elsewhere-");
    git(repo, "init", "-q");
    const refusal = await checkToolCall(
      write(path.join(elsewhere, "notes.md")),
      scopeFor(repo, companion),
    );
    expect(refusal?.check).toBe("artifact");
    expect(refusal?.message).toContain(` companion: ${companion}`);
    expect(refusal?.message).not.toContain("suggested:");
  });

  test("allows product documentation and storybook paths", async () => {
    const { repo, companion } = await fixture("mate-tg-docs-allow-");
    await fs.mkdir(path.join(repo, "apps", "docs"), { recursive: true });
    await fs.writeFile(path.join(repo, "apps", "docs", "package.json"), "{}\n", "utf8");
    await fs.mkdir(path.join(repo, "docs"), { recursive: true });
    await fs.writeFile(path.join(repo, "docs", "package.json"), "{}\n", "utf8");
    for (const target of [
      path.join(repo, "apps", "docs", "content", "docs", "index.mdx"),
      path.join(repo, "docs", "content", "index.mdx"),
      path.join(repo, ".storybook", "preview.ts"),
      path.join(repo, "storybook", "intro.mdx"),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one target at a time
      expect(await checkToolCall(write(target), scopeFor(repo, companion))).toBeNull();
    }
  });

  test("still blocks artifact folders under product docs", async () => {
    const { repo, companion } = await fixture("mate-tg-docs-block-");
    await fs.mkdir(path.join(repo, "apps", "docs-without-package"), { recursive: true });
    for (const target of [
      path.join(repo, "apps", "docs-without-package", "guide.md"),
      path.join(repo, "docs", "usage.md"),
      path.join(repo, "docs", "decisions", "ADR-001.md"),
      path.join(repo, "docs", "prd", "new-feature.md"),
      path.join(repo, "docs", "usage", "tasks.md"),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one target at a time
      const refusal = await checkToolCall(write(target), scopeFor(repo, companion));
      expect(refusal?.check).toBe("artifact");
    }
  });

  test("a Markdown file the Working Repository tracks is product material", async () => {
    const { repo, companion } = await fixture("mate-tg-tracked-");
    const skillPath = path.join(repo, "src", "templates", "skills", "SKILL.md");
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, "packaged skill template\n", "utf8");
    commitAll(repo);
    for (const mode of ["create", "edit"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one mode at a time
      expect(await checkToolCall(write(skillPath, mode), scopeFor(repo, companion))).toBeNull();
    }
  });

  test("an inherited GIT_DIR does not change the tracked-path answer", async () => {
    const { repo, companion } = await fixture("mate-tg-git-dir-");
    const elsewhere = await makeTempDir("mate-tg-elsewhere-");
    git(elsewhere, "init", "-q");
    const docPath = path.join(repo, "notes", "acme.md");
    await fs.mkdir(path.dirname(docPath), { recursive: true });
    await fs.writeFile(docPath, "tracked\n", "utf8");
    commitAll(repo);

    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(elsewhere, ".git");
    try {
      expect(await checkToolCall(write(docPath), scopeFor(repo, companion))).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });

  test("an inherited GIT_DIR does not change the ignored-path answer", async () => {
    const { repo, companion } = await fixture("mate-tg-git-dir-ignored-");
    const elsewhere = await makeTempDir("mate-tg-elsewhere-ignored-");
    git(elsewhere, "init", "-q");
    await fs.writeFile(path.join(repo, ".gitignore"), "scratch/\n", "utf8");

    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(elsewhere, ".git");
    try {
      expect(
        await checkToolCall(write(path.join(repo, "scratch", "n.md")), scopeFor(repo, companion)),
      ).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });

  test("an edit of an existing file passes; a create over it and an edit of a missing file do not", async () => {
    const { repo, companion } = await fixture("mate-tg-existing-");
    const notePath = path.join(repo, "scratch", "note.md");
    await fs.mkdir(path.dirname(notePath), { recursive: true });
    await fs.writeFile(notePath, "existing untracked artifact\n", "utf8");
    const scope = scopeFor(repo, companion);

    expect(await checkToolCall(write(notePath, "edit"), scope)).toBeNull();
    expect((await checkToolCall(write(notePath, "create"), scope))?.check).toBe("artifact");
    expect(
      (await checkToolCall(write(path.join(repo, "scratch", "missing.md"), "edit"), scope))?.check,
    ).toBe("artifact");
  });

  test("allows writes inside a declared runtime state root, and only there", async () => {
    const { repo, companion } = await fixture("mate-tg-state-root-");
    const stateRoot = await makeTempDir("mate-tg-state-");
    const scope = scopeFor(repo, companion, { runtimeStateRoots: [stateRoot] });
    expect(await checkToolCall(write(path.join(stateRoot, "plans", "p.md")), scope)).toBeNull();
    expect((await checkToolCall(write(path.join(repo, "plans", "p.md")), scope))?.check).toBe(
      "artifact",
    );
  });

  test("a patch-like call judges every file it writes", async () => {
    const { repo, companion } = await fixture("mate-tg-multi-");
    const refusal = await checkToolCall(
      {
        kind: "write",
        writes: [
          { path: "src/main.ts", content: "", mode: "create" },
          { path: "notes/x.md", content: "", mode: "create" },
        ],
      },
      scopeFor(repo, companion),
    );
    expect(refusal?.check).toBe("artifact");
    expect(refusal?.message).toContain(` resolved:  ${path.join(repo, "notes", "x.md")}`);
  });
});

describe("a session without a Working Repository", () => {
  async function companionOnly(workingDirectory?: string) {
    const companion = await makeTempDir("mate-tg-companion-only-");
    const elsewhere = await makeTempDir("mate-tg-companion-only-elsewhere-");
    const scope: ToolGuardScope = {
      companionPath: companion,
      repositoryPath: "",
      workingDirectory: workingDirectory ?? companion,
      runtimeStateRoots: [path.join(elsewhere, "state")],
      env: { MATE_ARTIFACT_PATH: companion },
    };
    return { companion, elsewhere, scope };
  }

  test("refuses an artifact written outside the companion", async () => {
    const { companion, elsewhere, scope } = await companionOnly();
    const refusal = await checkToolCall(write(path.join(elsewhere, "design.md")), scope);
    expect(refusal?.check).toBe("artifact");
    expect(refusal?.message).not.toContain("suggested:");
    expect(await checkToolCall(write(path.join(companion, "design.md")), scope)).toBeNull();
    expect(await checkToolCall(write(path.join(elsewhere, "a.ts")), scope)).toBeNull();
    expect(
      (await checkToolCall(shell(`printf x > ${path.join(elsewhere, "notes.md")}`), scope))?.check,
    ).toBe("artifact");
  });

  test("keeps the exemptions that need no Working Repository", async () => {
    const { elsewhere, scope } = await companionOnly();
    await fs.writeFile(path.join(elsewhere, "existing.md"), "x\n", "utf8");
    expect(
      await checkToolCall(write(path.join(elsewhere, "existing.md"), "edit"), scope),
    ).toBeNull();
    expect(
      await checkToolCall(write(path.join(elsewhere, "state", "plans", "p.md")), scope),
    ).toBeNull();
  });

  test("resolves a relative target against the session's folder", async () => {
    const { scope } = await companionOnly();
    expect(await checkToolCall(write("notes/design.md"), scope)).toBeNull();

    const folder = await makeTempDir("mate-tg-companion-only-folder-");
    const outside = await companionOnly(folder);
    const refusal = await checkToolCall(write("notes/design.md"), outside.scope);
    expect(refusal?.check).toBe("artifact");
    expect(refusal?.message).toContain(` resolved:  ${path.join(folder, "notes", "design.md")}`);
    expect(refusal?.message).toContain("Relative paths resolve against the session's folder");
  });

  test("does not ask another repository's Git", async () => {
    const folder = await makeTempDir("mate-tg-companion-only-git-");
    git(folder, "init", "-q");
    await fs.writeFile(path.join(folder, "tracked.md"), "x\n", "utf8");
    await fs.writeFile(path.join(folder, ".gitignore"), "ignored.md\n", "utf8");
    commitAll(folder);
    const { scope } = await companionOnly(folder);
    for (const name of ["tracked.md", "ignored.md"]) {
      // oxlint-disable-next-line no-await-in-loop -- one target at a time
      const refusal = await checkToolCall(write(path.join(folder, name)), scope);
      expect({ name, check: refusal?.check }).toEqual({ name, check: "artifact" });
    }
  });
});

describe("companion recognition", () => {
  test("a sibling folder whose name starts with the companion's is not the companion", async () => {
    const root = await makeTempDir("mate-tg-sibling-");
    const repo = path.join(root, "repo");
    const companion = path.join(root, "companion");
    const sibling = path.join(root, "companion-old");
    for (const dir of [repo, companion, sibling]) await fs.mkdir(dir, { recursive: true });
    git(repo, "init", "-q");

    const refusal = await checkToolCall(
      write(path.join(sibling, "notes.md")),
      scopeFor(repo, companion),
    );
    expect(refusal?.check).toBe("artifact");
  });

  test("the secret scan follows the same recognition", async () => {
    const root = await makeTempDir("mate-tg-sibling-scan-");
    const repo = path.join(root, "repo");
    const companion = path.join(root, "companion");
    const sibling = path.join(root, "companion-old");
    for (const dir of [repo, companion, sibling]) await fs.mkdir(dir, { recursive: true });
    git(repo, "init", "-q");
    const scanned: string[] = [];

    await checkToolCall(
      {
        kind: "write",
        writes: [
          { path: path.join(sibling, "a.ts"), content: "x", mode: "create" },
          { path: path.join(companion, "b.md"), content: "x", mode: "create" },
        ],
      },
      scopeFor(repo, companion),
      {
        scan: async (filePath) => {
          scanned.push(filePath);
          return [];
        },
      },
    );
    expect(scanned).toEqual([path.join(companion, "b.md")]);
  });

  test("treats a write through the companion link as a companion write", async () => {
    const { repo, companion } = await fixture("mate-tg-link-");
    await fs.mkdir(path.dirname(companionLinkPath(repo)), { recursive: true });
    await fs.symlink(companion, companionLinkPath(repo), "dir");
    const scope = scopeFor(repo, companion);

    const throughLink = path.join(companionLinkPath(repo), "openspec", "changes", "acme", "p.md");
    expect(await checkToolCall(write(throughLink), scope)).toBeNull();
    expect((await checkToolCall(write(path.join(repo, "p.md")), scope))?.check).toBe("artifact");
  });

  test("judges an operator's own link by where it lands", async () => {
    const { repo, companion } = await fixture("mate-tg-operator-link-");
    await fs.symlink(companion, path.join(repo, "artifacts"), "dir");
    expect(
      await checkToolCall(
        write(path.join(repo, "artifacts", "design.md")),
        scopeFor(repo, companion),
      ),
    ).toBeNull();
  });
});

describe("shell targets", () => {
  async function shellVerdict(command: string): Promise<string | null> {
    const repo = await makeTempDir("mate-tg-shell-");
    const companion = await makeTempDir("mate-tg-shell-companion-");
    git(repo, "init", "-q");
    return (await checkToolCall(shell(command), scopeFor(repo, companion)))?.check ?? null;
  }

  test("a redirect, an append and a tee into the Working Repository are refused", async () => {
    expect(await shellVerdict("cat > notes/handoff.md")).toBe("artifact");
    expect(await shellVerdict("echo notes >> scratch/note.md")).toBe("artifact");
    expect(await shellVerdict("printf hello | tee scratch/note.md")).toBe("artifact");
  });

  test("explains a relative redirect after cd into the companion", async () => {
    const repo = await makeTempDir("mate-tg-cd-");
    const companion = await makeTempDir("mate-tg-cd-companion-");
    git(repo, "init", "-q");
    const refusal = await checkToolCall(
      shell(`cd ${companion} && cat > notes/handoff.md`),
      scopeFor(repo, companion),
    );
    expect(refusal?.check).toBe("artifact");
    expect(refusal?.message).toContain(` resolved:  ${path.join(repo, "notes", "handoff.md")}`);
    expect(refusal?.message).toContain("`cd` is not followed");
    expect(refusal?.message).toContain(
      ` suggested: ${path.join(companion, "notes", "handoff.md")}`,
    );
  });

  test("allows a gitignored tee target", async () => {
    const { repo, companion } = await fixture("mate-tg-tee-ignored-");
    await fs.writeFile(path.join(repo, ".gitignore"), "scratch/*.md\n", "utf8");
    expect(
      await checkToolCall(shell("printf hello | tee scratch/note.md"), scopeFor(repo, companion)),
    ).toBeNull();
  });
});

describe("classification ignores letter case", () => {
  test("upper-case Markdown names and markers are artifacts; README.MD is not", async () => {
    const { repo, companion } = await fixture("mate-tg-case-");
    for (const target of [
      "NOTES.MD",
      "Spec.MD",
      "packages/x/claude.md",
      "OpenSpec/x/notes.txt",
      "docs/ADR/0001.txt",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one target at a time
      const refusal = await checkToolCall(write(target), scopeFor(repo, companion));
      expect(refusal?.check).toBe("artifact");
    }
    expect(await checkToolCall(write("README.MD"), scopeFor(repo, companion))).toBeNull();
    expect(await checkToolCall(write("docs/Readme.md"), scopeFor(repo, companion))).toBeNull();
  });

  test("an upper-case shell target is judged too", async () => {
    const { repo, companion } = await fixture("mate-tg-case-shell-");
    const refusal = await checkToolCall(shell("echo x > NOTES.MD"), scopeFor(repo, companion));
    expect(refusal?.check).toBe("artifact");
  });
});

describe("symlinks are followed before `..`", () => {
  /** `companion/back` leads to `<repo>/src`, so `companion/back/..` is `<repo>`. */
  async function backLinkFixture(prefix: string) {
    const { repo, companion } = await fixture(prefix);
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    await fs.symlink(path.join(repo, "src"), path.join(companion, "back"), "dir");
    return { repo, companion, escaped: `${companion}/back/../escaped.md` };
  }

  test("a write that escapes the companion through a link is refused", async () => {
    const { repo, companion, escaped } = await backLinkFixture("mate-tg-dotdot-");
    const refusal = await checkToolCall(write(escaped), scopeFor(repo, companion));
    expect(refusal?.check).toBe("artifact");
    expect(refusal?.message).toContain(` suggested: ${path.join(companion, "escaped.md")}`);
  });

  test("a relative target names where the write lands", async () => {
    const { repo, companion } = await backLinkFixture("mate-tg-dotdot-rel-");
    const refusal = await checkToolCall(
      write("companion/back/../escaped.md"),
      scopeFor(repo, companion),
    );
    expect(refusal?.check).toBe("artifact");
    expect(refusal?.message).toContain(` resolved:  ${path.join(repo, "escaped.md")}`);
  });

  test("a shell redirect that escapes the companion through a link is refused", async () => {
    const { repo, companion, escaped } = await backLinkFixture("mate-tg-dotdot-shell-");
    const refusal = await checkToolCall(shell(`printf x > ${escaped}`), scopeFor(repo, companion));
    expect(refusal?.check).toBe("artifact");
  });

  test("a write that lands in the companion through a link is a companion write", async () => {
    const { repo, companion } = await fixture("mate-tg-dotdot-in-");
    await fs.mkdir(path.join(companion, "sub"), { recursive: true });
    await fs.mkdir(path.join(repo, "a"), { recursive: true });
    await fs.symlink(path.join(companion, "sub"), path.join(repo, "a", "b"), "dir");
    const scanned: string[] = [];

    const refusal = await checkToolCall(
      { kind: "write", writes: [{ path: `${repo}/a/b/../x.md`, content: "x", mode: "create" }] },
      scopeFor(repo, companion),
      {
        scan: async (filePath) => {
          scanned.push(filePath);
          return [];
        },
      },
    );
    expect(refusal).toBeNull();
    expect(scanned).toHaveLength(1);
  });

  test("a runtime state root reached through a link and `..` is not state", async () => {
    const { repo, companion } = await fixture("mate-tg-dotdot-state-");
    const stateRoot = await makeTempDir("mate-tg-dotdot-state-root-");
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    await fs.symlink(path.join(repo, "src"), path.join(stateRoot, "sym"), "dir");
    const scope = scopeFor(repo, companion, { runtimeStateRoots: [stateRoot] });
    expect((await checkToolCall(write(`${stateRoot}/sym/../notes.md`), scope))?.check).toBe(
      "artifact",
    );
  });

  test("the existing-file check looks where the kernel would", async () => {
    const { repo, companion } = await fixture("mate-tg-dotdot-existing-");
    await fs.mkdir(path.join(repo, "scratch", "deep"), { recursive: true });
    await fs.writeFile(path.join(repo, "scratch", "real.md"), "untracked\n", "utf8");
    await fs.mkdir(path.join(repo, "a"), { recursive: true });
    await fs.symlink(path.join(repo, "scratch", "deep"), path.join(repo, "a", "l"), "dir");
    expect(
      await checkToolCall(write(`${repo}/a/l/../real.md`, "edit"), scopeFor(repo, companion)),
    ).toBeNull();
  });
});

describe("shell targets the reading finds", () => {
  async function shellVerdict(command: string): Promise<string | null> {
    const repo = await makeTempDir("mate-tg-shell2-");
    const companion = await makeTempDir("mate-tg-shell2-companion-");
    git(repo, "init", "-q");
    return (await checkToolCall(shell(command), scopeFor(repo, companion)))?.check ?? null;
  }

  test("a quoted substitution's secret read is refused", async () => {
    expect(await shellVerdict('printf "%s" "$(cat cert.key)"')).toBe("secret");
    expect(await shellVerdict('printf "%s" "`cat cert.key`"')).toBe("secret");
  });

  test('a $"…" target in the companion is the companion', async () => {
    const companion = await makeTempDir("mate-tg-locale-companion-");
    const repo = await makeTempDir("mate-tg-locale-");
    git(repo, "init", "-q");
    const command = `printf x > $"${path.join(companion, "notes.md")}"`;
    expect(await checkToolCall(shell(command), scopeFor(repo, companion))).toBeNull();
  });
});

describe("containment reads `..` only as a whole segment", () => {
  const token = ["ghp", "wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx"].join("_");

  test("a companion file whose name starts with `..` is scanned as a companion file", async () => {
    const { repo, companion } = await fixture("mate-tg-dotdot-name-");
    for (const name of ["..notes.txt", "..notes/file.txt", "ordinary.txt"]) {
      const refusal = await checkToolCall(
        write(path.join(companion, name), "create", `token: ${token}\n`),
        scopeFor(repo, companion),
      );
      expect({ name, check: refusal?.check }).toEqual({ name, check: "secret" });
    }
  });

  test("a tracked Markdown file whose name starts with `..` is product material", async () => {
    const { repo, companion } = await fixture("mate-tg-dotdot-tracked-");
    await fs.writeFile(path.join(repo, "..notes.md"), "x\n", "utf8");
    commitAll(repo);
    expect(
      await checkToolCall(write(path.join(repo, "..notes.md")), scopeFor(repo, companion)),
    ).toBeNull();
  });
});

describe("the Git queries read a path literally", () => {
  test("a new file named like a pattern is not covered by the file it matches", async () => {
    const { repo, companion } = await fixture("mate-tg-literal-");
    await fs.writeFile(path.join(repo, "tracked.md"), "x\n", "utf8");
    await fs.writeFile(path.join(repo, ".gitignore"), "ignored.md\n", "utf8");
    commitAll(repo);
    for (const name of ["*.md", "trac?ed.md", "[t]racked.md", "ign*.md", ":(glob)*.md"]) {
      // oxlint-disable-next-line no-await-in-loop -- one target at a time
      const refusal = await checkToolCall(write(path.join(repo, name)), scopeFor(repo, companion));
      expect({ name, check: refusal?.check }).toEqual({ name, check: "artifact" });
    }
    expect(
      await checkToolCall(write(path.join(repo, "tracked.md")), scopeFor(repo, companion)),
    ).toBeNull();
    expect(
      await checkToolCall(write(path.join(repo, "ignored.md")), scopeFor(repo, companion)),
    ).toBeNull();
  });
});

describe("the Git queries ignore every inherited GIT_ variable", () => {
  test("an inherited GIT_CONFIG_* excludes file does not make a new note look ignored", async () => {
    const { repo, companion } = await fixture("mate-tg-git-config-");
    const elsewhere = await makeTempDir("mate-tg-git-config-excludes-");
    const excludes = path.join(elsewhere, "excludes");
    await fs.writeFile(excludes, "*.md\n", "utf8");
    const injected: Record<string, string> = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.excludesFile",
      GIT_CONFIG_VALUE_0: excludes,
    };
    const previous = Object.fromEntries(
      Object.keys(injected).map((name) => [name, process.env[name]]),
    );
    Object.assign(process.env, injected);
    try {
      const refusal = await checkToolCall(
        write(path.join(repo, "new-note.md")),
        scopeFor(repo, companion),
      );
      expect(refusal?.check).toBe("artifact");
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe("the companion's real path", () => {
  test("is not resolved for a call no check judges by it", async () => {
    const { repo, companion } = await fixture("mate-tg-lazy-");
    const touched: string[] = [];
    const originals = { lstatSync: fsSync.lstatSync, realpathSync: fsSync.realpathSync };
    const record =
      <T extends (...args: never[]) => unknown>(original: T) =>
      (...args: Parameters<T>) => {
        touched.push(String(args[0]));
        return original(...args);
      };
    fsSync.lstatSync = record(originals.lstatSync) as typeof fsSync.lstatSync;
    fsSync.realpathSync = Object.assign(record(originals.realpathSync), {
      native: originals.realpathSync.native,
    }) as typeof fsSync.realpathSync;
    try {
      expect(
        await checkToolCall({ kind: "read", paths: ["src/index.ts"] }, scopeFor(repo, companion)),
      ).toBeNull();
    } finally {
      Object.assign(fsSync, originals);
    }
    expect(touched).not.toContain(companion);
  });
});

function tempFsIgnoresCase(): boolean {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "mate-tg-case-probe-"));
  try {
    fsSync.writeFileSync(path.join(dir, "probe"), "");
    return fsSync.existsSync(path.join(dir, "PROBE"));
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
}

/** Records the paths the secret scan sees; finds nothing. */
function recordingScan(scanned: string[]) {
  return {
    scan: async (filePath: string) => {
      scanned.push(filePath);
      return [];
    },
  };
}

// Skipped on a case-sensitive temp filesystem: there `COMPANION` is another folder.
describe.skipIf(!tempFsIgnoresCase())(
  "filesystem identity ignores letter case where the filesystem does",
  () => {
    test("a companion named in other case is the companion", async () => {
      const { repo, companion } = await fixture("mate-tg-fs-case-");
      const upper = path.join(path.dirname(companion), "COMPANION");
      const scope = scopeFor(repo, companion);

      const scanned: string[] = [];
      expect(
        await checkToolCall(
          write(path.join(upper, "case.txt"), "create", "content"),
          scope,
          recordingScan(scanned),
        ),
      ).toBeNull();
      expect(scanned).toHaveLength(1);
      expect(await checkToolCall(write(path.join(upper, "notes.md")), scope)).toBeNull();
    });

    test("a Working Repository and companion configured in other case are the same folders", async () => {
      const root = await makeTempDir("mate-tg-fs-case-repo-");
      const repo = path.join(root, "Repo");
      const companion = path.join(root, "companion");
      for (const dir of [repo, companion]) await fs.mkdir(dir, { recursive: true });
      git(repo, "init", "-q");
      await fs.writeFile(path.join(repo, ".gitignore"), "scratch/\n", "utf8");
      const scope = scopeFor(path.join(root, "REPO"), path.join(root, "COMPANION"));

      expect(await checkToolCall(write(path.join(repo, "scratch", "n.md")), scope)).toBeNull();
      expect(await checkToolCall(write(path.join(companion, "n.md")), scope)).toBeNull();
      expect((await checkToolCall(write(path.join(repo, "n.md")), scope))?.check).toBe("artifact");
    });

    test("a state root configured in other case still counts", async () => {
      const { repo, companion } = await fixture("mate-tg-fs-case-state-");
      const stateRoot = path.join(await makeTempDir("mate-tg-fs-case-state-root-"), "State");
      await fs.mkdir(stateRoot);
      const configured = path.join(path.dirname(stateRoot), "STATE");
      const scope = scopeFor(repo, companion, { runtimeStateRoots: [configured] });
      expect(await checkToolCall(write(path.join(stateRoot, "plans", "p.md")), scope)).toBeNull();
    });
  },
);

test("a folder name ending in a backslash is not the folder without it", async () => {
  // Bun's realpathSync.native answers `/x/companion` for a missing `/x/companion\`.
  const { repo, companion } = await fixture("mate-tg-backslash-");
  expect(
    (await checkToolCall(write("companion\\/notes.md"), scopeFor(repo, companion)))?.check,
  ).toBe("artifact");
});

describe("a secret file reached through a link", () => {
  async function aliasFixture(prefix: string) {
    const { repo, companion } = await fixture(prefix);
    await fs.writeFile(path.join(repo, "cert.key"), "synthetic key fixture\n", "utf8");
    await fs.symlink("cert.key", path.join(repo, "public.txt"));
    return { repo, companion, scope: scopeFor(repo, companion) };
  }

  test("a read through a link to a secret file is refused, naming both ends", async () => {
    const { repo, scope } = await aliasFixture("mate-tg-alias-read-");
    const refusal = await checkToolCall({ kind: "read", paths: ["public.txt"] }, scope);
    expect(refusal?.check).toBe("secret");
    expect(refusal?.message).toContain(` target: ${path.join(repo, "public.txt")}`);
    expect(refusal?.message).toContain(fsSync.realpathSync(path.join(repo, "cert.key")));
  });

  test("a write and a search through the link are refused too", async () => {
    const { scope } = await aliasFixture("mate-tg-alias-write-");
    expect((await checkToolCall(write("public.txt", "edit", "x"), scope))?.check).toBe("secret");
    expect(
      (await checkToolCall({ kind: "search", paths: ["public.txt"], globs: [""] }, scope))?.check,
    ).toBe("secret");
  });

  test("a dangling link to a secret name is refused: a write would create the secret", async () => {
    const { repo, companion } = await fixture("mate-tg-alias-dangling-");
    await fs.symlink("server.pem", path.join(repo, "out.txt"));
    const refusal = await checkToolCall(write("out.txt", "create", "x"), scopeFor(repo, companion));
    expect(refusal?.check).toBe("secret");
  });

  test("an ordinary link and a missing path stay allowed", async () => {
    const { repo, scope } = await aliasFixture("mate-tg-alias-plain-");
    await fs.writeFile(path.join(repo, "real.txt"), "x\n", "utf8");
    await fs.symlink("real.txt", path.join(repo, "alias.txt"));
    expect(
      await checkToolCall({ kind: "read", paths: ["alias.txt", "nope.txt"] }, scope),
    ).toBeNull();
  });

  test("the shell check stays lexical", async () => {
    const { scope } = await aliasFixture("mate-tg-alias-shell-");
    expect(await checkToolCall(shell("cat public.txt"), scope)).toBeNull();
  });
});

describe("a runtime state root linked into the Working Repository", () => {
  test("a write through it that lands in the Working Repository is judged where it lands", async () => {
    const { repo, companion } = await fixture("mate-tg-state-back-");
    const stateRoot = await makeTempDir("mate-tg-state-back-root-");
    await fs.symlink(repo, path.join(stateRoot, "back"), "dir");
    const scope = scopeFor(repo, companion, { runtimeStateRoots: [stateRoot] });
    expect((await checkToolCall(write(`${stateRoot}/back/new-note.md`), scope))?.check).toBe(
      "artifact",
    );
  });

  test("a link to a folder elsewhere, such as a dotfiles repository, stays state", async () => {
    const { repo, companion } = await fixture("mate-tg-state-dotfiles-");
    const stateRoot = await makeTempDir("mate-tg-state-dotfiles-root-");
    const dotfiles = await makeTempDir("mate-tg-state-dotfiles-repo-");
    git(dotfiles, "init", "-q");
    await fs.symlink(dotfiles, path.join(stateRoot, "skills"), "dir");
    await fs.symlink(path.join(dotfiles, "CLAUDE.md"), path.join(stateRoot, "CLAUDE.md"));
    const scope = scopeFor(repo, companion, { runtimeStateRoots: [stateRoot] });
    expect(await checkToolCall(write(`${stateRoot}/skills/x/SKILL.md`), scope)).toBeNull();
    expect(await checkToolCall(write(`${stateRoot}/CLAUDE.md`), scope)).toBeNull();
  });
});

/** `depth` substitutions, each inside double quotes, then `tail`. */
function nestedCommand(depth: number, tail: string): string {
  let command = "printf x";
  for (let i = 0; i < depth; i++) command = `printf "%s" "$(${command})"`;
  return `${command}; ${tail}`;
}

describe("a command nested too deeply to read is refused", () => {
  test("up to 64 substitution levels are read and judged", async () => {
    const { repo, companion } = await fixture("mate-tg-deep-ok-");
    const scope = scopeFor(repo, companion);
    expect(
      (await checkToolCall(shell(nestedCommand(64, "printf x > notes.md")), scope))?.check,
    ).toBe("artifact");
    let unquoted = "tee notes.md";
    for (let i = 0; i < 63; i++) unquoted = `echo $(${unquoted})`;
    expect((await checkToolCall(shell(unquoted), scope))?.check).toBe("artifact");
  });

  test("a deeper command is refused as unreadable, however it would otherwise be judged", async () => {
    const { repo, companion } = await fixture("mate-tg-deep-");
    const scope = scopeFor(repo, companion);
    for (const command of [
      nestedCommand(65, "printf x > src/a.ts"),
      nestedCommand(5000, "cat cert.key > captured.txt"),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one command at a time
      const refusal = await checkToolCall(shell(command), scope);
      expect(refusal?.check).toBe("unreadable");
      expect(refusal?.message).toContain("more than 64 levels");
    }
    // Backticks nest only through escapes that double per level, so a deep one cannot be built.
    let unquoted = "true";
    for (let i = 0; i < 65; i++) unquoted = `echo $(${unquoted})`;
    expect((await checkToolCall(shell(unquoted), scope))?.check).toBe("unreadable");
  });
});

describe("a path with `link/..` is checked where the kernel reads it", () => {
  /** `forward` leads to `outside/sub`, so `forward/..` is `outside`. */
  async function linkParentFixture(prefix: string) {
    const root = await makeTempDir(prefix);
    const repo = path.join(root, "acme");
    const companion = path.join(root, "companion");
    const outside = path.join(root, "outside");
    for (const dir of [repo, companion, path.join(outside, "sub")]) {
      // oxlint-disable-next-line no-await-in-loop -- fixture setup
      await fs.mkdir(dir, { recursive: true });
    }
    git(repo, "init", "-q");
    await fs.symlink(path.join(outside, "sub"), path.join(repo, "forward"));
    await fs.writeFile(path.join(outside, "cert.key"), "synthetic sentinel", "utf8");
    await fs.symlink("cert.key", path.join(outside, "innocent.txt"));
    return { repo, companion, outside, scope: scopeFor(repo, companion) };
  }

  test("a read, a search and a write that reach a secret through it are refused", async () => {
    const { repo, outside, scope } = await linkParentFixture("mate-tg-link-parent-");
    const named = "forward/../innocent.txt";
    for (const call of [
      { kind: "read", paths: [named] },
      { kind: "search", paths: [named], globs: [""] },
      write(named, "create", ""),
      { kind: "read", paths: [`${path.join(repo, "forward")}/../innocent.txt`] },
    ] as GuardedToolCall[]) {
      // oxlint-disable-next-line no-await-in-loop -- one call at a time
      const refusal = await checkToolCall(call, scope);
      expect(refusal?.check).toBe("secret");
      expect(refusal?.message).toContain(` target: ${path.join(repo, "innocent.txt")}`);
      expect(refusal?.message).toContain(fsSync.realpathSync(path.join(outside, "cert.key")));
    }
  });

  test("the normalised path existing does not stand in for the written one", async () => {
    const { repo, scope } = await linkParentFixture("mate-tg-link-parent-plain-");
    // `acme/innocent.txt` exists and is harmless; `forward/../innocent.txt` is the key.
    await fs.writeFile(path.join(repo, "innocent.txt"), "plain\n", "utf8");
    expect(
      (await checkToolCall({ kind: "read", paths: ["forward/../innocent.txt"] }, scope))?.check,
    ).toBe("secret");
    expect(await checkToolCall({ kind: "read", paths: ["innocent.txt"] }, scope)).toBeNull();
  });
});

describe("a companion configured through `link/..` is read where it lands", () => {
  /**
   * `forward` leads to `outside/sub`, so the configured
   * `forward/../companion` is `outside/companion`. A decoy sits at the
   * normalised `companion`, which the kernel never reaches.
   */
  async function configuredThroughLink(prefix: string) {
    const root = await makeTempDir(prefix);
    const repo = path.join(root, "acme");
    const real = path.join(root, "outside", "companion");
    const decoy = path.join(root, "companion");
    for (const dir of [
      repo,
      path.join(real, ".mate", "config"),
      path.join(root, "outside", "sub"),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- fixture setup
      await fs.mkdir(dir, { recursive: true });
    }
    git(repo, "init", "-q");
    await fs.symlink(path.join(root, "outside", "sub"), path.join(root, "forward"));
    await fs.writeFile(
      path.join(real, ".mate", "config", "framework.yaml"),
      'secrets:\n  deny: ["private.txt"]\n',
      "utf8",
    );
    await fs.writeFile(path.join(repo, "private.txt"), "synthetic private content\n", "utf8");
    await fs.writeFile(path.join(repo, "cert.key"), "synthetic key fixture\n", "utf8");
    const configured = `${path.join(root, "forward")}/../companion`;
    return { repo, real, decoy, configured, scope: scopeFor(repo, configured) };
  }

  async function writeDecoy(decoy: string, config: string): Promise<void> {
    await fs.mkdir(path.join(decoy, ".mate", "config"), { recursive: true });
    await fs.writeFile(path.join(decoy, ".mate", "config", "framework.yaml"), config, "utf8");
  }

  test("the real companion's deny rule applies", async () => {
    const { scope } = await configuredThroughLink("mate-tg-policy-link-deny-");
    for (const call of [
      { kind: "read", paths: ["private.txt"] },
      shell("cat private.txt"),
    ] as GuardedToolCall[]) {
      // oxlint-disable-next-line no-await-in-loop -- one call at a time
      expect((await checkToolCall(call, scope))?.check).toBe("secret");
    }
  });

  test("a decoy config at the normalised path does not turn the guard off", async () => {
    const { decoy, scope } = await configuredThroughLink("mate-tg-policy-link-decoy-");
    await writeDecoy(decoy, "secrets:\n  guardrails: false\n");
    expect((await checkToolCall({ kind: "read", paths: ["cert.key"] }, scope))?.check).toBe(
      "secret",
    );
    expect((await checkToolCall({ kind: "read", paths: ["private.txt"] }, scope))?.check).toBe(
      "secret",
    );
  });

  test("an artifact refusal suggests the real companion, not the decoy", async () => {
    const { real, decoy, scope } = await configuredThroughLink("mate-tg-policy-link-suggest-");
    await writeDecoy(decoy, "capabilities: []\n");
    const refusal = await checkToolCall(write("notes.md"), scope);
    expect(refusal?.check).toBe("artifact");
    expect(refusal?.message).toContain(path.join(fsSync.realpathSync(real), "notes.md"));
    expect(refusal?.message).not.toContain(path.join(decoy, "notes.md"));
  });
});

describe("a file moved into the companion is scanned as it will land", () => {
  const GITHUB_TOKEN = ["ghp", "wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx"].join("_");
  const move = (source: string, destination: string, added: string): GuardedToolCall => ({
    kind: "write",
    writes: [
      { path: source, content: "", mode: "edit" },
      { path: destination, content: added, mode: "create", movedFrom: source },
    ],
  });

  test("the source's content counts, with its secretlint directives ignored", async () => {
    const { repo, companion } = await fixture("mate-tg-move-disable-");
    await fs.writeFile(path.join(repo, "disabled.txt"), "// secretlint-disable\nold\n", "utf8");
    await fs.writeFile(path.join(repo, "kept.txt"), `token: ${GITHUB_TOKEN}\nold\n`, "utf8");
    const scope = scopeFor(repo, companion);

    const added = await checkToolCall(
      move("disabled.txt", path.join(companion, "active.txt"), `token: ${GITHUB_TOKEN}`),
      scope,
    );
    expect(added?.check).toBe("secret");
    expect(added?.message).toContain("@secretlint/secretlint-rule-github");
    expect(added?.message).not.toContain(GITHUB_TOKEN);
    expect(
      (await checkToolCall(move("kept.txt", path.join(companion, "kept.txt"), "new"), scope))
        ?.check,
    ).toBe("secret");
    for (const directive of [
      "<!-- secretlint-disable -->",
      "# secretlint-disable-line",
      "/* secretlint-disable-next-line */",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one directive at a time
      await fs.writeFile(
        path.join(repo, "fake.txt"),
        `${directive}\ntoken: ${GITHUB_TOKEN}\n<!-- secretlint-enable -->\n`,
        "utf8",
      );
      // oxlint-disable-next-line no-await-in-loop -- one directive at a time
      const refusal = await checkToolCall(
        move("fake.txt", path.join(companion, "f.txt"), ""),
        scope,
      );
      expect(refusal?.check).toBe("secret");
      expect(refusal?.message).toContain("secretlint-disable comments do not apply");
    }
  });

  test("a direct companion write keeps honouring secretlint directives", async () => {
    const { repo, companion } = await fixture("mate-tg-move-direct-");
    const content = `// secretlint-disable\ntoken: ${GITHUB_TOKEN}\n// secretlint-enable\n`;
    expect(
      await checkToolCall(
        write(path.join(companion, "fake.txt"), "create", content),
        scopeFor(repo, companion),
      ),
    ).toBeNull();
  });

  test("a source that cannot be fully read blocks the move into the companion", async () => {
    const { repo, companion } = await fixture("mate-tg-move-unreadable-");
    await fs.mkdir(path.join(repo, "folder"));
    await fs.writeFile(path.join(repo, "large.txt"), "x".repeat(1024 * 1024 + 1), "utf8");
    spawnSync("mkfifo", [path.join(repo, "pipe")]);
    const scope = scopeFor(repo, companion);
    for (const source of ["missing.txt", "folder", "large.txt", "pipe"]) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      const refusal = await checkToolCall(
        move(source, path.join(companion, "m.txt"), "new"),
        scope,
      );
      expect(refusal?.check).toBe("secret");
      expect(refusal?.message).toContain("could not be checked for secrets");
    }
    // The same move into product code is not scanned, so its source is never read.
    expect(
      await checkToolCall(move("missing.txt", path.join(repo, "src", "m.txt"), ""), scope),
    ).toBeNull();
  });

  test("the source is read where the kernel reads it, through `link/..`", async () => {
    const root = await makeTempDir("mate-tg-move-link-parent-");
    const repo = path.join(root, "acme");
    const companion = path.join(root, "companion");
    const outside = path.join(root, "outside");
    for (const dir of [repo, companion, path.join(outside, "sub")]) {
      // oxlint-disable-next-line no-await-in-loop -- fixture setup
      await fs.mkdir(dir, { recursive: true });
    }
    git(repo, "init", "-q");
    await fs.symlink(path.join(outside, "sub"), path.join(repo, "forward"));
    await fs.writeFile(path.join(outside, "only-outside.txt"), `token: ${GITHUB_TOKEN}\nold\n`);
    expect(
      (
        await checkToolCall(
          move("forward/../only-outside.txt", path.join(companion, "moved.txt"), "new"),
          scopeFor(repo, companion),
        )
      )?.check,
    ).toBe("secret");
  });
});

describe("shell comments", () => {
  async function verdict(command: string): Promise<string | null> {
    const { repo, companion } = await fixture("mate-tg-comment-");
    return (await checkToolCall(shell(command), scopeFor(repo, companion)))?.check ?? null;
  }

  test("decided: a secret file named only in a comment is refused, the secret check errs toward refusing", async () => {
    expect(await verdict("git status # leave server.key alone")).toBe("secret");
    expect(await verdict("git status #server.key")).toBe("secret");
    expect(await verdict("echo $(git status # server.key\n)")).toBe("secret");
    expect(await verdict("git status # nothing secret")).toBeNull();
    expect(await verdict("echo hi # note\ncat .env")).toBe("secret");
    expect(await verdict("cat x#y .env")).toBe("secret");
    expect(await verdict('echo "#" .env')).toBe("secret");
    expect(await verdict("echo '#' server.key")).toBe("secret");
  });
});

// Skipped on a case-sensitive temp filesystem: there `STATE` is another folder.
describe.skipIf(!tempFsIgnoresCase())("a state root written in other letter case", () => {
  test("a link inside it still counts as state, as with the on-disk spelling", async () => {
    const { repo, companion } = await fixture("mate-tg-state-case-");
    const parent = await makeTempDir("mate-tg-state-case-root-");
    const stateRoot = path.join(parent, "state");
    const outside = await makeTempDir("mate-tg-state-case-outside-");
    await fs.mkdir(stateRoot);
    await fs.symlink(outside, path.join(stateRoot, "dotfiles"), "dir");
    const scope = scopeFor(repo, companion, { runtimeStateRoots: [stateRoot] });

    expect(
      await checkToolCall(write(path.join(stateRoot, "dotfiles", "case-note.md")), scope),
    ).toBeNull();
    expect(
      await checkToolCall(write(path.join(parent, "STATE", "dotfiles", "case-note.md")), scope),
    ).toBeNull();
    // A sibling folder that only shares a prefix is not the root.
    await fs.mkdir(path.join(parent, "STATE-old"));
    expect((await checkToolCall(write(path.join(parent, "STATE-old", "n.md")), scope))?.check).toBe(
      "artifact",
    );
  });

  test("written in other case, a write that lands in the Working Repository is still judged", async () => {
    const { repo, companion } = await fixture("mate-tg-state-case-back-");
    const parent = await makeTempDir("mate-tg-state-case-back-root-");
    const stateRoot = path.join(parent, "state");
    await fs.mkdir(stateRoot);
    await fs.symlink(repo, path.join(stateRoot, "back"), "dir");
    const scope = scopeFor(repo, companion, { runtimeStateRoots: [stateRoot] });
    expect(
      (await checkToolCall(write(path.join(parent, "STATE", "back", "n.md")), scope))?.check,
    ).toBe("artifact");
  });
});
