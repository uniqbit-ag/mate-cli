import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

import { createTempDir, withEnv } from "../../../../test/fixtures";
import { guardToolInput, patchWrites, registerCompanionHooks } from "./companion-hooks";
import { readContext, type CompanionContext } from "./companion-policy";
import { ARTIFACT_REFUSAL_HEADLINE } from "../runtime/artifact-refusal";
import { MATE_ENV } from "../runtime/env-names";
import { writeProjectionPair } from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";
const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await createTempDir(prefix);
  tempRoots.push(dir);
  return dir;
}

/** Every launch variable cleared: `hasLaunchEnvironment` counts any of them as a launch. */
function noLaunchEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(Object.values(MATE_ENV).map((name) => [name, undefined]));
}

async function wrapRepo(repoRoot: string, companionPath: string): Promise<void> {
  const registryPath = repoLocalRegistryPath(repoRoot);
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, "companions: []\n", "utf8");
  writeProjectionPair(repoRoot, {
    stamp: "deadbeef",
    projection: {
      version: "0.0.0",
      companionPath,
      repositoryPath: repoRoot,
      repositoryId: "acme",
      wrapperBinPath: path.join(companionPath, "wrappers", "bin"),
      reactDoctorBinPath: path.join(companionPath, "react-doctor"),
      graphifyOut: path.join(companionPath, ".graphify", "acme", "graphify-out"),
    },
  });
}

type Hook = (event: Record<string, unknown>) => unknown;

/** Records registered hooks; the event stream never yields. */
function fakeApi(directory: string) {
  const hooks = new Map<string, Hook>();
  const register =
    (domain: string) =>
    async (name: string, callback: Hook): Promise<void> => {
      hooks.set(`${domain}.${name}`, callback);
    };
  const api = {
    location: { directory },
    tool: { hook: register("tool") },
    session: { prompt: mock(async () => undefined) },
    event: {
      subscribe: async function* () {
        await new Promise(() => {});
      },
    },
  };
  return { api: api as never, hooks };
}

function launchContext(
  companion: string,
  repo: string | undefined,
  extra: Record<string, string> = {},
): Promise<CompanionContext> {
  return withEnv(
    {
      ...noLaunchEnvironment(),
      MATE_ARTIFACT_PATH: companion,
      MATE_REPO_PATH: repo,
      MATE_REPO_ID: repo ? "acme" : undefined,
      MATE_POLICY_JSON: "{}",
      MATE_GIT_AUTO_MODE: "0",
      ...extra,
    },
    async () => readContext(process.env, repo ?? companion),
  );
}

