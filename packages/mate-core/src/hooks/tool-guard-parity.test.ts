// Claude hook and OpenCode middleware must reach the same Tool Guard verdict.
// Forked-companion cases live in `artifact-path-fork.test.ts` with their Git fixture.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { guardToolInput } from "../opencode/companion-hooks";
import { readContext } from "../opencode/companion-policy";
import { ARTIFACT_REFUSAL_HEADLINE } from "../runtime/artifact-refusal";
import { writeProjectionPair } from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";
import { evaluate } from "./validate-artifact-path";

interface Fixture {
  root: string;
  repo: string;
  companion: string;
  env: Record<string, string | undefined>;
}

let fixture: Fixture;

/** A wrapped Working Repository and no launch environment: both adapters resolve the projection. */
beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-tool-guard-parity-"));
  const repo = path.join(root, "repo");
  const companion = path.join(root, "companion");
  const home = path.join(root, "home");
  await Promise.all([repo, companion, home].map((dir) => fs.mkdir(dir, { recursive: true })));
  spawnSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
  await fs.writeFile(path.join(repo, "notes.md"), "old\n", "utf8");

  const registryPath = repoLocalRegistryPath(repo);
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, "companions: []\n", "utf8");
  writeProjectionPair(repo, {
    stamp: "deadbeef",
    projection: {
      version: "0.0.0",
      companionPath: companion,
      repositoryPath: repo,
      repositoryId: "acme",
      wrapperBinPath: path.join(companion, "wrappers", "bin"),
      reactDoctorBinPath: path.join(companion, "react-doctor"),
      graphifyOut: path.join(companion, ".graphify", "acme", "graphify-out"),
    },
  });
  fixture = { root, repo, companion, env: { HOME: home } };
});

afterAll(async () => {
  await fs.rm(fixture.root, { recursive: true, force: true });
});

/** Each runtime's refusal as text, empty when it allows the call. */
async function verdicts(
  claude: { tool_name: string; tool_input: Record<string, unknown> },
  openCode: { tool: string; input: Record<string, unknown> },
): Promise<{ claude: string; openCode: string }> {
  const claudeOutcome = await evaluate(claude, fixture.env, fixture.repo);
  const openCodeMessage = await guardToolInput(
    readContext(fixture.env, fixture.repo),
    openCode.tool,
    openCode.input,
    fixture.env,
  ).then(
    () => "",
    (error: Error) => `${error.message}\n`,
  );
  return { claude: claudeOutcome.stderr, openCode: openCodeMessage };
}

const TRAILER = "Co-Authored-By: Claude <noreply@anthropic.com>";

/** An ANSI-C string with an escaped quote, then a Markdown redirect on the next line. */
const ansiThenRedirect = "printf %s $'it\\'s'\nprintf x > plan.md";

