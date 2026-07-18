import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SetupContext } from "../plugin";
import {
  TOKENSAVE_SUPPORTED_AGENTS,
  TOKENSAVE_STORE_DIR,
  TOKENSAVE_WORKING_REPO_EXCLUDE_ENTRIES,
  tokensaveDeps,
  tokensavePlugin,
} from "./tokensave";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function makeCtx(
  companionPath: string,
  opts?: { repoPath?: string; providers?: string[]; mode?: "setup" | "sync" },
): SetupContext {
  return {
    companionPath,
    activeProviders: opts?.providers ?? [],
    mode: opts?.mode ?? "setup",
    repoPath: opts?.repoPath,
    config: {
      profiles: { default: { name: "default", allowedAgents: opts?.providers ?? [] } },
      capabilities: [{ name: "tokensave" }],
    },
  };
}

describe("TOKENSAVE_WORKING_REPO_EXCLUDE_ENTRIES", () => {
  test("contains TokenSave local git exclude entries", () => {
    expect(TOKENSAVE_WORKING_REPO_EXCLUDE_ENTRIES).toContain(".tokensave/");
  });
});

describe("TOKENSAVE_SUPPORTED_AGENTS", () => {
  test("includes claude and opencode", () => {
    expect(TOKENSAVE_SUPPORTED_AGENTS.has("claude")).toBe(true);
    expect(TOKENSAVE_SUPPORTED_AGENTS.has("opencode")).toBe(true);
  });
});