async function setupRepoFixture(prefix: string) {
  const root = await makeTempDir(prefix);
  const repo = path.join(root, "repo");
  const companion = path.join(root, "companion");
  await fs.mkdir(repo, { recursive: true });
  await fs.mkdir(companion, { recursive: true });
  spawnSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  return { repo, companion };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("OpenCode companion hooks without a launch", () => {
  test("activates from a projection and blocks an artifact write", async () => {
    const repo = await makeTempDir("mate-hooks-wrapped-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await wrapRepo(repo, companion);

    const context = readContext(noLaunchEnvironment(), repo);
    expect(context.companionPath).toBe(companion);
    await expect(
      guardToolInput(context, "write", { filePath: path.join(repo, "design.md") }),
    ).rejects.toThrow(ARTIFACT_REFUSAL_HEADLINE);
  });

  test("resolves no companion when neither the environment nor a projection does", async () => {
    const repo = await makeTempDir("mate-hooks-unwrapped-");

    expect(readContext(noLaunchEnvironment(), repo).companionPath).toBe("");
  });

  test("registers only the guard without a working repository", async () => {
    const companion = await makeTempDir("mate-hooks-companion-only-");
    const context = await launchContext(companion, undefined, { MATE_REACT_DOCTOR_ENABLED: "1" });
    const { api, hooks } = fakeApi(companion);

    expect(await registerCompanionHooks(api, context)).toBeUndefined();
    expect([...hooks.keys()]).toEqual(["tool.execute.before"]);
  });
});

describe("OpenCode companion hooks", () => {
  for (const enabled of ["1", "0"]) {
    test(`registers only the guard (MATE_REACT_DOCTOR_ENABLED=${enabled})`, async () => {
      const { repo, companion } = await setupRepoFixture("mate-opencode-register-");
      const context = await launchContext(companion, repo, { MATE_REACT_DOCTOR_ENABLED: enabled });
      const { api, hooks } = fakeApi(repo);

      expect(await registerCompanionHooks(api, context)).toBeUndefined();
      expect([...hooks.keys()]).toEqual(["tool.execute.before"]);
    });
  }

  test("the registered guard rejects an artifact write", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-before-hook-");
    const context = await launchContext(companion, repo);
    const { api, hooks } = fakeApi(repo);
    await registerCompanionHooks(api, context);

    await expect(
      hooks.get("tool.execute.before")!({
        tool: "write",
        sessionID: "s",
        input: { filePath: path.join(repo, "spec.md") },
      }),
    ).rejects.toThrow("guardrail");
  });

  test("blocks artifact writes and allows source writes", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-before-");
    const context = await launchContext(companion, repo);

    await expect(
      guardToolInput(context, "write", { filePath: path.join(repo, "spec.md") }),
    ).rejects.toThrow("guardrail");
    await expect(
      guardToolInput(context, "write", { filePath: path.join(repo, "src", "main.ts") }),
    ).resolves.toBeUndefined();
  });

  test("blocks artifact paths in apply_patch", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-patch-");
    const context = await launchContext(companion, repo);

    await expect(
      guardToolInput(context, "apply_patch", { patchText: "*** Add File: spec.md\ncontent" }),
    ).rejects.toThrow("guardrail");
    await expect(
      guardToolInput(context, "apply_patch", { patchText: "*** Add File: src/main.ts\ncontent" }),
    ).resolves.toBeUndefined();
  });

  test("names the resolution of a relative apply_patch path", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-patch-relative-");
    const context = await launchContext(companion, repo);

    const refusal = await guardToolInput(context, "apply_patch", {
      patchText: "*** Add File: notes/x.md\ncontent",
    }).then(
      () => "",
      (error: Error) => error.message,
    );
    expect(refusal).toContain(` resolved:  ${path.join(repo, "notes", "x.md")}`);
    expect(refusal).toContain(` suggested: ${path.join(companion, "notes", "x.md")}`);
  });

  test("allows gitignored artifact writes", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-gitignore-");
    await fs.writeFile(path.join(repo, ".gitignore"), "local-notes.md\n", "utf8");
    const context = await launchContext(companion, repo);

    await expect(
      guardToolInput(context, "write", { filePath: path.join(repo, "local-notes.md") }),
    ).resolves.toBeUndefined();
  });

  test("ignores tools that write nothing", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-read-");
    const context = await launchContext(companion, repo);

    await expect(
      guardToolInput(context, "read", { filePath: path.join(repo, "spec.md") }),
    ).resolves.toBeUndefined();
    await expect(guardToolInput(context, "bash", undefined)).resolves.toBeUndefined();
  });

  test("judges a malformed path or command rather than nothing", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-malformed-");
    const context = await launchContext(companion, repo);

    await expect(guardToolInput(context, "write", { filePath: ["notes.md"] })).rejects.toThrow(
      ARTIFACT_REFUSAL_HEADLINE,
    );
    await expect(guardToolInput(context, "read", { filePath: [".env"] })).rejects.toThrow(
      "secret files are off-limits",
    );
    await expect(guardToolInput(context, "bash", { command: ["cat .env"] })).rejects.toThrow(
      "secret files are off-limits",
    );
    await expect(guardToolInput(context, "write", { filePath: null })).resolves.toBeUndefined();
  });
});