const cases: {
  name: string;
  claude: () => { tool_name: string; tool_input: Record<string, unknown> };
  openCode: () => { tool: string; input: Record<string, unknown> };
  /** A fragment of the shared refusal; empty when both allow the call. */
  refusal: string;
}[] = [
  {
    name: "a new artifact in the working repository",
    claude: () => ({
      tool_name: "Write",
      tool_input: { file_path: path.join(fixture.repo, "spec.md") },
    }),
    openCode: () => ({ tool: "write", input: { filePath: path.join(fixture.repo, "spec.md") } }),
    refusal: ARTIFACT_REFUSAL_HEADLINE,
  },
  {
    name: "a new source file",
    claude: () => ({ tool_name: "Write", tool_input: { file_path: "src/main.ts", content: "x" } }),
    openCode: () => ({ tool: "write", input: { filePath: "src/main.ts", content: "x" } }),
    refusal: "",
  },
  {
    name: "an edit of an existing untracked Markdown file",
    claude: () => ({ tool_name: "Edit", tool_input: { file_path: "notes.md", new_string: "x" } }),
    openCode: () => ({ tool: "edit", input: { filePath: "notes.md", newString: "x" } }),
    refusal: "",
  },
  {
    name: "an edit of a Markdown file that does not exist",
    claude: () => ({ tool_name: "Edit", tool_input: { file_path: "plan.md", new_string: "x" } }),
    openCode: () => ({ tool: "edit", input: { filePath: "plan.md", newString: "x" } }),
    refusal: ARTIFACT_REFUSAL_HEADLINE,
  },
  {
    name: "a patch that adds an artifact, against a write of it",
    claude: () => ({ tool_name: "Write", tool_input: { file_path: "notes/x.md", content: "y" } }),
    openCode: () => ({ tool: "apply_patch", input: { patchText: "*** Add File: notes/x.md\n+y" } }),
    refusal: ARTIFACT_REFUSAL_HEADLINE,
  },
  {
    name: "a patch that updates an existing file, against an edit of it",
    claude: () => ({ tool_name: "Edit", tool_input: { file_path: "notes.md", new_string: "new" } }),
    openCode: () => ({
      tool: "apply_patch",
      input: { patchText: "*** Update File: notes.md\n@@\n-old\n+new" },
    }),
    refusal: "",
  },
  {
    name: "a shell redirect into a Markdown file",
    claude: () => ({ tool_name: "Bash", tool_input: { command: "echo x > notes/handoff.md" } }),
    openCode: () => ({ tool: "bash", input: { command: "echo x > notes/handoff.md" } }),
    refusal: ARTIFACT_REFUSAL_HEADLINE,
  },
  {
    name: "a read of a secret file",
    claude: () => ({ tool_name: "Read", tool_input: { file_path: ".env" } }),
    openCode: () => ({ tool: "read", input: { filePath: ".env" } }),
    refusal: "secret files are off-limits",
  },
  {
    name: "a commit with a model co-author trailer",
    claude: () => ({
      tool_name: "Bash",
      tool_input: { command: `git commit -m "x" -m "${TRAILER}"` },
    }),
    openCode: () => ({ tool: "bash", input: { command: `git commit -m "x" -m "${TRAILER}"` } }),
    refusal: "No commit was created",
  },
  {
    name: "an artifact in the companion",
    claude: () => ({
      tool_name: "Write",
      tool_input: { file_path: path.join(fixture.companion, "notes", "plan.md") },
    }),
    openCode: () => ({
      tool: "write",
      input: { filePath: path.join(fixture.companion, "notes", "plan.md") },
    }),
    refusal: "",
  },
  {
    name: "an artifact in a sibling folder named like the companion",
    claude: () => ({
      tool_name: "Write",
      tool_input: { file_path: `${fixture.companion}-old/notes.md` },
    }),
    openCode: () => ({ tool: "write", input: { filePath: `${fixture.companion}-old/notes.md` } }),
    refusal: ARTIFACT_REFUSAL_HEADLINE,
  },
  {
    name: "a secret read on the line after $'…' with an escaped quote",
    claude: () => ({
      tool_name: "Bash",
      tool_input: { command: "printf %s $'it\\'s';\ncat .env" },
    }),
    openCode: () => ({ tool: "bash", input: { command: "printf %s $'it\\'s';\ncat .env" } }),
    refusal: "secret files are off-limits",
  },
  {
    name: "a secret read whose ANSI-C name ends at a decoded NUL",
    claude: () => ({ tool_name: "Bash", tool_input: { command: "cat $'.env\\0ignored'" } }),
    openCode: () => ({ tool: "bash", input: { command: "cat $'.env\\0ignored'" } }),
    refusal: "secret files are off-limits",
  },
  {
    name: "a comment that names a secret file (decided: refused)",
    claude: () => ({
      tool_name: "Bash",
      tool_input: { command: "git status # leave server.key alone" },
    }),
    openCode: () => ({ tool: "bash", input: { command: "git status # leave server.key alone" } }),
    refusal: "secret files are off-limits",
  },
  {
    name: "a Markdown redirect on the line after $'…' with an escaped quote",
    claude: () => ({ tool_name: "Bash", tool_input: { command: ansiThenRedirect } }),
    openCode: () => ({ tool: "bash", input: { command: ansiThenRedirect } }),
    refusal: ARTIFACT_REFUSAL_HEADLINE,
  },
  {
    name: "a command nested too deeply to read",
    claude: () => ({ tool_name: "Bash", tool_input: { command: deeplyNested() } }),
    openCode: () => ({ tool: "bash", input: { command: deeplyNested() } }),
    refusal: "more than 64 levels",
  },
  {
    name: "a call the guard fails on",
    claude: () => ({
      tool_name: "Write",
      tool_input: { file_path: "no\u0000tes.md", content: "x" },
    }),
    openCode: () => ({ tool: "write", input: { filePath: "no\u0000tes.md", content: "x" } }),
    refusal: "Mate guardrail could not check this call: ",
  },
];

/** 65 substitutions, each inside double quotes: one more than the guard reads. */
function deeplyNested(): string {
  let command = "printf x";
  for (let i = 0; i < 65; i++) command = `printf "%s" "$(${command})"`;
  return `${command}; printf x > src/a.ts`;
}

describe("both runtimes return the same verdict", () => {
  for (const { name, claude, openCode, refusal } of cases) {
    test(name, async () => {
      const result = await verdicts(claude(), openCode());

      expect(result.openCode).toBe(result.claude);
      if (refusal) expect(result.claude).toContain(refusal);
      else expect(result.claude).toBe("");
    });
  }
});

describe("a companion-scoped session returns the same verdict in both runtimes", () => {
  /** A launch with a companion and no Working Repository, run from the companion. */
  async function companionScoped() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-tool-guard-parity-companion-"));
    const companion = path.join(root, "companion");
    const elsewhere = path.join(root, "elsewhere");
    const home = path.join(root, "home");
    await Promise.all(
      [companion, elsewhere, home].map((dir) => fs.mkdir(dir, { recursive: true })),
    );
    const env = { HOME: home, MATE_ARTIFACT_PATH: companion, MATE_NAME: "mate" };
    return { root, companion, elsewhere, env };
  }

  const cases = [
    {
      name: "an artifact elsewhere",
      file: (f: { elsewhere: string }) => path.join(f.elsewhere, "notes.md"),
      refused: true,
    },
    {
      name: "an artifact in the companion",
      file: (f: { companion: string }) => path.join(f.companion, "notes.md"),
      refused: false,
    },
    {
      name: "source code elsewhere",
      file: (f: { elsewhere: string }) => path.join(f.elsewhere, "a.ts"),
      refused: false,
    },
  ];

  for (const { name, file, refused } of cases) {
    test(name, async () => {
      const f = await companionScoped();
      try {
        const target = file(f);
        const claude = await evaluate(
          { tool_name: "Write", tool_input: { file_path: target, content: "x" } },
          f.env,
          f.companion,
        );
        const openCode = await guardToolInput(
          readContext(f.env, f.companion),
          "write",
          { filePath: target, content: "x" },
          f.env,
        ).then(
          () => "",
          (error: Error) => `${error.message}\n`,
        );
        expect(openCode).toBe(claude.stderr);
        if (refused) expect(claude.stderr).toContain(ARTIFACT_REFUSAL_HEADLINE);
        else expect(claude.stderr).toBe("");
      } finally {
        await fs.rm(f.root, { recursive: true, force: true });
      }
    });
  }
});
