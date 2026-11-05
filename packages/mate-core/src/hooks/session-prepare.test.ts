import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

import { writeProjectionPair } from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";
import { manifestPath } from "../runtime/runtime-document-manifest";
import type { PrepareRequest, PrepareRun } from "../runtime/session-prepare-runner";
import { PROJECTED_FLAG } from "../runtime/projected-flag";
import type { SessionInput } from "../runtime/session-registry";
import type { SessionRegisterDeps } from "./session-register";
import {
  runSessionPrepareHook,
  runSessionStartHook,
  type SessionPrepareHookDeps,
} from "./session-prepare";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function projectedRepo(wrappedFor: "claude" | "opencode" | null): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acme-prepare-hook-")));
  tempRoots.push(root);
  const repo = path.join(root, "acme");
  const companion = path.join(root, "acme-companion");
  fs.mkdirSync(repo, { recursive: true });
  const registryPath = repoLocalRegistryPath(repo);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, "companions: []\n", "utf8");
  writeProjectionPair(repo, {
    stamp: "acme",
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
  if (wrappedFor) {
    const document =
      wrappedFor === "claude" ? ".claude/settings.local.json" : ".opencode/opencode.json";
    fs.writeFileSync(manifestPath(repo), JSON.stringify({ documents: { [document]: [] } }));
  }
  return repo;
}

function fakeDeps(local: PrepareRun | Error = { ok: true, notes: [] }) {
  const requests: PrepareRequest[] = [];
  const order: string[] = [];
  const deps: SessionPrepareHookDeps = {
    mateBin: () => "/opt/acme/mate",
    runner: () => async (request) => {
      requests.push(request);
      order.push("local");
      if (local instanceof Error) throw local;
      return local;
    },
    startSync: mock(() => {
      order.push("sync");
    }),
    timeoutMs: 1234,
    registry: fakeRegistry().deps,
  };
  return { deps, requests, order };
}

function fakeRegistry(options: { wrapped?: boolean; fail?: boolean; known?: string[] } = {}) {
  const registered: SessionInput[] = [];
  const refreshed: SessionInput[] = [];
  let branchCalls = 0;
  const deps: SessionRegisterDeps = {
    register: async (input) => {
      if (options.fail) throw new Error("registry locked");
      registered.push(input);
    },
    refresh: async (input) => {
      refreshed.push(input);
    },
    registered: async (id) => options.known?.includes(id) ?? false,
    end: async () => {},
    patch: async () => {},
    branch: async () => {
      branchCalls += 1;
      return "workset/acme";
    },
    wrappedForClaude: () => options.wrapped ?? true,
    now: () => new Date("2026-03-01T00:00:00.000Z"),
  };
  return { deps, registered, refreshed, branchCalls: () => branchCalls };
}

const EDITOR = { MATE_SESSION_ORIGIN: "editor" };

describe("session-prepare hook", () => {
  test("awaits the bounded local phase, then starts the sync", async () => {
    const repo = projectedRepo("claude");
    const { deps, requests, order } = fakeDeps();

    const outcome = await runSessionPrepareHook({ CLAUDE_PROJECT_DIR: repo }, "/", deps);

    expect(outcome).toEqual({ exitCode: 0, stdout: "" });
    expect(requests).toEqual([{ sync: false, timeoutMs: 1234 }]);
    expect(order).toEqual(["local", "sync"]);
    expect(deps.startSync).toHaveBeenCalledWith("/opt/acme/mate", repo);
  });

  test("a failed local phase exits zero and reports only through systemMessage", async () => {
    const repo = projectedRepo("claude");
    const { deps } = fakeDeps({ ok: false, notes: ["file-sync: acme unreadable"] });

    const outcome = await runSessionPrepareHook({}, repo, deps);

    expect(outcome.exitCode).toBe(0);
    const payload = JSON.parse(outcome.stdout) as Record<string, unknown>;
    expect(payload).toEqual({
      systemMessage: "mate: session prepare failed: file-sync: acme unreadable",
    });
    expect(outcome.stdout).not.toContain("additionalContext");
  });

  test("warnings are reported as warnings", async () => {
    const repo = projectedRepo("claude");
    const { deps } = fakeDeps({ ok: true, notes: ["acme shadowed"] });

    const outcome = await runSessionPrepareHook({}, repo, deps);

    expect(JSON.parse(outcome.stdout)).toEqual({
      systemMessage: "mate: session prepare warning: acme shadowed",
    });
  });

  test("a runner that throws still exits zero", async () => {
    const repo = projectedRepo("claude");
    const { deps } = fakeDeps(new Error("cannot run acme"));

    const outcome = await runSessionPrepareHook({}, repo, deps);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("cannot run acme");
  });

  test("is inert under a launch environment", async () => {
    const repo = projectedRepo("claude");
    const { deps, order } = fakeDeps();

    const outcome = await runSessionPrepareHook({ MATE_ARTIFACT_PATH: "/acme" }, repo, deps);

    expect(outcome).toEqual({ exitCode: 0, stdout: "" });
    expect(order).toEqual([]);
  });

  test("is inert in an OpenCode-only wrap", async () => {
    const repo = projectedRepo("opencode");
    const { deps, order } = fakeDeps();

    await runSessionPrepareHook({}, repo, deps);

    expect(order).toEqual([]);
  });

  test("is inert when the manifest cannot be read", async () => {
    const repo = projectedRepo(null);
    fs.mkdirSync(manifestPath(repo), { recursive: true });
    const { deps, order } = fakeDeps();

    const outcome = await runSessionPrepareHook({}, repo, deps);

    expect(outcome).toEqual({ exitCode: 0, stdout: "" });
    expect(order).toEqual([]);
  });

  test("is inert without a projection", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acme-unprojected-"));
    tempRoots.push(root);
    const { deps, order } = fakeDeps();

    const outcome = await runSessionPrepareHook({}, root, deps);

    expect(outcome.stdout).toBe("");
    expect(order).toEqual([]);
  });

  test("a missing runtime directory is reported and nothing is spawned", async () => {
    const repo = projectedRepo("claude");
    const { deps, order } = fakeDeps();
    deps.mateBin = () => null;

    const outcome = await runSessionPrepareHook({}, repo, deps);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("run `mate` once");
    expect(order).toEqual([]);
  });
});