describe("patchWrites reads a patch as OpenCode does", () => {
  const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

  test("a moved file is an edit of its source and a create of its destination", () => {
    expect(
      patchWrites(patch("*** Update File: a.ts", "*** Move to: b.md", "@@", "-x", "+y")),
    ).toEqual([
      { path: "a.ts", content: "", mode: "edit" },
      { path: "b.md", content: "y", mode: "create" },
    ]);
  });

  test("a context line that looks like a header stays in its section", () => {
    expect(
      patchWrites(
        patch("*** Update File: /c/notes.md", "@@", " *** Update File: src/main.ts", "+token"),
      ),
    ).toEqual([{ path: "/c/notes.md", content: "token", mode: "edit" }]);
  });

  test("an added line that looks like a header stays in its section", () => {
    expect(patchWrites(patch("*** Add File: a.md", "+*** Delete File: b.ts", "+x"))).toEqual([
      { path: "a.md", content: "*** Delete File: b.ts\nx", mode: "create" },
    ]);
  });

  test("a move directive counts only right after its Update File line", () => {
    expect(
      patchWrites(patch("*** Update File: a.ts", "@@", "-x", "*** Move to: b.md", "+y")),
    ).toEqual([{ path: "a.ts", content: "y", mode: "edit" }]);
    expect(
      patchWrites(patch("*** Update File: a.ts", "*** End of File", "*** Move to: b.md", "@@")),
    ).toEqual([
      { path: "a.ts", content: "", mode: "edit" },
      { path: "b.md", content: "", mode: "create" },
    ]);
  });

  test("several sections, with the envelope and an environment line", () => {
    expect(
      patchWrites(
        [
          "  *** Begin Patch",
          "*** Environment ID: dev",
          "*** Add File: a.md",
          "+a",
          "   *** Delete File: b.md  ",
          "*** Update File: c.ts",
          "@@ fn",
          " ctx",
          "+c",
          "*** End of File",
          "*** End Patch",
        ].join("\n"),
      ),
    ).toEqual([
      { path: "a.md", content: "a", mode: "create" },
      { path: "b.md", content: "", mode: "edit" },
      { path: "c.ts", content: "c", mode: "edit" },
    ]);
  });

  test("a patch wrapped in a heredoc is read inside it", () => {
    expect(patchWrites(`cat <<'EOF'\n${patch("*** Add File: a.md", "+a")}\nEOF`)).toEqual([
      { path: "a.md", content: "a", mode: "create" },
    ]);
  });
});

