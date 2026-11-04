import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WorkspaceInventoryV1 } from "../../../lib/orchestrator/workspace-inventory";
import type { WorksetRecord } from "../../../lib/workset/record";
import type { WorktreeResult } from "../../../lib/workset/worktree";
import { runWorkingWorktreeCommand, type WorkingWorktreeDeps } from "./worktree";

let root: string;
let out: string[];
let err: string[];
let restore: (() => void)[];

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-worktree-cmd-")));
  out = [];
  err = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const stderr = spyOn(console, "error").mockImplementation((line: string) => void err.push(line));
  restore = [() => stdout.mockRestore(), () => stderr.mockRestore()];
  process.exitCode = 0;
});

afterEach(() => {
  for (const undo of restore) undo();
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = 0;
});

function companionAt(name: string): string {
  const companion = path.join(root, name);
  fs.mkdirSync(path.join(companion, ".mate", "config"), { recursive: true });
  fs.writeFileSync(path.join(companion, ".mate", "config", "framework.yaml"), "type: companion\n");
  return companion;
}

function inventory(...companions: string[]): WorkspaceInventoryV1 {
  return {
    schemaVersion: 1,
    companions: [],
    pairings: companions.map((companionPath) => ({
      companionPath,
      repository: { id: "web", path: path.join(root, "src", "web") },
      health: "ready",
      ambiguous: companions.length > 1,
    })),
  };
}

const created: WorktreeResult = {
  workset: "acme-login",
  ok: true,
  repositories: [
    {
      repository: "acme/web",
      checkout: "/src/web",
      path: "/src/web.worktrees/acme-login",
      branch: "workset/acme-login",
      action: "created",
      install: { command: "bun install", outcome: "ok" },
      missingEnv: [".env"],
    },
  ],
  diagnostics: [],
  warnings: [],
};

function deps(overrides: Partial<WorkingWorktreeDeps> = {}): WorkingWorktreeDeps {
  return {
    cwd: path.join(root, "src", "web"),
    checkoutRoots: async () => [path.join(root, "src", "web")],
    collectInventory: async () => inventory(companionAt("acme-companion")),
    create: async () => created,
    ...overrides,
  };
}

describe("mate working worktree", () => {
  test.each([
    [[]],
    [["acme-login", "extra"]],
    [["acme-login", "--force"]],
    [["acme-login", "--companion"]],
    [["prune", "--no-install"]],
    [["acme-login", "--change", "acme-form"]],
    [["--change"]],
    [["prune", "--change", "acme-form"]],
  ])("refuses %j with the usage", async (argv) => {
    let called = false;
    await runWorkingWorktreeCommand(
      argv,
      deps({
        create: async () => ((called = true), created),
        createForChange: async () => ((called = true), created),
      }),
    );
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("usage: mate working worktree <workset-id>");
    expect(called).toBe(false);
  });

  test("an ambiguous companion names both and creates nothing", async () => {
    const first = companionAt("acme-one");
    const second = companionAt("acme-two");
    let called = false;
    await runWorkingWorktreeCommand(
      ["acme-login"],
      deps({
        collectInventory: async () => inventory(first, second),
        create: async () => ((called = true), created),
      }),
    );
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain(first);
    expect(err.join("\n")).toContain(second);
    expect(called).toBe(false);
  });

  test("--companion overrides the pairings", async () => {
    const explicit = companionAt("acme-explicit");
    const seen: string[] = [];
    await runWorkingWorktreeCommand(
      ["acme-login", "--companion", explicit, "--no-install"],
      deps({
        collectInventory: async () => inventory(companionAt("acme-one"), companionAt("acme-two")),
        create: async (companion, _id, options) => {
          seen.push(companion, String(options.install));
          return created;
        },
      }),
    );
    expect(process.exitCode).toBe(0);
    expect(seen).toEqual([explicit, "false"]);
  });

  test("--json prints one object with each repository's outcome", async () => {
    let stream: boolean | undefined;
    await runWorkingWorktreeCommand(
      ["acme-login", "--json"],
      deps({
        create: async (_companion, _id, options) => {
          stream = options.streamInstall;
          return created;
        },
      }),
    );
    expect(stream).toBe(false);
    const parsed = JSON.parse(out.join(""));
    expect(parsed).toEqual(created);
    expect(parsed.repositories[0]).toMatchObject({
      repository: "acme/web",
      branch: "workset/acme-login",
      action: "created",
      install: { command: "bun install", outcome: "ok" },
      missingEnv: [".env"],
    });
  });

  test("--change resolves through the change entry point with the same JSON", async () => {
    const seen: string[] = [];
    await runWorkingWorktreeCommand(
      ["--change", "acme-form", "--json"],
      deps({
        create: async () => {
          throw new Error("positional path used");
        },
        createForChange: async (_companion, change, options) => {
          seen.push(change, String(options.install), String(options.streamInstall));
          return created;
        },
      }),
    );
    expect(process.exitCode).toBe(0);
    expect(seen).toEqual(["acme-form", "true", "false"]);
    expect(JSON.parse(out.join(""))).toEqual(created);
  });

  test("failed checks exit non-zero and go to stderr, also with --json", async () => {
    await runWorkingWorktreeCommand(
      ["acme-login", "--json"],
      deps({
        create: async () => ({
          ...created,
          ok: false,
          repositories: [],
          diagnostics: ["acme/api: not linked"],
        }),
      }),
    );
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(out.join("")).diagnostics).toEqual(["acme/api: not linked"]);
    expect(err).toContain("mate working worktree: acme/api: not linked");
  });

  test("text output names path, branch, install, and missing env files", async () => {
    await runWorkingWorktreeCommand(["acme-login"], deps());
    const text = out.join("");
    expect(text).toContain("acme/web: created /src/web.worktrees/acme-login on workset/acme-login");
    expect(text).toContain("install bun install ok");
    expect(text).toContain("(not copied): .env");
  });

  test("prune passes only Done Worksets and exits 0 when it keeps one", async () => {
    const record = (id: string) => ({ id }) as WorksetRecord;
    const passed: string[] = [];
    await runWorkingWorktreeCommand(
      ["prune", "--json"],
      deps({
        worksetStages: async () => ({
          worksets: [
            {
              record: record("acme-login"),
              derived: { stage: "done", label: "Done", turn: "none", problems: [] },
            },
            {
              record: record("acme-signup"),
              derived: {
                stage: "merge-wait",
                label: "Waiting for merge",
                turn: "human",
                problems: [],
              },
            },
          ],
          problems: [],
        }),
        prune: async (_companion, done) => {
          passed.push(...done.map((entry) => entry.id));
          return {
            removed: [],
            kept: [
              {
                workset: "acme-login",
                repository: "acme/web",
                path: "/w",
                reason: "commits on no remote",
              },
            ],
            warnings: [],
          };
        },
      }),
    );
    expect(passed).toEqual(["acme-login"]);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(out.join("")).kept[0].reason).toBe("commits on no remote");
  });
});