describe("session-start hook", () => {
  const sessionStart = { hook_event_name: "SessionStart", source: "startup" };

  function companionOf(repo: string): string {
    const companion = path.join(path.dirname(repo), "acme-companion");
    fs.mkdirSync(companion, { recursive: true });
    fs.writeFileSync(path.join(companion, "AGENTS.md"), "## Git\n\nACME-STALE\n");
    return companion;
  }

  /** Claude Code runs an event's hooks in parallel, so only this order keeps the read off a rewrite. */
  test("the wrap's copy delivers the instructions the local phase left", async () => {
    const repo = projectedRepo("claude");
    const companion = companionOf(repo);
    const { deps } = fakeDeps();
    const local = deps.runner;
    deps.runner = (bin, dir) => async (request) => {
      fs.writeFileSync(path.join(companion, "AGENTS.md"), "## Git\n\nACME-REFRESHED\n");
      return local(bin, dir)(request);
    };

    const outcome = await runSessionStartHook(
      { env: {}, cwd: repo, argv: [PROJECTED_FLAG], input: sessionStart },
      deps,
    );

    const payload = JSON.parse(outcome.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(payload.hookSpecificOutput.additionalContext).toContain("ACME-REFRESHED");
    expect(payload.hookSpecificOutput.additionalContext).not.toContain("ACME-STALE");
  });

  test("prepare notes and the instructions share one output", async () => {
    const repo = projectedRepo("claude");
    companionOf(repo);
    const { deps } = fakeDeps({ ok: true, notes: ["acme shadowed"] });

    const outcome = await runSessionStartHook(
      { env: {}, cwd: repo, argv: [PROJECTED_FLAG], input: sessionStart },
      deps,
    );

    const payload = JSON.parse(outcome.stdout) as {
      hookSpecificOutput: { additionalContext: string };
      systemMessage: string;
    };
    expect(outcome.exitCode).toBe(0);
    expect(payload.systemMessage).toBe("mate: session prepare warning: acme shadowed");
    expect(payload.hookSpecificOutput.additionalContext).toContain("ACME-STALE");
  });

  test("a prepare that throws exits zero and still delivers the instructions", async () => {
    const repo = projectedRepo("claude");
    companionOf(repo);
    const { deps } = fakeDeps();
    deps.mateBin = () => {
      throw new Error("disk on fire");
    };

    const outcome = await runSessionStartHook(
      { env: {}, cwd: repo, argv: [PROJECTED_FLAG], input: sessionStart },
      deps,
    );

    const payload = JSON.parse(outcome.stdout) as {
      hookSpecificOutput: { additionalContext: string };
      systemMessage: string;
    };
    expect(outcome.exitCode).toBe(0);
    expect(payload.systemMessage).toBe("mate: session prepare failed: disk on fire");
    expect(payload.hookSpecificOutput.additionalContext).toContain("ACME-STALE");
  });

  test("the instruction read is injected through the hook's deps", async () => {
    const repo = projectedRepo("claude");
    companionOf(repo);
    const { deps } = fakeDeps();
    deps.instructions = {
      read: () => ({
        kind: "available",
        source: "/acme/AGENTS.md",
        text: "ACME-INJECTED",
        omitted: [],
        oversized: false,
      }),
    };

    const outcome = await runSessionStartHook(
      { env: {}, cwd: repo, argv: [PROJECTED_FLAG], input: sessionStart },
      deps,
    );

    const payload = JSON.parse(outcome.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(payload.hookSpecificOutput.additionalContext).toBe("ACME-INJECTED");
  });

  test("input that is not JSON runs no prepare and stays silent", async () => {
    const repo = projectedRepo("claude");
    companionOf(repo);
    const { deps, order } = fakeDeps();

    const outcome = await runSessionStartHook(
      { env: {}, cwd: repo, argv: [PROJECTED_FLAG], input: null },
      deps,
    );

    expect(outcome).toEqual({ exitCode: 0, stdout: "" });
    expect(order).toEqual([]);
  });

  test("input that is a JSON array runs no prepare and stays silent", async () => {
    const repo = projectedRepo("claude");
    companionOf(repo);
    const { deps, order } = fakeDeps();

    const outcome = await runSessionStartHook(
      { env: {}, cwd: repo, argv: [PROJECTED_FLAG], input: [] },
      deps,
    );

    expect(outcome).toEqual({ exitCode: 0, stdout: "" });
    expect(order).toEqual([]);
  });

  /** A Git fast-forward replaces the companion's files in place, so it must not overlap the read. */
  test("the sync starts only after the instructions are read", async () => {
    const repo = projectedRepo("claude");
    companionOf(repo);
    const { deps, order } = fakeDeps();
    deps.instructions = {
      read: () => {
        order.push("read");
        return {
          kind: "available",
          source: "/acme/AGENTS.md",
          text: "ACME-READ",
          omitted: [],
          oversized: false,
        };
      },
    };

    await runSessionStartHook(
      { env: {}, cwd: repo, argv: [PROJECTED_FLAG], input: sessionStart },
      deps,
    );

    expect(order).toEqual(["local", "read", "sync"]);
  });

  test("a sync that fails to start is reported and the instructions still go out", async () => {
    const repo = projectedRepo("claude");
    companionOf(repo);
    const { deps } = fakeDeps();
    deps.startSync = () => {
      throw new Error("spawn refused");
    };

    const outcome = await runSessionStartHook(
      { env: {}, cwd: repo, argv: [PROJECTED_FLAG], input: sessionStart },
      deps,
    );

    const payload = JSON.parse(outcome.stdout) as {
      hookSpecificOutput: { additionalContext: string };
      systemMessage: string;
    };
    expect(outcome.exitCode).toBe(0);
    expect(payload.systemMessage).toBe("mate: session prepare failed: spawn refused");
    expect(payload.hookSpecificOutput.additionalContext).toContain("ACME-STALE");
  });

  test("the instructions are read from the folder the prepare ran in", async () => {
    const repo = projectedRepo("claude");
    companionOf(repo);
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acme-elsewhere-")));
    tempRoots.push(elsewhere);
    const { deps, order } = fakeDeps();

    const outcome = await runSessionStartHook(
      {
        env: { CLAUDE_PROJECT_DIR: repo },
        cwd: elsewhere,
        argv: [PROJECTED_FLAG],
        input: { ...sessionStart, cwd: elsewhere },
      },
      deps,
    );

    const payload = JSON.parse(outcome.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(order).toContain("local");
    expect(payload.hookSpecificOutput.additionalContext).toContain("ACME-STALE");
  });

  /** A second prepare would hold the lock and rewrite `AGENTS.md` while the wrap's copy reads it. */
  test("the plugin's bare copy leaves the prepare and the instructions to the wrap's", async () => {
    const repo = projectedRepo("claude");
    companionOf(repo);
    const { deps, order } = fakeDeps();

    const outcome = await runSessionStartHook(
      { env: { CLAUDE_PLUGIN_ROOT: "/acme/plugin" }, cwd: repo, argv: [], input: sessionStart },
      deps,
    );

    expect(outcome).toEqual({ exitCode: 0, stdout: "" });
    expect(order).toEqual([]);
  });

  test("a bare copy from an older wrap delivers in a worktree with no manifest of its own", async () => {
    const repo = projectedRepo(null);
    companionOf(repo);
    const { deps, order } = fakeDeps();

    const outcome = await runSessionStartHook(
      { env: {}, cwd: repo, argv: [], input: sessionStart },
      deps,
    );

    const payload = JSON.parse(outcome.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(order).toEqual([]);
    expect(payload.hookSpecificOutput.additionalContext).toContain("ACME-STALE");
  });
});

describe("session registration from SessionStart", () => {
  const start = {
    hook_event_name: "SessionStart",
    session_id: "0b7c-acme",
    cwd: "",
    transcript_path: "/t/0b7c-acme.jsonl",
    source: "startup",
  };

  test("the wrap's copy registers a session an editor started", async () => {
    const repo = projectedRepo("claude");
    const { deps } = fakeDeps();
    const registry = fakeRegistry();
    deps.registry = registry.deps;

    await runSessionStartHook(
      {
        env: { ...EDITOR, CLAUDE_PID: "4242" },
        cwd: repo,
        argv: [PROJECTED_FLAG],
        input: { ...start, cwd: repo },
      },
      deps,
    );

    expect(registry.registered).toEqual([
      {
        id: "0b7c-acme",
        runtime: "claude",
        cwd: repo,
        origin: "editor",
        pid: 4242,
        branch: "workset/acme",
        transcript: "/t/0b7c-acme.jsonl",
      },
    ]);
  });

  test("registration runs beside the prepare, not before it", async () => {
    const repo = projectedRepo("claude");
    const { deps, order } = fakeDeps();
    const registry = fakeRegistry();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    registry.deps.branch = async () => {
      order.push("register");
      await held;
      return null;
    };
    deps.registry = registry.deps;
    const outcome = runSessionStartHook(
      { env: EDITOR, cwd: repo, argv: [PROJECTED_FLAG], input: { ...start, cwd: repo } },
      deps,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["register", "local"]);
    release();
    await outcome;
    expect(registry.registered.map((input) => input.id)).toEqual(["0b7c-acme"]);
  });

  test("the plugin's copy stays out where the wrap's copy runs", async () => {
    const repo = projectedRepo("claude");
    const { deps } = fakeDeps();
    const registry = fakeRegistry({ wrapped: true });
    deps.registry = registry.deps;

    await runSessionStartHook(
      {
        env: { ...EDITOR, CLAUDE_PLUGIN_ROOT: "/p", MATE_REPO_PATH: repo },
        cwd: repo,
        argv: [],
        input: start,
      },
      deps,
    );

    expect(registry.registered).toEqual([]);
  });

  test("any other session writes nothing and asks Git nothing; a registered one is refreshed", async () => {
    const repo = projectedRepo("claude");
    const { deps } = fakeDeps();
    const registry = fakeRegistry({ known: ["resumed"] });
    deps.registry = registry.deps;
    const at = (id: string) => ({
      env: { MATE_REPO_PATH: repo },
      cwd: repo,
      argv: [PROJECTED_FLAG],
      input: { ...start, session_id: id, cwd: repo },
    });

    await runSessionStartHook(at("0b7c-acme"), deps);
    expect(registry.registered).toEqual([]);
    expect(registry.refreshed).toEqual([]);
    expect(registry.branchCalls()).toBe(0);

    await runSessionStartHook(at("resumed"), deps);
    expect(registry.registered).toEqual([]);
    expect(registry.refreshed.map((input) => input.id)).toEqual(["resumed"]);
  });

  test("the plugin's copy registers an editor launch in an unwrapped repository", async () => {
    const { deps } = fakeDeps();
    const registry = fakeRegistry({ wrapped: false });
    deps.registry = registry.deps;

    const outcome = await runSessionStartHook(
      {
        env: { ...EDITOR, CLAUDE_PLUGIN_ROOT: "/p", MATE_REPO_PATH: "/w/acme" },
        cwd: "/w/acme",
        argv: [],
        input: start,
      },
      deps,
    );

    expect(outcome).toEqual({ exitCode: 0, stdout: "" });
    expect(registry.registered.map((input) => input.origin)).toEqual(["editor"]);
  });

  test("a registry failure leaves the hook output unchanged", async () => {
    const repo = projectedRepo("claude");
    const ok = fakeDeps();
    const failing = fakeDeps();
    failing.deps.registry = fakeRegistry({ fail: true }).deps;
    const call = { env: EDITOR, cwd: repo, argv: [PROJECTED_FLAG], input: { ...start, cwd: repo } };

    const expected = await runSessionStartHook(call, ok.deps);
    const actual = await runSessionStartHook(call, failing.deps);

    expect(actual).toEqual(expected);
  });
});