describe("tokensavePlugin.apply", () => {
  let runMock: mock.Mock;
  let runCommandMock: mock.Mock;
  let runShellCommandMock: mock.Mock;
  let originalDeps: typeof tokensaveDeps;

  beforeEach(() => {
    originalDeps = { ...tokensaveDeps };
    runMock = mock(() => ({ ok: true, stderr: "", stdout: "" }));
    runCommandMock = mock(async () => {});
    runShellCommandMock = mock(async () => {});
    tokensaveDeps.run = runMock;
    tokensaveDeps.runCommand = runCommandMock;
    tokensaveDeps.runShellCommand = runShellCommandMock;
    tokensaveDeps.isCommandOnPath = () => false;
    tokensaveDeps.platform = () => "darwin";
    tokensaveDeps.pathValue = () => "";
  });

  afterEach(() => {
    tokensaveDeps.run = originalDeps.run;
    tokensaveDeps.isCommandOnPath = originalDeps.isCommandOnPath;
    tokensaveDeps.runCommand = originalDeps.runCommand;
    tokensaveDeps.runShellCommand = originalDeps.runShellCommand;
    tokensaveDeps.platform = originalDeps.platform;
    tokensaveDeps.pathValue = originalDeps.pathValue;
  });

  test("no-ops when repoPath is undefined", async () => {
    const companionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-ts-"));
    tempRoots.push(companionDir);
    const ctx = makeCtx(companionDir);
    await tokensavePlugin.apply(ctx);
    expect(runMock).not.toHaveBeenCalled();
  });

  test("checks the binary without building the graph or installing when tokensave is already present", async () => {
    const companionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-ts-"));
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-repo-"));
    tempRoots.push(companionDir, repoDir);

    const ctx = makeCtx(companionDir, { repoPath: repoDir, providers: ["claude", "opencode"] });
    await tokensavePlugin.apply(ctx);

    const calls = runMock.mock.calls;
    expect(runCommandMock).not.toHaveBeenCalled();
    expect(runShellCommandMock).not.toHaveBeenCalled();

    // The graph build (init/sync) is the job of `mate cap index`, never plugin apply.
    expect(calls.map((c) => c[0][0])).toEqual(["--version"]);
    expect(calls[0][1]).toBe(repoDir);
  });

  test("skips unsupported agents", async () => {
    const companionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-ts-"));
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-repo-"));
    tempRoots.push(companionDir, repoDir);

    const ctx = makeCtx(companionDir, { repoPath: repoDir, providers: ["unknown-agent"] });
    await tokensavePlugin.apply(ctx);

    expect(runMock).not.toHaveBeenCalled();
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  test("installs tokensave with brew when the binary is missing, without building the graph", async () => {
    const companionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-ts-"));
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-repo-"));
    tempRoots.push(companionDir, repoDir);

    let versionChecks = 0;
    runMock = mock((args: string[]) => {
      if (args[0] === "--version") {
        versionChecks += 1;
        return { ok: versionChecks > 1, stderr: "", stdout: "" };
      }
      return { ok: true, stderr: "", stdout: "" };
    });
    tokensaveDeps.run = runMock;
    tokensaveDeps.isCommandOnPath = (command) => command === "brew";
    tokensaveDeps.pathValue = () => "/opt/homebrew/bin";

    const ctx = makeCtx(companionDir, { repoPath: repoDir, providers: ["claude"] });
    await tokensavePlugin.apply(ctx);

    expect(runCommandMock).toHaveBeenCalledWith("brew", [
      "install",
      "aovestdipaperino/tap/tokensave",
    ]);
    // Verifies install then re-checks the binary; no init/sync — that is `mate cap index`.
    expect(runMock.mock.calls.map((call) => call[0][0])).toEqual(["--version", "--version"]);
  });

  test("stops before init when tokensave is missing and no installer is available", async () => {
    const companionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-ts-"));
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-repo-"));
    tempRoots.push(companionDir, repoDir);

    runMock = mock((args: string[]) => {
      if (args[0] === "--version") {
        return { ok: false, stderr: "", stdout: "" };
      }
      return { ok: true, stderr: "", stdout: "" };
    });
    tokensaveDeps.run = runMock;

    const ctx = makeCtx(companionDir, { repoPath: repoDir, providers: ["claude"] });
    await tokensavePlugin.apply(ctx);

    expect(runCommandMock).not.toHaveBeenCalled();
    expect(runMock.mock.calls.map((call) => call[0][0])).toEqual(["--version"]);
  });

  test("runs in the working repo directory", async () => {
    const companionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-ts-"));
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-repo-"));
    tempRoots.push(companionDir, repoDir);

    const ctx = makeCtx(companionDir, { repoPath: repoDir, providers: ["claude"] });
    await tokensavePlugin.apply(ctx);

    for (const call of runMock.mock.calls) {
      expect(call[1]).toBe(repoDir);
    }
  });

  test("does not run local Claude install during sync", async () => {
    const companionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-ts-"));
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-repo-"));
    tempRoots.push(companionDir, repoDir);

    const ctx = makeCtx(companionDir, {
      repoPath: repoDir,
      providers: ["claude", "opencode"],
      mode: "sync",
    });
    await tokensavePlugin.apply(ctx);

    expect(runMock.mock.calls.map((call) => call[0][0])).toEqual(["--version"]);
  });

  test("writes tokensave MCP config into companion-local opencode.json", async () => {
    const companionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-ts-"));
    tempRoots.push(companionDir);

    await fs.mkdir(path.join(companionDir, ".opencode"), { recursive: true });
    await fs.writeFile(
      path.join(companionDir, ".opencode", "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
      }),
      "utf8",
    );

    await tokensavePlugin.forProvider!.opencode.apply(
      makeCtx(companionDir, { providers: ["opencode"] }),
    );

    const config = JSON.parse(
      await fs.readFile(path.join(companionDir, ".opencode", "opencode.json"), "utf8"),
    );
    expect(config.mcp?.tokensave).toEqual({
      type: "local",
      command: ["tokensave", "serve"],
      enabled: true,
    });
  });

  test("does not write companion Claude wiring during setup", async () => {
    const companionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-ts-"));
    tempRoots.push(companionDir);

    await tokensavePlugin.forProvider!.claude.apply(
      makeCtx(companionDir, { providers: ["claude"] }),
    );

    expect(runMock).not.toHaveBeenCalled();
    await expect(
      fs.access(path.join(companionDir, ".claude", "settings.local.json")),
    ).rejects.toThrow();
  });
});

describe("tokensavePlugin.teardown", () => {
  let runMock: mock.Mock;

  beforeEach(() => {
    runMock = mock(() => ({ ok: true, stderr: "", stdout: "" }));
    tokensaveDeps.run = runMock;
  });

  test("no-ops when repoPath is undefined", async () => {
    const companionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-ts-"));
    tempRoots.push(companionDir);
    const ctx = makeCtx(companionDir);
    await tokensavePlugin.teardown(ctx);
    expect(runMock).not.toHaveBeenCalled();
  });

  test("removes the store without invoking the local agent uninstaller", async () => {
    const companionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-ts-"));
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-repo-"));
    // Create the store directory
    await fs.mkdir(path.join(repoDir, TOKENSAVE_STORE_DIR));
    tempRoots.push(companionDir, repoDir);

    const ctx = makeCtx(companionDir, { repoPath: repoDir, providers: ["claude", "opencode"] });
    await tokensavePlugin.teardown(ctx);

    const uninstallCalls = runMock.mock.calls.filter((c) => c[0][0] === "uninstall");
    expect(uninstallCalls.length).toBe(0);

    // Store should be removed
    await expect(fs.stat(path.join(repoDir, TOKENSAVE_STORE_DIR))).rejects.toThrow();
  });

  test("removes tokensave MCP config from companion-local opencode.json", async () => {
    const companionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-ts-"));
    tempRoots.push(companionDir);

    await fs.mkdir(path.join(companionDir, ".opencode"), { recursive: true });
    await fs.writeFile(
      path.join(companionDir, ".opencode", "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        mcp: {
          tokensave: { type: "local", command: ["tokensave", "serve"], enabled: true },
          other: { type: "local", command: ["echo", "ok"], enabled: true },
        },
      }),
      "utf8",
    );

    await tokensavePlugin.forProvider!.opencode.teardown(
      makeCtx(companionDir, { providers: ["opencode"] }),
    );

    const config = JSON.parse(
      await fs.readFile(path.join(companionDir, ".opencode", "opencode.json"), "utf8"),
    );
    expect(config.mcp?.tokensave).toBeUndefined();
    expect(config.mcp?.other).toEqual({ type: "local", command: ["echo", "ok"], enabled: true });
  });
});

describe("tokensavePlugin.isEnabled", () => {
  test("returns true when tokensave capability is configured", () => {
    expect(
      tokensavePlugin.isEnabled({
        capabilities: [{ name: "tokensave" }],
      }),
    ).toBe(true);
  });

  test("returns false when tokensave is not configured", () => {
    expect(
      tokensavePlugin.isEnabled({
        capabilities: [{ name: "graphify" }],
      }),
    ).toBe(false);
  });
});