describe("OpenCode reaches the Tool Guard's verdict", () => {
  const refusalOf = (pending: Promise<void>) =>
    pending.then(
      () => "",
      (error: Error) => error.message,
    );

  test("refuses a bash redirect into a Markdown file of the working repository", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-redirect-");
    const context = await launchContext(companion, repo);

    await expect(
      guardToolInput(context, "bash", { command: "cat > notes/handoff.md <<'EOF'\nx\nEOF" }),
    ).rejects.toThrow(ARTIFACT_REFUSAL_HEADLINE);
    await expect(
      guardToolInput(context, "bash", { command: "echo ok > build.log" }),
    ).resolves.toBeUndefined();
  });

  test("allows an edit of a Markdown file the working repository tracks", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-tracked-");
    await fs.writeFile(path.join(repo, "guide.md"), "# Guide\n", "utf8");
    spawnSync("git", ["add", "guide.md"], { cwd: repo, stdio: "ignore" });
    const context = await launchContext(companion, repo);

    await expect(
      guardToolInput(context, "edit", { filePath: path.join(repo, "guide.md"), newString: "x" }),
    ).resolves.toBeUndefined();
  });

  test("allows a patch that updates or deletes an existing untracked file", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-patch-existing-");
    await fs.writeFile(path.join(repo, "notes.md"), "old\n", "utf8");
    const context = await launchContext(companion, repo);

    await expect(
      guardToolInput(context, "apply_patch", {
        patchText: "*** Update File: notes.md\n@@\n-old\n+new",
      }),
    ).resolves.toBeUndefined();
    await expect(
      guardToolInput(context, "apply_patch", { patchText: "*** Delete File: notes.md" }),
    ).resolves.toBeUndefined();
  });

  test("judges a patch move at its destination, as a new file", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-patch-move-");
    await fs.writeFile(path.join(repo, "draft.ts"), "x\n", "utf8");
    const context = await launchContext(companion, repo);

    const refusal = await refusalOf(
      guardToolInput(context, "apply_patch", {
        patchText: "*** Update File: draft.ts\n*** Move to: notes/plan.md\n@@\n-x\n+y",
      }),
    );
    expect(refusal).toContain(ARTIFACT_REFUSAL_HEADLINE);
    expect(refusal).toContain(` resolved:  ${path.join(repo, "notes", "plan.md")}`);
  });

  test("judges a patch move at its source too", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-patch-move-source-");
    await fs.mkdir(path.join(repo, "certs"), { recursive: true });
    await fs.writeFile(path.join(repo, "certs", "server.key"), "x\n", "utf8");
    const context = await launchContext(companion, repo);

    await expect(
      guardToolInput(context, "apply_patch", {
        patchText:
          "*** Begin Patch\n*** Update File: certs/server.key\n*** Move to: public.txt\n@@\n-x\n+x\n*** End Patch",
      }),
    ).rejects.toThrow("secret files are off-limits");
  });

  test("a hunk's context line is content, never a section header", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-patch-context-");
    const GITHUB_TOKEN = ["ghp", "wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx"].join("_");
    const notes = path.join(companion, "notes.md");
    await fs.writeFile(notes, "*** Update File: src/main.ts\n", "utf8");
    const context = await launchContext(companion, repo);

    await expect(
      guardToolInput(context, "apply_patch", {
        patchText: `*** Begin Patch\n*** Update File: ${notes}\n@@\n *** Update File: src/main.ts\n+token: ${GITHUB_TOKEN}\n*** End Patch`,
      }),
    ).rejects.toThrow("@secretlint/secretlint-rule-github");
  });

  test("refuses a write to a sibling folder whose name starts with the companion's", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-sibling-");
    const context = await launchContext(companion, repo);

    await expect(
      guardToolInput(context, "write", { filePath: `${companion}-old/notes.md`, content: "x" }),
    ).rejects.toThrow(ARTIFACT_REFUSAL_HEADLINE);
  });

  test("allows writes to OpenCode's own configuration folders", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-state-");
    const configured = await makeTempDir("mate-opencode-config-dir-");
    const xdg = await makeTempDir("mate-opencode-xdg-");
    const context = await launchContext(companion, repo);
    const env = { ...process.env, OPENCODE_CONFIG_DIR: configured, XDG_CONFIG_HOME: xdg };

    for (const filePath of [
      path.join(configured, "plans", "next.md"),
      path.join(xdg, "opencode", "plans", "next.md"),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one target per assertion
      await expect(guardToolInput(context, "write", { filePath }, env)).resolves.toBeUndefined();
    }
    await expect(
      guardToolInput(context, "write", { filePath: path.join(xdg, "plans", "next.md") }, env),
    ).rejects.toThrow(ARTIFACT_REFUSAL_HEADLINE);
  });
});

