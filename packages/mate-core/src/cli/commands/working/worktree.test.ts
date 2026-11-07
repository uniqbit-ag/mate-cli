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
      wrap: { runtimes: ["claude"], outcome: "ok" },
      index: { outcome: "ok" },
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
    [["acme-login", "--enter"]],
    [["prune", "--enter"]],
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
    expect(err.join("\n")).toContain("--change <change> [--enter]");
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

  describe("a stale companion registry entry", () => {
    function stale(companion: string): WorkspaceInventoryV1 {
      return {
        schemaVersion: 1,
        companions: [],
        pairings: [
          {
            companionPath: companion,
            repository: { id: "web", path: path.join(root, "src", "web.worktrees", "old") },
            health: "missing-repository",
            ambiguous: false,
          },
        ],
      };
    }

    function linkLocally(...companions: string[]): void {
      const config = path.join(root, "src", "web", ".mate", "config");
      fs.mkdirSync(config, { recursive: true });
      const pointers = companions.map((c) => `  - path: ${c}\n    repositoryId: web\n`).join("");
      fs.writeFileSync(path.join(config, "registry.yaml"), `companions:\n${pointers}`);
    }

    test("resolves the companion through the repo-local link", async () => {
      const companion = companionAt("acme-companion");
      linkLocally(companion);
      const seen: string[] = [];
      await runWorkingWorktreeCommand(
        ["acme-login"],
        deps({
          collectInventory: async () => stale(companion),
          create: async (used) => (seen.push(used), created),
        }),
      );
      expect(process.exitCode).toBe(0);
      expect(seen).toEqual([companion]);
    });

    test("a repo-local link to two companions names both and creates nothing", async () => {
      const first = companionAt("acme-one");
      const second = companionAt("acme-two");
      linkLocally(first, second);
      let called = false;
      await runWorkingWorktreeCommand(
        ["acme-login"],
        deps({
          collectInventory: async () => stale(first),
          create: async () => ((called = true), created),
        }),
      );
      expect(process.exitCode).toBe(1);
      expect(err.join("\n")).toContain(`${first}, ${second}`);
      expect(called).toBe(false);
    });

    test("no repo-local link asks for --companion", async () => {
      fs.mkdirSync(path.join(root, "src", "web"), { recursive: true });
      await runWorkingWorktreeCommand(
        ["acme-login"],
        deps({ collectInventory: async () => stale(companionAt("acme-companion")) }),
      );
      expect(process.exitCode).toBe(1);
      expect(err.join("\n")).toContain("is not linked to a companion; pass --companion <path>");
    });
  });

  describe("an Umbrella Repository", () => {
    const umbrella = () => path.join(root, "src", "acme");

    function linkUmbrella(companion: string): void {
      const config = path.join(umbrella(), ".mate", "config");
      fs.mkdirSync(config, { recursive: true });
      fs.mkdirSync(path.join(umbrella(), "api"), { recursive: true });
      fs.writeFileSync(
        path.join(config, "registry.yaml"),
        `companions:\n  - path: ${companion}\n    repositoryId: acme\n`,
      );
    }

    test("run in the umbrella folder, outside Git, uses its link", async () => {
      const companion = companionAt("acme-companion");
      linkUmbrella(companion);
      const seen: string[] = [];
      await runWorkingWorktreeCommand(
        ["acme-login"],
        deps({
          cwd: umbrella(),
          checkoutRoots: async () => null,
          collectInventory: async () => inventory(),
          create: async (used) => (seen.push(used), created),
        }),
      );
      expect(process.exitCode).toBe(0);
      expect(seen).toEqual([companion]);
    });

    test("run in the umbrella folder without a repo-local link pairs through the registry", async () => {
      const companion = companionAt("acme-companion");
      fs.mkdirSync(umbrella(), { recursive: true });
      const seen: string[] = [];
      await runWorkingWorktreeCommand(
        ["acme-login"],
        deps({
          cwd: umbrella(),
          checkoutRoots: async () => null,
          collectInventory: async () => ({
            schemaVersion: 1,
            companions: [],
            pairings: [
              {
                companionPath: companion,
                repository: { id: "acme", path: umbrella() },
                health: "ready",
                ambiguous: false,
              },
            ],
          }),
          create: async (used) => (seen.push(used), created),
        }),
      );
      expect(process.exitCode).toBe(0);
      expect(seen).toEqual([companion]);
    });

    test("run in a child without its own link walks up to the umbrella's", async () => {
      const companion = companionAt("acme-companion");
      linkUmbrella(companion);
      const seen: string[] = [];
      const child = path.join(umbrella(), "api");
      await runWorkingWorktreeCommand(
        ["acme-login"],
        deps({
          cwd: child,
          checkoutRoots: async () => [child],
          collectInventory: async () => inventory(),
          create: async (used) => (seen.push(used), created),
        }),
      );
      expect(process.exitCode).toBe(0);
      expect(seen).toEqual([companion]);
    });

    test("a folder outside Git without any link asks for --companion", async () => {
      const plain = path.join(root, "src", "plain");
      fs.mkdirSync(plain, { recursive: true });
      await runWorkingWorktreeCommand(
        ["acme-login"],
        deps({ cwd: plain, checkoutRoots: async () => null }),
      );
      expect(process.exitCode).toBe(1);
      expect(err.join("\n")).toContain(
        `${plain} is neither inside a Git working tree nor linked to a companion; pass --companion`,
      );
    });
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
      index: { outcome: "ok" },
      missingEnv: [".env"],
    });
  });

  test("a skipped tokensave index carries its reason in JSON and text", async () => {
    const skipped: WorktreeResult = {
      ...created,
      repositories: [
        {
          ...created.repositories[0]!,
          index: { outcome: "skipped", reason: "main checkout not indexed" },
        },
      ],
    };
    await runWorkingWorktreeCommand(
      ["acme-login", "--json"],
      deps({ create: async () => skipped }),
    );
    expect(JSON.parse(out.join("")).repositories[0].index).toEqual({
      outcome: "skipped",
      reason: "main checkout not indexed",
    });
    out.length = 0;
    await runWorkingWorktreeCommand(["acme-login"], deps({ create: async () => skipped }));
    expect(out.join("")).toContain("acme/web: tokensave index skipped (main checkout not indexed)");
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
    expect(text).toContain("acme/web: tokensave index ok");
    expect(text).toContain("(not copied): .env");
    expect(text).toContain("acme/web: wrapped for claude");
  });

  test("prune passes only Done Worksets, with their changes, and exits 0 when it keeps one", async () => {
    const record = (id: string) => ({ id, changes: [id] }) as unknown as WorksetRecord;
    const passed: { id: string; changes: readonly string[] }[] = [];
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
          passed.push(...done);
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
    expect(passed).toEqual([{ id: "acme-login", changes: ["acme-login"] }]);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(out.join("")).kept[0].reason).toBe("commits on no remote");
  });

  describe("--enter", () => {
    const changed = (): WorktreeResult => ({
      ...created,
      workset: "acme-fix",
      repositories: [
        {
          ...created.repositories[0]!,
          path: "/src/web.worktrees/acme-fix",
          branch: "workset/acme-fix",
        },
      ],
      diagnostics: [],
      // Its own: the command appends to it.
      warnings: [],
    });
    const recorded = {
      repository: "acme/web",
      branch: "workset/acme-fix",
      path: "/src/web.worktrees/acme-fix",
    };

    async function enter(
      env: Record<string, string | undefined>,
      overrides: Partial<WorkingWorktreeDeps> = {},
    ): Promise<{ calls: string[] }> {
      const calls: string[] = [];
      await runWorkingWorktreeCommand(
        ["--change", "acme-fix", "--enter", "--json"],
        deps({
          env,
          createForChange: async () => changed(),
          recordBranch: async (_companion, change, result) => {
            calls.push(`${change} ${result.repositories[0]!.branch}`);
            return recorded;
          },
          ...overrides,
        }),
      );
      return { calls };
    }

    test("Claude: records the branch and names EnterWorktree", async () => {
      const { calls } = await enter({ CLAUDECODE: "1" });
      expect(process.exitCode).toBe(0);
      expect(calls).toEqual(["acme-fix workset/acme-fix"]);
      expect(JSON.parse(out.join("")).enter).toEqual({
        runtime: "claude",
        action: "tool",
        tool: "EnterWorktree",
        path: "/src/web.worktrees/acme-fix",
      });
    });

    test("Claude with RTK selected: the enter note names the RTK_DISABLED=1 git form", async () => {
      await enter({ CLAUDECODE: "1" }, { rtkSelected: () => true });
      const instruction = JSON.parse(out.join("")).enter;
      expect(instruction).toMatchObject({ action: "tool", tool: "EnterWorktree" });
      expect(instruction.reason).toContain("RTK_DISABLED=1 git");
    });

    test("RTK selected: OpenCode and other runtimes get no git note", async () => {
      await enter({ OPENCODE_SESSION_ID: "ses_acme" }, { rtkSelected: () => true });
      await enter({}, { rtkSelected: () => true });
      expect(out.join("")).not.toContain("RTK_DISABLED");
    });

    test("records the change and the worktree on the agent session", async () => {
      const attributed: unknown[] = [];
      await enter(
        { CLAUDE_CODE_SESSION_ID: "0b7c-acme" },
        {
          attribute: async (attribution, env) => {
            attributed.push([attribution, env?.CLAUDE_CODE_SESSION_ID]);
            return null;
          },
        },
      );
      expect(attributed).toEqual([
        [
          {
            change: "acme-fix",
            move: { cwd: "/src/web.worktrees/acme-fix", branch: "workset/acme-fix" },
          },
          "0b7c-acme",
        ],
      ]);
    });

    test("OpenCode: names mate_enter_worktree", async () => {
      await enter({ OPENCODE_SESSION_ID: "ses_acme" });
      expect(JSON.parse(out.join("")).enter).toEqual({
        runtime: "opencode",
        action: "tool",
        tool: "mate_enter_worktree",
        path: "/src/web.worktrees/acme-fix",
      });
    });

    test("another runtime: records the branch and hands off with a reason", async () => {
      const { calls } = await enter({});
      expect(calls).toHaveLength(1);
      expect(JSON.parse(out.join("")).enter).toMatchObject({
        runtime: "unknown",
        action: "handoff",
        path: "/src/web.worktrees/acme-fix",
        reason: "this Agent Runtime cannot move a running session",
      });
    });

    test("the current repository got no worktree: hand off with a reason", async () => {
      await enter(
        { CLAUDECODE: "1" },
        { recordBranch: async () => ({ skipped: "acme/api got no worktree for acme-fix" }) },
      );
      expect(process.exitCode).toBe(0);
      const { enter: instruction } = JSON.parse(out.join(""));
      expect(instruction).toMatchObject({
        action: "handoff",
        reason: "acme/api got no worktree for acme-fix",
      });
      // Never another repository's worktree.
      expect(instruction.path).toBeUndefined();
    });

    test("an Umbrella Repository hands off to the mirrored worktree, even in Claude Code", async () => {
      const mirror = "/src/acme.worktrees/acme-fix";
      const reason = `${mirror} is a mirrored umbrella worktree, not a Git worktree`;
      const calls: unknown[] = [];
      await enter(
        { CLAUDECODE: "1" },
        {
          recordBranch: async () => ({
            handoff: reason,
            path: mirror,
            branch: "workset/acme-fix",
            repositories: ["acme/api", "acme/web"],
          }),
          attribute: async (attribution) => (calls.push(attribution), null),
        },
      );
      expect(process.exitCode).toBe(0);
      expect(JSON.parse(out.join("")).enter).toEqual({
        runtime: "claude",
        action: "handoff",
        path: mirror,
        reason,
      });
      // The session is not moved, so only the change is attributed.
      expect(calls).toEqual([{ change: "acme-fix" }]);
    });

    test("an Umbrella Repository moves an OpenCode session into the mirrored worktree", async () => {
      const mirror = "/src/acme.worktrees/acme-fix";
      const calls: unknown[] = [];
      await enter(
        { OPENCODE_SESSION_ID: "ses_acme" },
        {
          recordBranch: async () => ({
            handoff: `${mirror} is a mirrored umbrella worktree, not a Git worktree`,
            path: mirror,
            branch: "workset/acme-fix",
            repositories: ["acme/api", "acme/web"],
          }),
          attribute: async (attribution) => (calls.push(attribution), null),
        },
      );
      expect(process.exitCode).toBe(0);
      expect(JSON.parse(out.join("")).enter).toEqual({
        runtime: "opencode",
        action: "tool",
        tool: "mate_enter_worktree",
        path: mirror,
      });
      expect(calls).toEqual([
        { change: "acme-fix", move: { cwd: mirror, branch: "workset/acme-fix" } },
      ]);
    });

    test("an Umbrella Repository hands off from an unknown runtime", async () => {
      const mirror = "/src/acme.worktrees/acme-fix";
      const reason = `${mirror} is a mirrored umbrella worktree, not a Git worktree`;
      await enter(
        {},
        {
          recordBranch: async () => ({
            handoff: reason,
            path: mirror,
            branch: "workset/acme-fix",
            repositories: ["acme/api"],
          }),
        },
      );
      expect(JSON.parse(out.join("")).enter).toEqual({
        runtime: "unknown",
        action: "handoff",
        path: mirror,
        reason,
      });
    });

    test("an umbrella child's failed record still hands off to the mirror and warns", async () => {
      const mirror = "/src/acme.worktrees/acme-fix";
      const reason = `${mirror} is a mirrored umbrella worktree, not a Git worktree`;
      await enter(
        { CLAUDECODE: "1" },
        {
          recordBranch: async () => ({
            handoff: reason,
            path: mirror,
            repositories: ["acme/api"],
            failed: ["acme/web: acme refused"],
          }),
        },
      );
      expect(process.exitCode).toBe(0);
      const parsed = JSON.parse(out.join(""));
      expect(parsed.enter).toEqual({ runtime: "claude", action: "handoff", path: mirror, reason });
      expect(parsed.warnings).toEqual(["acme/web: acme refused"]);
    });

    test("text output without a worktree to enter names no path", async () => {
      await runWorkingWorktreeCommand(
        ["--change", "acme-fix", "--enter"],
        deps({
          env: { CLAUDECODE: "1" },
          createForChange: async () => changed(),
          recordBranch: async () => ({ skipped: "acme/api got no worktree for acme-fix" }),
        }),
      );
      expect(out.join("")).toContain(
        "mate: enter: not entering (acme/api got no worktree for acme-fix)\n",
      );
    });

    test("records against the command's cwd", async () => {
      let seen = "";
      await enter(
        { CLAUDECODE: "1" },
        {
          cwd: "/src/web",
          recordBranch: async (_companion, _change, _result, cwd) => ((seen = cwd), recorded),
        },
      );
      expect(seen).toBe("/src/web");
    });

    test("a failed creation records nothing and has no enter", async () => {
      const { calls } = await enter(
        { CLAUDECODE: "1" },
        {
          createForChange: async () => ({
            ...changed(),
            ok: false,
            repositories: [],
            diagnostics: ["acme/web: workset/acme-fix is already checked out at /src/web"],
          }),
        },
      );
      expect(process.exitCode).toBe(1);
      expect(calls).toEqual([]);
      expect(JSON.parse(out.join("")).enter).toBeUndefined();
    });

    test("a failed recording keeps the worktree, warns and hands off", async () => {
      await enter(
        { CLAUDECODE: "1" },
        {
          recordBranch: async () => ({ failed: ["mate: workset/acme-fix is a protected branch"] }),
        },
      );
      expect(process.exitCode).toBe(0);
      const parsed = JSON.parse(out.join(""));
      expect(parsed.ok).toBe(true);
      expect(parsed.warnings).toEqual(["mate: workset/acme-fix is a protected branch"]);
      expect(parsed.repositories[0].path).toBe("/src/web.worktrees/acme-fix");
      expect(parsed.enter).toMatchObject({
        action: "handoff",
        reason:
          "recording the delivery branch failed: mate: workset/acme-fix is a protected branch",
      });
      expect(parsed.enter.path).toBeUndefined();
      expect(err.join("\n")).toContain("protected branch");
    });

    test("without --enter nothing is recorded", async () => {
      let called = false;
      await runWorkingWorktreeCommand(
        ["--change", "acme-fix", "--json"],
        deps({
          env: { CLAUDECODE: "1" },
          createForChange: async () => changed(),
          recordBranch: async () => ((called = true), recorded),
        }),
      );
      expect(called).toBe(false);
      expect(JSON.parse(out.join("")).enter).toBeUndefined();
    });

    test("text output prints one line for enter", async () => {
      await runWorkingWorktreeCommand(
        ["--change", "acme-fix", "--enter"],
        deps({
          env: { CLAUDECODE: "1" },
          createForChange: async () => changed(),
          recordBranch: async () => recorded,
        }),
      );
      expect(out.join("")).toContain(
        "mate: enter: call EnterWorktree with /src/web.worktrees/acme-fix\n",
      );
      expect(out.join("")).not.toContain("RTK_DISABLED");
    });

    test("text output with RTK selected appends the git form to the enter line", async () => {
      await runWorkingWorktreeCommand(
        ["--change", "acme-fix", "--enter"],
        deps({
          env: { CLAUDECODE: "1" },
          createForChange: async () => changed(),
          recordBranch: async () => recorded,
          rtkSelected: () => true,
        }),
      );
      expect(out.join("")).toContain(
        "mate: enter: call EnterWorktree with /src/web.worktrees/acme-fix; then run git as RTK_DISABLED=1 git ...",
      );
    });
  });

  describe("--ticket", () => {
    test("passes the normalised key to the worktree", async () => {
      const seen: Array<string | undefined> = [];
      await runWorkingWorktreeCommand(
        ["--change", "acme-fix", "--ticket", "abc-123", "--json"],
        deps({
          ticketFormat: async () => "jira",
          createForChange: async (_companion, _change, options) => {
            seen.push(options.ticket);
            return created;
          },
        }),
      );
      expect(process.exitCode).toBe(0);
      expect(seen).toEqual(["ABC-123"]);
    });

    test("is refused while tickets are off and creates nothing", async () => {
      let called = false;
      await runWorkingWorktreeCommand(
        ["acme-login", "--ticket", "ABC-123"],
        deps({
          ticketFormat: async () => "none",
          create: async () => ((called = true), created),
        }),
      );
      expect(process.exitCode).toBe(1);
      expect(err.join("\n")).toContain("ticket: jira");
      expect(called).toBe(false);
    });

    test("an invalid key names the format and creates nothing", async () => {
      let called = false;
      await runWorkingWorktreeCommand(
        ["acme-login", "--ticket", "abc123"],
        deps({
          ticketFormat: async () => "jira",
          create: async () => ((called = true), created),
        }),
      );
      expect(process.exitCode).toBe(1);
      expect(err.join("\n")).toContain("Jira key such as ABC-123");
      expect(called).toBe(false);
    });

    test("is refused with prune", async () => {
      await runWorkingWorktreeCommand(["prune", "--ticket", "ABC-123"], deps());
      expect(process.exitCode).toBe(1);
      expect(err.join("\n")).toContain("usage: mate working worktree");
    });
  });
});
