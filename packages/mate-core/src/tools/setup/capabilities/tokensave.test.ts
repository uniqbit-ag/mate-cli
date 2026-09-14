import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SetupContext } from "../plugin";
import { reconcileOpenCodeContributions } from "../providers/opencode";
import {
  TOKENSAVE_SUPPORTED_AGENTS,
  TOKENSAVE_MIN_RUST_VERSION,
  TOKENSAVE_STORE_CONFIG_FILE,
  TOKENSAVE_STORE_DIR,
  TOKENSAVE_WORKING_REPO_EXCLUDE_ENTRIES,
  ensureTokensaveBranchingPosture,
  tokensaveDeps,
  createTokensavePlugin,
} from "./tokensave";

const tokensavePlugin = createTokensavePlugin();

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
      allowedAgents: opts?.providers ?? [],
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
  let rustcVersionMock: mock.Mock;
  let originalDeps: typeof tokensaveDeps;

  beforeEach(() => {
    originalDeps = { ...tokensaveDeps };
    runMock = mock(() => ({ ok: true, stderr: "", stdout: "" }));
    runCommandMock = mock(async () => {});
    runShellCommandMock = mock(async () => {});
    rustcVersionMock = mock(() => ({ ok: true, stderr: "", stdout: "rustc 1.91.0" }));
    tokensaveDeps.run = runMock;
    tokensaveDeps.runCommand = runCommandMock;
    tokensaveDeps.runShellCommand = runShellCommandMock;
    tokensaveDeps.rustcVersion = rustcVersionMock;
    tokensaveDeps.isCommandOnPath = () => false;
    tokensaveDeps.platform = () => "darwin";
    tokensaveDeps.pathValue = () => "";
  });

  afterEach(() => {
    tokensaveDeps.run = originalDeps.run;
    tokensaveDeps.isCommandOnPath = originalDeps.isCommandOnPath;
    tokensaveDeps.runCommand = originalDeps.runCommand;
    tokensaveDeps.runShellCommand = originalDeps.runShellCommand;
    tokensaveDeps.rustcVersion = originalDeps.rustcVersion;
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
    expect(calls.map((c) => c[0][0])).toEqual(["--version", "upgrade", "install", "install"]);
    expect(calls[0][1]).toBe(repoDir);
  });

  test("continues setup when the automatic upgrade fails", async () => {
    const companionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-ts-"));
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-repo-"));
    tempRoots.push(companionDir, repoDir);

    runMock = mock((args: string[]) => {
      if (args[0] === "upgrade") {
        return { ok: false, stderr: "network unavailable", stdout: "" };
      }
      return { ok: true, stderr: "", stdout: "" };
    });
    tokensaveDeps.run = runMock;

    const stderrWrites: string[] = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      await tokensavePlugin.apply(
        makeCtx(companionDir, { repoPath: repoDir, providers: ["claude"] }),
      );
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    expect(runMock.mock.calls.map((call) => call[0][0])).toEqual([
      "--version",
      "upgrade",
      "install",
    ]);
    expect(runMock.mock.calls[1][0]).toEqual(["upgrade", "--kill"]);
    expect(stderrWrites.join("")).toContain("automatic upgrade failed");
    expect(stderrWrites.join("")).toContain("network unavailable");
  });

  test("runs the native agent installer per active provider in sorted order during setup", async () => {
    const companionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-ts-"));
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-repo-"));
    tempRoots.push(companionDir, repoDir);

    const ctx = makeCtx(companionDir, { repoPath: repoDir, providers: ["opencode", "claude"] });
    await tokensavePlugin.apply(ctx);

    const installCalls = runMock.mock.calls.filter((c) => c[0][0] === "install");
    expect(installCalls.map((c) => c[0])).toEqual([
      ["install", "--agent", "claude", "--git-hook", "no", "--wildcard-permissions"],
      ["install", "--agent", "opencode", "--git-hook", "no", "--wildcard-permissions"],
    ]);
    for (const call of installCalls) {
      expect(call[1]).toBe(repoDir);
    }
  });

  test("skips the native agent installer for unsupported providers", async () => {
    const companionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-ts-"));
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-repo-"));
    tempRoots.push(companionDir, repoDir);

    const ctx = makeCtx(companionDir, {
      repoPath: repoDir,
      providers: ["claude", "unknown-agent"],
    });
    await tokensavePlugin.apply(ctx);

    const installCalls = runMock.mock.calls.filter((c) => c[0][0] === "install");
    expect(installCalls.map((c) => c[0])).toEqual([
      ["install", "--agent", "claude", "--git-hook", "no", "--wildcard-permissions"],
    ]);
  });

  test("reports a failed native agent install on stderr without failing setup", async () => {
    const companionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-ts-"));
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-repo-"));
    tempRoots.push(companionDir, repoDir);

    runMock = mock((args: string[]) => {
      if (args[0] === "install") {
        return { ok: false, stderr: "boom", stdout: "" };
      }
      return { ok: true, stderr: "", stdout: "" };
    });
    tokensaveDeps.run = runMock;

    const stderrWrites: string[] = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const ctx = makeCtx(companionDir, { repoPath: repoDir, providers: ["claude", "opencode"] });
      await tokensavePlugin.apply(ctx);
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    // Both providers are still attempted despite the first failure.
    const installCalls = runMock.mock.calls.filter((c) => c[0][0] === "install");
    expect(installCalls.length).toBe(2);
    expect(stderrWrites.join("")).toContain("claude");
    expect(stderrWrites.join("")).toContain("opencode");
    expect(stderrWrites.join("")).toContain("boom");
  });

  test("never creates or modifies the global tokensave config itself", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-home-"));
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-repo-"));
    tempRoots.push(homeDir, repoDir);

    const configFile = path.join(homeDir, ".tokensave", "config.toml");
    const originalHome = process.env.HOME;
    process.env.HOME = homeDir;

    /** A per-project store exists, so apply's posture reconciliation actually writes. */
    await fs.mkdir(path.join(repoDir, TOKENSAVE_STORE_DIR), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, TOKENSAVE_STORE_DIR, TOKENSAVE_STORE_CONFIG_FILE),
      JSON.stringify({ exclude: ["dist"] }, null, 2) + "\n",
      "utf8",
    );

    try {
      // Absent config stays absent.
      await tokensavePlugin.apply(
        makeCtx(homeDir, { repoPath: repoDir, providers: ["claude", "opencode"] }),
      );
      await expect(fs.access(configFile)).rejects.toThrow();

      const repoConfig = JSON.parse(
        await fs.readFile(
          path.join(repoDir, TOKENSAVE_STORE_DIR, TOKENSAVE_STORE_CONFIG_FILE),
          "utf8",
        ),
      );
      expect(repoConfig).toEqual({
        exclude: ["dist"],
        auto_track: false,
        suppress_scope_warning: true,
      });

      // Pre-existing config stays byte-identical.
      const original = `upload_enabled = true\ninstalled_agents = ["claude"]\n`;
      await fs.mkdir(path.dirname(configFile), { recursive: true });
      await fs.writeFile(configFile, original, "utf8");
      await tokensavePlugin.apply(
        makeCtx(homeDir, { repoPath: repoDir, providers: ["claude", "opencode"] }),
      );
      expect(await fs.readFile(configFile, "utf8")).toBe(original);
    } finally {
      process.env.HOME = originalHome;
    }
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
    expect(runMock.mock.calls.map((call) => call[0][0])).toEqual([
      "--version",
      "--version",
      "install",
    ]);
  });

  test("installs tokensave with cargo using its lockfile", async () => {
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
    tokensaveDeps.isCommandOnPath = (command) => command === "cargo";
    tokensaveDeps.pathValue = () => "/usr/bin";

    await tokensavePlugin.apply(
      makeCtx(companionDir, { repoPath: repoDir, providers: ["claude"] }),
    );

    expect(runCommandMock).toHaveBeenCalledWith("cargo", ["install", "--locked", "tokensave"]);
    expect(
      tokensavePlugin.getInstallRequirements?.({
        companionPath: companionDir,
        config: makeCtx(companionDir).config,
      })[0]?.command,
    ).toBe("cargo install --locked tokensave");
  });

  test("rejects cargo installation when Rust is below the minimum", async () => {
    const companionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-ts-"));
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-repo-"));
    tempRoots.push(companionDir, repoDir);

    runMock = mock((args: string[]) => {
      if (args[0] === "--version") return { ok: false, stderr: "", stdout: "" };
      return { ok: true, stderr: "", stdout: "" };
    });
    tokensaveDeps.run = runMock;
    tokensaveDeps.rustcVersion = () => ({
      ok: true,
      stderr: "",
      stdout: "rustc 1.90.0 (abc 2026-01-01)",
    });
    tokensaveDeps.isCommandOnPath = (command) => command === "cargo";
    tokensaveDeps.pathValue = () => "/usr/bin";

    const stderrWrites: string[] = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      await tokensavePlugin.apply(
        makeCtx(companionDir, { repoPath: repoDir, providers: ["claude"] }),
      );
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    expect(runCommandMock).not.toHaveBeenCalled();
    expect(stderrWrites.join("")).toContain(
      `TokenSave requires Rust ${TOKENSAVE_MIN_RUST_VERSION} or newer`,
    );
    expect(stderrWrites.join("")).toContain("Upgrade Rust");
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

  test("does not run the native agent installer during sync", async () => {
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

  test("declares MCP, hook, and permission contributions per runtime", () => {
    const byRuntime = tokensavePlugin.getRuntimeContributions!(
      makeCtx("/companion", { providers: ["claude", "opencode"] }),
    );

    expect(byRuntime.claude?.mcpServers).toEqual([
      { name: "tokensave", command: "tokensave", args: ["serve"] },
    ]);
    expect(byRuntime.opencode?.mcpServers).toEqual([
      { name: "tokensave", command: "tokensave", args: ["serve"] },
    ]);
    expect(byRuntime.opencode?.hookGroups).toBeUndefined();

    const hookGroups = byRuntime.claude?.hookGroups ?? [];
    expect(hookGroups.map((hook) => hook.event)).toEqual([
      "PreToolUse",
      "UserPromptSubmit",
      "Stop",
    ]);
    for (const hook of hookGroups) {
      expect(hook.marker).toBe("tokensave");
      expect(hook.group.hooks?.[0]?.command).toContain("tokensave");
    }

    expect(byRuntime.claude?.permissionEntries).toEqual(["mcp__tokensave__*"]);
  });

  test("contributes no branch-tracking hook group, plugin, or MCP entry", async () => {
    const ctx = makeCtx("/companion", { providers: ["claude", "opencode"] });
    const byRuntime = tokensavePlugin.getRuntimeContributions!(ctx);

    for (const contributions of Object.values(byRuntime)) {
      expect(JSON.stringify(contributions)).not.toContain("branch");
      expect((contributions as { plugins?: unknown[] }).plugins ?? []).toEqual([]);
    }
  });

  test("keeps passing --git-hook no to the native installer", async () => {
    const companionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-ts-"));
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-repo-"));
    tempRoots.push(companionDir, repoDir);

    await tokensavePlugin.apply(
      makeCtx(companionDir, { repoPath: repoDir, providers: ["claude", "opencode"] }),
    );

    const installCalls = runMock.mock.calls.filter((c) => c[0][0] === "install");
    expect(installCalls.length).toBe(2);
    for (const call of installCalls) {
      const args = call[0] as string[];
      expect(args[args.indexOf("--git-hook") + 1]).toBe("no");
    }
  });

  test("invokes no tokensave branch subcommand", async () => {
    const companionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-ts-"));
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-repo-"));
    tempRoots.push(companionDir, repoDir);
    await fs.mkdir(path.join(repoDir, TOKENSAVE_STORE_DIR), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, TOKENSAVE_STORE_DIR, TOKENSAVE_STORE_CONFIG_FILE),
      "{}\n",
      "utf8",
    );

    const ctx = makeCtx(companionDir, { repoPath: repoDir, providers: ["claude", "opencode"] });
    await tokensavePlugin.apply(ctx);
    await tokensavePlugin.teardown!(ctx);

    expect(runMock.mock.calls.some((c) => (c[0] as string[]).includes("branch"))).toBe(false);
  });

  test("apply does not write companion runtime config directly", async () => {
    const companionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-ts-"));
    tempRoots.push(companionDir);

    await tokensavePlugin.apply(makeCtx(companionDir, { providers: ["claude", "opencode"] }));

    await expect(
      fs.access(path.join(companionDir, ".claude", "settings.local.json")),
    ).rejects.toThrow();
    await expect(fs.access(path.join(companionDir, ".mcp.json"))).rejects.toThrow();
    await expect(
      fs.access(path.join(companionDir, ".opencode", "opencode.json")),
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

  test("declared opencode MCP entry drives teardown through the Runtime Surface", async () => {
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

    const ctx = makeCtx(companionDir, { providers: ["opencode"] });
    await reconcileOpenCodeContributions(ctx, [
      {
        pluginId: "tokensave",
        enabled: false,
        contributions: tokensavePlugin.getRuntimeContributions!(ctx).opencode!,
      },
    ]);

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

describe("ensureTokensaveBranchingPosture", () => {
  async function makeStore(config?: unknown): Promise<string> {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-repo-"));
    tempRoots.push(repoDir);
    if (config !== undefined) {
      await fs.mkdir(path.join(repoDir, TOKENSAVE_STORE_DIR), { recursive: true });
      await fs.writeFile(
        path.join(repoDir, TOKENSAVE_STORE_DIR, TOKENSAVE_STORE_CONFIG_FILE),
        typeof config === "string" ? config : JSON.stringify(config, null, 2) + "\n",
        "utf8",
      );
    }
    return repoDir;
  }

  function configPath(repoDir: string): string {
    return path.join(repoDir, TOKENSAVE_STORE_DIR, TOKENSAVE_STORE_CONFIG_FILE);
  }

  function branchMetaPath(repoDir: string): string {
    return path.join(repoDir, TOKENSAVE_STORE_DIR, "branch-meta.json");
  }

  function disabledBranchMetaPath(repoDir: string): string {
    return path.join(repoDir, TOKENSAVE_STORE_DIR, "branch-meta.json.mate-disabled");
  }

  test("writes the single-graph posture once a store exists", async () => {
    const repoDir = await makeStore({ exclude: ["dist"] });

    await ensureTokensaveBranchingPosture(repoDir);

    const config = JSON.parse(await fs.readFile(configPath(repoDir), "utf8"));
    expect(config.auto_track).toBe(false);
    expect(config.suppress_scope_warning).toBe(true);
  });

  test("preserves keys Mate does not own", async () => {
    const unowned = {
      exclude: ["dist", "node_modules"],
      max_file_size: 1048576,
      artifact_extensions: [".md"],
    };
    const repoDir = await makeStore({ ...unowned, auto_track: true });

    await ensureTokensaveBranchingPosture(repoDir);

    const config = JSON.parse(await fs.readFile(configPath(repoDir), "utf8"));
    expect(config.exclude).toEqual(unowned.exclude);
    expect(config.max_file_size).toBe(unowned.max_file_size);
    expect(config.artifact_extensions).toEqual(unowned.artifact_extensions);
    expect(Object.keys(config).sort()).toEqual(
      [...Object.keys(unowned), "auto_track", "suppress_scope_warning"].sort(),
    );
  });

  test("is idempotent across repeated runs", async () => {
    const repoDir = await makeStore({ exclude: ["dist"] });

    await ensureTokensaveBranchingPosture(repoDir);
    const first = await fs.readFile(configPath(repoDir), "utf8");
    await ensureTokensaveBranchingPosture(repoDir);

    expect(await fs.readFile(configPath(repoDir), "utf8")).toBe(first);
  });

  test("deactivates branch metadata without deleting branch databases", async () => {
    const repoDir = await makeStore({ exclude: ["dist"] });
    const branchMeta =
      JSON.stringify(
        {
          default_branch: "main",
          branches: {
            main: { db_file: "tokensave.db" },
            "feature/acme": { db_file: "branches/feature_acme.db" },
          },
        },
        null,
        2,
      ) + "\n";
    const branchDbPath = path.join(repoDir, TOKENSAVE_STORE_DIR, "branches", "feature_acme.db");
    await fs.writeFile(branchMetaPath(repoDir), branchMeta, "utf8");
    await fs.mkdir(path.dirname(branchDbPath), { recursive: true });
    await fs.writeFile(branchDbPath, "branch database", "utf8");

    await ensureTokensaveBranchingPosture(repoDir);
    await ensureTokensaveBranchingPosture(repoDir);

    await expect(fs.access(branchMetaPath(repoDir))).rejects.toThrow();
    expect(await fs.readFile(disabledBranchMetaPath(repoDir), "utf8")).toBe(branchMeta);
    expect(await fs.readFile(branchDbPath, "utf8")).toBe("branch database");
  });

  test("leaves an absent store alone", async () => {
    const repoDir = await makeStore();

    await ensureTokensaveBranchingPosture(repoDir);

    await expect(fs.access(configPath(repoDir))).rejects.toThrow();
  });

  test("leaves an unparseable config untouched", async () => {
    const broken = "{ not json";
    const repoDir = await makeStore(broken);

    await ensureTokensaveBranchingPosture(repoDir);

    expect(await fs.readFile(configPath(repoDir), "utf8")).toBe(broken);
  });

  test("leaves a non-object config untouched", async () => {
    const list = "[1, 2]";
    const repoDir = await makeStore(list);

    await ensureTokensaveBranchingPosture(repoDir);

    expect(await fs.readFile(configPath(repoDir), "utf8")).toBe(list);
  });
});

describe("tokensave branch databases", () => {
  test("no Mate source path invokes tokensave branch removal or gc", async () => {
    const srcRoot = path.resolve(import.meta.dir, "../../..");
    const entries = await fs.readdir(srcRoot, { recursive: true, withFileTypes: true });
    const sources = entries.filter(
      (entry) =>
        entry.isFile() &&
        /\.tsx?$/.test(entry.name) &&
        !/\.test\.tsx?$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts"),
    );
    expect(sources.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const entry of sources) {
      const file = path.join(entry.parentPath ?? entry.path, entry.name);
      const content = await fs.readFile(file, "utf8");
      if (/\bbranch\s+(remove|removeall|gc)\b/.test(content) || /\[\s*"branch"/.test(content)) {
        offenders.push(path.relative(srcRoot, file));
      }
    }

    expect(offenders).toEqual([]);
  });
});
