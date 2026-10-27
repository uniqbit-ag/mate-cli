import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

import { writeProjectionPair } from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";
import { manifestPath } from "../runtime/runtime-document-manifest";
import type { PrepareRequest, PrepareRun } from "../runtime/session-prepare-runner";
import { PROJECTED_FLAG } from "../runtime/projected-flag";
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
  };
  return { deps, requests, order };
}

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