describe("OpenCode commit-attribution guard", () => {
  test("refuses a bash commit with a model co-author trailer, after the secret check", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-attribution-");
    const context = await launchContext(companion, repo);
    const trailer = "Co-Authored-By: Claude <noreply@anthropic.com>";

    await expect(
      guardToolInput(context, "bash", { command: `git commit -m "x" -m "${trailer}"` }),
    ).rejects.toThrow("No commit was created");
    await expect(
      guardToolInput(context, "bash", { command: `git commit -m "${trailer}" && cat .env` }),
    ).rejects.toThrow("secret files are off-limits");
    await expect(
      guardToolInput(context, "bash", {
        command: `git commit -m "Co-Authored-By: Jane <jane@acme.example>"`,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("OpenCode secret guardrails", () => {
  const GITHUB_TOKEN = ["ghp", "wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx"].join("_");

  async function guarded() {
    const { repo, companion } = await setupRepoFixture("mate-opencode-secrets-");
    return { repo, companion, context: await launchContext(companion, repo) };
  }

  test("refuses read and edit of secret files, and lets the example through", async () => {
    const { repo, context } = await guarded();
    await expect(
      guardToolInput(context, "read", { filePath: path.join(repo, ".env") }),
    ).rejects.toThrow("secret files are off-limits");
    await expect(
      guardToolInput(context, "edit", { filePath: "certs/server.key", newString: "x" }),
    ).rejects.toThrow("certs/server.key");
    await expect(
      guardToolInput(context, "read", { filePath: path.join(repo, ".env.example") }),
    ).resolves.toBeUndefined();
  });

  test("refuses a differently-cased secret file", async () => {
    const { repo, context } = await guarded();
    await expect(
      guardToolInput(context, "read", { filePath: path.join(repo, ".Env") }),
    ).rejects.toThrow("secret files are off-limits");
  });

  test("refuses bash commands naming a secret file", async () => {
    const { context } = await guarded();
    await expect(guardToolInput(context, "bash", { command: "source .env" })).rejects.toThrow(
      "secret files are off-limits",
    );
    await expect(
      guardToolInput(context, "bash", { command: "cat .env.example" }),
    ).resolves.toBeUndefined();
  });

  test("refuses a grep in a secret file or aimed at secret files", async () => {
    const { repo, context } = await guarded();
    await expect(
      guardToolInput(context, "grep", { pattern: "KEY", path: path.join(repo, ".env") }),
    ).rejects.toThrow("secret files are off-limits");
    await expect(
      guardToolInput(context, "grep", { pattern: "KEY", path: repo, include: "*.pem" }),
    ).rejects.toThrow("*.pem");
    await expect(
      guardToolInput(context, "grep", { pattern: "KEY", path: repo, include: "*.ts" }),
    ).resolves.toBeUndefined();
  });

  test("refuses a patch that adds a secret file", async () => {
    const { context } = await guarded();
    await expect(
      guardToolInput(context, "apply_patch", { patchText: "*** Add File: .env.local\n+KEY=1" }),
    ).rejects.toThrow(".env.local");
  });

  test("scans companion writes and patches, never echoing the value", async () => {
    const { companion, context } = await guarded();
    const target = path.join(companion, "notes", "design.md");
    const write = guardToolInput(context, "write", {
      filePath: target,
      content: `token: ${GITHUB_TOKEN}\n`,
    });
    await expect(write).rejects.toThrow("@secretlint/secretlint-rule-github");
    await write.catch((error: Error) => expect(error.message).not.toContain(GITHUB_TOKEN));

    await expect(
      guardToolInput(context, "apply_patch", {
        patchText: `*** Update File: ${target}\n@@\n-old\n+token: ${GITHUB_TOKEN}`,
      }),
    ).rejects.toThrow("@secretlint/secretlint-rule-github");
  });

  test("does not scan product code writes", async () => {
    const { repo, context } = await guarded();
    await expect(
      guardToolInput(context, "write", {
        filePath: path.join(repo, "src", "main.ts"),
        content: GITHUB_TOKEN,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("a patch move scans what the moved file will hold", () => {
  const GITHUB_TOKEN = ["ghp", "wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx"].join("_");
  const movePatch = (source: string, destination: string) =>
    `*** Begin Patch\n*** Update File: ${source}\n*** Move to: ${destination}\n@@\n token: ${GITHUB_TOKEN}\n-old\n+new\n*** End Patch`;

  test("a secret kept as a context line is refused at a companion destination", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-move-content-");
    await fs.writeFile(path.join(repo, "source.txt"), `token: ${GITHUB_TOKEN}\nold\n`, "utf8");
    const context = await launchContext(companion, repo);

    await expect(
      guardToolInput(context, "apply_patch", {
        patchText: movePatch("source.txt", path.join(companion, "moved.txt")),
      }),
    ).rejects.toThrow("@secretlint/secretlint-rule-github");
  });

  test("the same move to product code is not scanned", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-move-product-");
    await fs.writeFile(path.join(repo, "source.txt"), `token: ${GITHUB_TOKEN}\nold\n`, "utf8");
    const context = await launchContext(companion, repo);

    await expect(
      guardToolInput(context, "apply_patch", {
        patchText: movePatch("source.txt", path.join(repo, "src", "moved.txt")),
      }),
    ).resolves.toBeUndefined();
  });

  test("a move into the companion whose source cannot be read is refused", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-move-missing-");
    await fs.mkdir(path.join(repo, "folder"), { recursive: true });
    const context = await launchContext(companion, repo);

    for (const source of ["missing.txt", "folder"]) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await expect(
        guardToolInput(context, "apply_patch", {
          patchText: movePatch(source, path.join(companion, "moved.txt")),
        }),
      ).rejects.toThrow("could not be checked for secrets");
    }
  });

  test("secretlint directives the move removes from the source cannot hide an added token", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-move-disable-");
    await fs.writeFile(path.join(repo, "disabled.txt"), "// secretlint-disable\nold\n", "utf8");
    const context = await launchContext(companion, repo);

    await expect(
      guardToolInput(context, "apply_patch", {
        patchText: `*** Begin Patch\n*** Update File: disabled.txt\n*** Move to: ${path.join(companion, "active.txt")}\n@@\n-// secretlint-disable\n-old\n+token: ${GITHUB_TOKEN}\n*** End Patch`,
      }),
    ).rejects.toThrow("@secretlint/secretlint-rule-github");
  });

  test("an earlier section's added lines count for the file it moves", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-move-prior-");
    await fs.writeFile(path.join(repo, "prior-update.txt"), "old\n", "utf8");
    const context = await launchContext(companion, repo);

    await expect(
      guardToolInput(context, "apply_patch", {
        patchText: `*** Begin Patch\n*** Update File: prior-update.txt\n@@\n-old\n+token: ${GITHUB_TOKEN}\n*** Update File: prior-update.txt\n*** Move to: ${path.join(companion, "updated.txt")}\n@@\n token: ${GITHUB_TOKEN}\n+new\n*** End Patch`,
      }),
    ).rejects.toThrow("@secretlint/secretlint-rule-github");
    // So do a later section's lines for the destination, and sections that spell the file otherwise.
    await expect(
      guardToolInput(context, "apply_patch", {
        patchText: `*** Begin Patch\n*** Update File: ./prior-update.txt\n@@\n-old\n+token: ${GITHUB_TOKEN}\n*** Update File: prior-update.txt\n*** Move to: ${path.join(companion, "updated.txt")}\n@@\n-old\n+new\n*** End Patch`,
      }),
    ).rejects.toThrow("@secretlint/secretlint-rule-github");
    await expect(
      guardToolInput(context, "apply_patch", {
        patchText: `*** Begin Patch\n*** Update File: prior-update.txt\n*** Move to: ${path.join(companion, "updated.txt")}\n@@\n-old\n+new\n*** Update File: ${path.join(companion, "updated.txt")}\n@@\n-new\n+token: ${GITHUB_TOKEN}\n*** End Patch`,
      }),
    ).rejects.toThrow("@secretlint/secretlint-rule-github");
  });
});

describe("OpenCode fails closed when the guard itself fails", () => {
  test("an unexpected error blocks the call with a message that says so", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-guard-error-");
    const context = await launchContext(companion, repo);

    const failure = guardToolInput(context, "write", { filePath: "no\u0000tes.md", content: "x" });
    await expect(failure).rejects.toThrow(/^Mate guardrail could not check this call: /);
  });
});
