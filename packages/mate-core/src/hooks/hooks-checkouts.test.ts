import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { addWorktree, git } from "../../test/git-checkouts";
import { project, projectedClone, type ProjectedClone } from "../../test/projected-clone";
import type { InstructionReader } from "../runtime/companion-instructions";
import { PROJECTED_FLAG } from "../runtime/projected-flag";
import { manifestPath } from "../runtime/runtime-document-manifest";
import { instructionHookPayload } from "./companion-instructions";
import { hookFolder } from "./hook-io";
import { runSessionStartHook, type SessionPrepareHookDeps } from "./session-prepare";
import { evaluate } from "./validate-artifact-path";

/** Hooks in the Checkouts of one clone (share-repository-link-across-worktrees, design Decision 10). */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function wrapMainForClaude(clone: ProjectedClone): void {
  fs.writeFileSync(
    manifestPath(clone.main),
    JSON.stringify({ documents: { ".claude/settings.local.json": [] } }),
  );
}

/** The repository each instruction read names, the `$MATE_REPO_PATH` the instructions carry. */
function instructionRepositories(): { read: InstructionReader; paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    read: (input) => {
      paths.push(input.repository.path);
      return { kind: "unavailable", source: "AGENTS.md", reason: "acme" };
    },
  };
}

describe("hookFolder", () => {
  test("takes the input's cwd, then CLAUDE_PROJECT_DIR, then the process folder", () => {
    const env = { CLAUDE_PROJECT_DIR: "/acme/start" };

    expect(hookFolder({ cwd: "/acme/worktree" }, env, "/acme/process")).toBe("/acme/worktree");
    expect(hookFolder({ cwd: 7 }, env, "/acme/process")).toBe("/acme/start");
    expect(hookFolder(null, {}, "/acme/process")).toBe("/acme/process");
  });
});

describe("instruction hooks name the worktree in $MATE_REPO_PATH", () => {
  test("a plain session on a borrowed projection", () => {
    const clone = projectedClone(roots);
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));
    const { read, paths } = instructionRepositories();

    instructionHookPayload(
      {
        env: clone.env,
        cwd: clone.main,
        projected: true,
        input: { hook_event_name: "SessionStart", cwd: worktree },
      },
      { read },
    );

    expect(paths).toEqual([worktree]);
  });

  test("a plain session in a nested worktree", () => {
    const clone = projectedClone(roots);
    const worktree = addWorktree(clone.main, path.join(clone.main, ".claude", "worktrees", "fix"));
    const { read, paths } = instructionRepositories();

    instructionHookPayload(
      {
        env: { ...clone.env, CLAUDE_PROJECT_DIR: clone.main },
        cwd: clone.main,
        projected: true,
        input: { hook_event_name: "SessionStart", cwd: worktree },
      },
      { read },
    );

    expect(paths).toEqual([worktree]);
  });

  test("a subagent of a managed session working in a linked worktree", () => {
    const clone = projectedClone(roots);
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));
    const env = {
      ...clone.env,
      MATE_ARTIFACT_PATH: clone.companionPath,
      MATE_REPO_PATH: clone.main,
      MATE_REPO_ID: "acme-app",
      MATE_WRAPPER_BIN_PATH: "/install/mate/wrappers/bin",
    };
    const { read, paths } = instructionRepositories();

    for (const projected of [false, true]) {
      instructionHookPayload(
        {
          env,
          cwd: clone.main,
          projected,
          input: { hook_event_name: "SubagentStart", agent_type: "general-purpose", cwd: worktree },
        },
        { read },
      );
    }

    expect(paths).toEqual([worktree]);
  });
});

describe("the session-prepare hook in a worktree", () => {
  function fakeDeps(): { deps: SessionPrepareHookDeps; prepared: string[] } {
    const prepared: string[] = [];
    return {
      prepared,
      deps: {
        mateBin: () => "/opt/acme/mate",
        runner: (_mateBin, repoPath) => async () => {
          prepared.push(repoPath);
          return { ok: true, notes: [] };
        },
        startSync: () => {},
        timeoutMs: 1000,
        instructions: { read: instructionRepositories().read },
      },
    };
  }

  const start = (cwd: string) => ({ hook_event_name: "SessionStart", source: "startup", cwd });

  test("prepares the worktree's root when the main worktree is wrapped for Claude", async () => {
    const clone = projectedClone(roots);
    wrapMainForClaude(clone);
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));
    fs.mkdirSync(path.join(worktree, "src"));
    const { deps, prepared } = fakeDeps();

    await runSessionStartHook(
      {
        env: clone.env,
        cwd: clone.main,
        argv: [PROJECTED_FLAG],
        input: start(path.join(worktree, "src")),
      },
      deps,
    );

    expect(prepared).toEqual([worktree]);
  });

  test("an adopted worktree with no wrap of its own is planned from the main worktree's", async () => {
    const clone = projectedClone(roots);
    wrapMainForClaude(clone);
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));
    project(clone, worktree);
    const { deps, prepared } = fakeDeps();

    await runSessionStartHook(
      { env: clone.env, cwd: clone.main, argv: [PROJECTED_FLAG], input: start(worktree) },
      deps,
    );

    expect(prepared).toEqual([worktree]);
  });

  test("stays inert when the main worktree is not wrapped for Claude", async () => {
    const clone = projectedClone(roots);
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));
    const { deps, prepared } = fakeDeps();

    await runSessionStartHook(
      { env: clone.env, cwd: clone.main, argv: [PROJECTED_FLAG], input: start(worktree) },
      deps,
    );

    expect(prepared).toEqual([]);
  });
});

describe("the guard in a managed session working in a sibling worktree", () => {
  test("allows editing a Markdown file the worktree tracks and blocks a new note", async () => {
    const clone = projectedClone(roots);
    fs.writeFileSync(path.join(clone.main, "README.md"), "# acme\n");
    git(clone.main, "add", "README.md");
    git(clone.main, "commit", "-q", "-m", "readme");
    const worktree = addWorktree(clone.main, path.join(clone.root, "acme-fix"));
    const env = {
      ...clone.env,
      MATE_ARTIFACT_PATH: clone.companionPath,
      MATE_REPO_PATH: clone.main,
      MATE_REPO_ID: "acme-app",
    };
    const write = (file: string) => ({
      tool_name: "Write",
      tool_input: { file_path: path.join(worktree, file), content: "# acme\n" },
      cwd: worktree,
    });

    const tracked = await evaluate(write("README.md"), env, worktree);
    const note = await evaluate(write("notes/plan.md"), env, worktree);

    expect(tracked).toEqual({ exitCode: 0, stderr: "" });
    expect(note.exitCode).toBe(2);
    expect(note.stderr).toContain(clone.companionPath);
  });
});
