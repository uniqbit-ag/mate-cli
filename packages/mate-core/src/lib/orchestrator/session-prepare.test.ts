import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { UnattendedSyncOutcome } from "../../runtime/companion-sync";
import { EMPTY_MANIFEST } from "../../runtime/runtime-document-manifest";
import { parsePrepareOutput } from "../../runtime/session-prepare-runner";
import { wrapStateOf } from "../../runtime/wrap-state";
import { publishClaudePluginFolders } from "../../tools/setup/providers/claude-plugin-folders";
import { prepareSession, sessionPrepareDeps } from "./session-prepare";
import { LaunchPreflightError, type FrameworkConfig } from "./types";

const original = { ...sessionPrepareDeps };
const calls: string[] = [];
const lockOptions: Array<{ wait?: boolean; timeoutMs?: number }> = [];
const repository = { id: "acme", path: "/work/acme" };
const companionPath = "/companions/acme";
const passWrapState = wrapStateOf(EMPTY_MANIFEST);
const config = { allowedAgents: ["opencode", "claude"], capabilities: [], git: "auto" } as never;
/** A sync pass that gathered no Claude plugin folder. */
const NO_PLUGIN_FOLDERS = { launch: [], loadWarnings: [], published: [], report: [] };

function unattended(outcome: Partial<UnattendedSyncOutcome>) {
  return mock(async () => {
    calls.push("unattended");
    return {
      status: "complete",
      changed: false,
      companionPath,
      ...outcome,
    } as UnattendedSyncOutcome;
  });
}

function stub(overrides: Partial<FrameworkConfig> = {}): void {
  sessionPrepareDeps.readCompanionConfig = mock(async () => {
    calls.push("config");
    return { ...(config as object), ...overrides } as never;
  });
  sessionPrepareDeps.syncCompanionGit = mock(async () => {
    calls.push("git");
    return { skipped: false, changed: false, companionPath };
  });
  sessionPrepareDeps.syncCompanionUnattended = unattended({});
  sessionPrepareDeps.recordCompanionSyncUnfinished = mock(() => true);
  sessionPrepareDeps.syncCompanionFiles = mock(async () => {
    calls.push("files");
    return NO_PLUGIN_FOLDERS;
  });
  sessionPrepareDeps.projectLaunch = mock(async () => {
    calls.push("launch");
    return { root: "", scope: "launch" as const, outcomes: [] };
  });
  sessionPrepareDeps.refreshProjectionRoot = mock(async () => {
    calls.push("projection-root");
    return { kind: "current" } as never;
  });
  sessionPrepareDeps.runWrapPass = mock(async () => {
    calls.push("wrap");
    return {
      kind: "current" as const,
      projectionRoot: "",
      companionPath,
      documents: [],
      writtenDocuments: [],
      changed: { written: [], removed: [] },
      warnings: ["acme shadowed"],
      runtimes: new Set<"claude" | "opencode">(),
      wrapState: passWrapState,
    };
  });
  sessionPrepareDeps.runCapabilityPreflight = mock(async () => {
    calls.push("preflight");
  });
  sessionPrepareDeps.isInteractiveTerminal = () => false;
  sessionPrepareDeps.withCompanionLock = (async (
    _companion: string,
    options: { wait?: boolean; timeoutMs?: number },
    task: () => Promise<unknown>,
  ) => {
    lockOptions.push(options);
    return { acquired: true, value: await task() };
  }) as never;
}

beforeEach(() => {
  calls.length = 0;
  lockOptions.length = 0;
  stub();
});

afterEach(() => {
  Object.assign(sessionPrepareDeps, original);
});

describe("attended", () => {
  test("waits for the lock, runs the full sync, then one wrap pass for OpenCode", async () => {
    const result = await prepareSession({
      runtime: "opencode",
      companionPath,
      repository,
      mode: "attended",
    });

    expect(calls).toEqual(["config", "git", "files", "wrap", "preflight"]);
    expect(lockOptions[0]?.wait).not.toBe(false);
    expect(lockOptions[0]?.timeoutMs).toBe(Number.POSITIVE_INFINITY);
    expect(sessionPrepareDeps.syncCompanionGit).toHaveBeenCalledWith(
      companionPath,
      repository.path,
      false,
    );
    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.step)).toEqual([
      "git-sync",
      "file-sync",
      "working-target",
      "preflight",
    ]);
    expect(result.warnings).toEqual(["acme shadowed"]);
  });

  test("lets Git prompt when a terminal is attached", async () => {
    sessionPrepareDeps.isInteractiveTerminal = () => true;

    await prepareSession({ runtime: "opencode", companionPath, repository, mode: "attended" });

    expect(sessionPrepareDeps.syncCompanionGit).toHaveBeenCalledWith(
      companionPath,
      repository.path,
      true,
    );
  });

  test("a failed sync fails the prepare before anything local runs", async () => {
    const error = new Error("merge conflict in acme.md");
    sessionPrepareDeps.syncCompanionGit = mock(async () => {
      throw error;
    });

    const result = await prepareSession({
      runtime: "opencode",
      companionPath,
      repository,
      mode: "attended",
    });

    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([
      { step: "git-sync", outcome: "failed", detail: "merge conflict in acme.md" },
    ]);
    expect(result.failure).toBe(error);
    expect(calls).toEqual(["config"]);
  });

  test("stops at the first failed local step", async () => {
    sessionPrepareDeps.syncCompanionFiles = mock(async () => {
      throw new Error("acme unreadable");
    });

    const result = await prepareSession({
      runtime: "opencode",
      companionPath,
      repository,
      mode: "attended",
    });

    expect(result.ok).toBe(false);
    expect(calls).toEqual(["config", "git"]);
    expect((result.failure as Error).message).toBe("acme unreadable");
  });

  test("--no-git skips only the Git sync", async () => {
    const result = await prepareSession({
      runtime: "opencode",
      companionPath,
      repository,
      mode: "attended",
      skipGit: true,
    });

    expect(calls).toEqual(["config", "files", "wrap", "preflight"]);
    expect(result.steps[0]).toMatchObject({ step: "git-sync", outcome: "skipped" });
  });

  test("a companion without auto Git skips the Git step", async () => {
    stub({ git: "default" });

    const result = await prepareSession({
      runtime: "opencode",
      companionPath,
      repository,
      mode: "attended",
    });

    expect(result.steps[0]).toMatchObject({ step: "git-sync", outcome: "skipped" });
    expect(calls).not.toContain("git");
  });

  test("reads a given config only again after a sync changed the companion", async () => {
    await prepareSession({
      runtime: "opencode",
      companionPath,
      repository,
      mode: "attended",
      config,
    });
    expect(calls).not.toContain("config");

    calls.length = 0;
    sessionPrepareDeps.syncCompanionGit = mock(async () => {
      calls.push("git");
      return { skipped: false, changed: true, companionPath };
    });
    await prepareSession({
      runtime: "opencode",
      companionPath,
      repository,
      mode: "attended",
      config,
    });
    expect(calls).toEqual(["git", "config", "files", "wrap", "preflight"]);
  });

  test("reports the paths the wrap pass changed in the working-target step", async () => {
    sessionPrepareDeps.runWrapPass = mock(async () => ({
      kind: "written" as const,
      projectionRoot: "",
      companionPath,
      documents: [".opencode/opencode.json"],
      writtenDocuments: [".opencode/opencode.json"],
      changed: { written: [".opencode/commands/a.md"], removed: [".opencode/commands/c.md"] },
      warnings: [],
      runtimes: new Set(["opencode" as const]),
      wrapState: passWrapState,
    }));

    const result = await prepareSession({
      runtime: "opencode",
      companionPath,
      repository,
      mode: "attended",
    });

    expect(result.steps.find((step) => step.step === "working-target")?.detail).toBe(
      "updated (wrote .opencode/opencode.json, .opencode/commands/a.md; withdrew .opencode/commands/c.md)",
    );
    expect(result.warnings).toEqual([]);
  });

  test("hands the wrap pass the config it already read", async () => {
    await prepareSession({ runtime: "opencode", companionPath, repository, mode: "attended" });

    expect(sessionPrepareDeps.runWrapPass).toHaveBeenCalledWith(companionPath, repository, {
      runtimes: ["opencode"],
      config: expect.objectContaining({ git: "auto" }),
    });
  });
});

describe("attended Claude", () => {
  test("every launch runs the Claude wrap pass after the launch scope", async () => {
    const result = await prepareSession({
      runtime: "claude",
      companionPath,
      repository,
      mode: "attended",
      config,
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["git", "files", "launch", "projection-root", "wrap", "preflight"]);
    expect(sessionPrepareDeps.projectLaunch).toHaveBeenCalledWith({
      repoPath: repository.path,
      companionPath,
      config,
    });
    expect(sessionPrepareDeps.runWrapPass).toHaveBeenCalledWith(companionPath, repository, {
      runtimes: ["claude"],
      config,
    });
    expect(result.steps.find((step) => step.step === "working-target")).toMatchObject({
      outcome: "ok",
      runtimes: ["claude"],
    });
    expect(result.wrapState).toBe(passWrapState);
    expect(sessionPrepareDeps.runCapabilityPreflight).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "claude", repository }),
    );
  });

  test("a failed Claude wrap pass fails the launch naming the entry", async () => {
    sessionPrepareDeps.runWrapPass = mock(async () => ({
      kind: "failed" as const,
      message: "failed to write .claude/settings.local.json for acme: EACCES",
    }));

    const result = await prepareSession({
      runtime: "claude",
      companionPath,
      repository,
      mode: "attended",
      config,
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toBeInstanceOf(LaunchPreflightError);
    expect((result.failure as Error).message).toContain(".claude/settings.local.json");
    expect(calls).not.toContain("preflight");
  });

  test("a degradable projection failure warns and the prepare proceeds", async () => {
    sessionPrepareDeps.projectLaunch = mock(async () => ({
      root: "",
      scope: "launch" as const,
      outcomes: [
        {
          id: "companion-link" as const,
          path: ".mate/companion",
          kind: "owned" as const,
          state: "failed" as const,
          error: new Error("EPERM"),
          degradable: true,
        },
      ],
    }));

    const result = await prepareSession({
      runtime: "claude",
      companionPath,
      repository,
      mode: "attended",
      config,
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      "failed to write .mate/companion for acme: EPERM",
      "acme shadowed",
    ]);
  });

  test("a non-degradable projection failure fails the prepare", async () => {
    sessionPrepareDeps.projectLaunch = mock(async () => ({
      root: "",
      scope: "launch" as const,
      outcomes: [
        {
          id: "claude-working-settings" as const,
          path: ".claude/settings.local.json",
          kind: "merged" as const,
          state: "failed" as const,
          error: new Error("EACCES"),
        },
      ],
    }));

    const result = await prepareSession({
      runtime: "claude",
      companionPath,
      repository,
      mode: "attended",
      config,
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toBeInstanceOf(LaunchPreflightError);
    expect((result.failure as Error).message).toBe(
      "mate: failed to write .claude/settings.local.json for acme: EACCES",
    );
    expect(calls).not.toContain("preflight");
  });

  test("a companion-scope launch syncs the companion and skips the projection", async () => {
    const result = await prepareSession({
      runtime: "claude",
      companionPath,
      mode: "attended",
      config,
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["git", "files", "preflight"]);
    expect(sessionPrepareDeps.runWrapPass).not.toHaveBeenCalled();
    expect(sessionPrepareDeps.syncCompanionGit).toHaveBeenCalledWith(
      companionPath,
      undefined,
      false,
    );
    expect(sessionPrepareDeps.syncCompanionFiles).toHaveBeenCalledWith(companionPath, config);
  });
});

describe("local", () => {
  test("only tries the lock and runs no Git", async () => {
    const result = await prepareSession({
      runtime: "opencode",
      companionPath,
      repository,
      mode: "local",
    });

    expect(lockOptions[0]?.wait).toBe(false);
    expect(calls).toEqual(["config", "files", "wrap", "preflight"]);
    expect(result.ok).toBe(true);
  });

  test("a held lock skips at once without a warning", async () => {
    sessionPrepareDeps.withCompanionLock = (async () => ({ acquired: false })) as never;

    const result = await prepareSession({
      runtime: "opencode",
      companionPath,
      repository,
      mode: "local",
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.steps).toEqual([expect.objectContaining({ step: "lock", outcome: "skipped" })]);
  });

  test("a failed step fails the result while the rest still runs", async () => {
    sessionPrepareDeps.syncCompanionFiles = mock(async () => {
      throw new Error("acme unreadable");
    });
    sessionPrepareDeps.runCapabilityPreflight = mock(async () => {
      throw new Error("tokensave index missing");
    });

    const result = await prepareSession({
      runtime: "opencode",
      companionPath,
      repository,
      mode: "local",
    });

    expect(result.ok).toBe(false);
    expect(calls).toEqual(["config", "wrap"]);
    expect(result.steps.at(-1)).toMatchObject({ step: "preflight", outcome: "failed" });
  });
});

describe("wrapped runtimes", () => {
  test("one wrap pass for every wrapped runtime, then a preflight each", async () => {
    const result = await prepareSession({
      runtime: "claude",
      runtimes: ["claude", "opencode"],
      companionPath,
      repository,
      mode: "local",
    });

    expect(calls).toEqual(["config", "files", "wrap", "preflight", "preflight"]);
    expect(sessionPrepareDeps.runWrapPass).toHaveBeenCalledWith(companionPath, repository, {
      runtimes: ["claude", "opencode"],
      config: expect.anything(),
    });
    expect(sessionPrepareDeps.projectLaunch).not.toHaveBeenCalled();
    expect(result.runtimes).toEqual(["claude", "opencode"]);
    expect(
      result.steps.filter((step) => step.step === "preflight").map((step) => step.runtimes),
    ).toEqual([["claude"], ["opencode"]]);
  });

  test("a Claude-only wrap reconciles only Claude", async () => {
    await prepareSession({
      runtime: "claude",
      runtimes: ["claude"],
      companionPath,
      repository,
      mode: "local",
    });

    expect(sessionPrepareDeps.runWrapPass).toHaveBeenCalledWith(companionPath, repository, {
      runtimes: ["claude"],
      config: expect.anything(),
    });
    expect(sessionPrepareDeps.runCapabilityPreflight).toHaveBeenCalledTimes(1);
  });

  test("an unfinished sync names the Claude launch for a Claude wrap", async () => {
    sessionPrepareDeps.syncCompanionUnattended = unattended({
      status: "unfinished",
      reason: "remote unreachable",
    });

    const result = await prepareSession({
      runtime: "claude",
      runtimes: ["claude"],
      companionPath,
      repository,
      mode: "sync",
    });

    expect(result.warnings.join("\n")).toContain("`mate claude`");
    expect(result.warnings.join("\n")).not.toContain("mate opencode");
  });
});

describe("sync", () => {
  test("waits for the lock and fetches regardless of the freshness interval", async () => {
    await prepareSession({ runtime: "opencode", companionPath, repository, mode: "sync" });

    expect(lockOptions[0]?.wait).not.toBe(false);
    expect(Number.isFinite(lockOptions[0]?.timeoutMs)).toBe(true);
    expect(sessionPrepareDeps.syncCompanionUnattended).toHaveBeenCalledWith(companionPath, {
      ttlMs: 0,
    });
  });

  test("an unchanged companion skips the local phase", async () => {
    const result = await prepareSession({
      runtime: "opencode",
      companionPath,
      repository,
      mode: "sync",
    });

    expect(calls).toEqual(["unattended"]);
    expect(result.ok).toBe(true);
    expect(result.steps).toEqual([
      expect.objectContaining({ step: "git-sync", outcome: "ok", detail: "current" }),
    ]);
  });

  test("a changed companion is re-read and re-projected", async () => {
    sessionPrepareDeps.syncCompanionUnattended = unattended({ changed: true });

    const result = await prepareSession({
      runtime: "opencode",
      companionPath,
      repository,
      mode: "sync",
    });

    expect(calls).toEqual(["unattended", "config", "files", "wrap", "preflight"]);
    expect(result.ok).toBe(true);
    expect(result.companionChanged).toBe(true);
  });

  test("an unfinished sync is a warning pointing OpenCode at mate opencode", async () => {
    sessionPrepareDeps.syncCompanionUnattended = unattended({
      status: "unfinished",
      reason: "history has diverged from origin/main",
    });

    const result = await prepareSession({
      runtime: "opencode",
      companionPath,
      repository,
      mode: "sync",
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["unattended"]);
    expect(result.steps[0]).toMatchObject({ step: "git-sync", outcome: "warning" });
    expect(result.warnings.join("\n")).toContain("diverged");
    expect(result.warnings.join("\n")).toContain("mate opencode");
    expect(result.warnings.join("\n")).not.toContain("mate companion sync");
  });

  test("a sync that throws is stored, so the TUI lines carry it", async () => {
    sessionPrepareDeps.syncCompanionUnattended = mock(async () => {
      throw new Error("acme exploded");
    });

    const result = await prepareSession({
      runtime: "opencode",
      companionPath,
      repository,
      mode: "sync",
    });

    expect(result.ok).toBe(true);
    expect(sessionPrepareDeps.recordCompanionSyncUnfinished).toHaveBeenCalledWith(
      companionPath,
      "acme exploded",
    );
    expect(result.warnings.join("\n")).toContain("acme exploded");
  });

  test("a lock not released in time gives up with a warning", async () => {
    sessionPrepareDeps.withCompanionLock = (async () => ({ acquired: false })) as never;

    const result = await prepareSession({
      runtime: "opencode",
      companionPath,
      repository,
      mode: "sync",
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([]);
    expect(result.steps).toEqual([expect.objectContaining({ step: "lock", outcome: "warning" })]);
    expect(result.warnings).toHaveLength(1);
  });
});

describe("Claude plugin folders", () => {
  const folder = "/companions/acme/.mate/plugins/acme-plugin";
  const leftOut =
    "acme: Claude plugin folder /nowhere holds no .claude-plugin/plugin.json; it was left out.";

  beforeEach(() => {
    sessionPrepareDeps.syncCompanionFiles = mock(async () => {
      calls.push("files");
      return { ...NO_PLUGIN_FOLDERS, launch: [folder], loadWarnings: [leftOut] };
    });
  });

  test("an attended prepare hands the launch its folders and reports what it left out", async () => {
    const result = await prepareSession({
      runtime: "claude",
      companionPath,
      repository,
      mode: "attended",
      config,
    });

    expect(result.claudePluginDirectories).toEqual([folder]);
    expect(result.warnings).toEqual([leftOut, "acme shadowed"]);
  });

  test("a companion-scoped launch gets its folders too", async () => {
    const result = await prepareSession({
      runtime: "claude",
      companionPath,
      mode: "attended",
      config,
    });

    expect(result.claudePluginDirectories).toEqual([folder]);
    expect(result.warnings).toEqual([leftOut]);
  });

  test("an OpenCode launch reports no Claude plugin-folder warning", async () => {
    const result = await prepareSession({
      runtime: "opencode",
      companionPath,
      mode: "attended",
      config,
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  test("a plain session's local prepare reports no plugin-folder warning", async () => {
    const result = await prepareSession({
      runtime: "claude",
      runtimes: ["claude"],
      companionPath,
      repository,
      mode: "local",
    });

    expect(result.warnings).toEqual(["acme shadowed"]);
  });

  test("the notes a plain session's prepare hook prints name no plugin folder", async () => {
    const {
      failure: _failure,
      wrapState: _wrapState,
      ...reported
    } = await prepareSession({
      runtime: "claude",
      runtimes: ["claude"],
      companionPath,
      repository,
      mode: "local",
    });

    const { notes } = parsePrepareOutput(JSON.stringify(reported), 0);

    expect(notes).toEqual(["acme shadowed"]);
  });

  test("a plain session's sync prepare reports no plugin-folder warning", async () => {
    sessionPrepareDeps.syncCompanionUnattended = unattended({ changed: true });

    const result = await prepareSession({
      runtime: "claude",
      runtimes: ["claude"],
      companionPath,
      repository,
      mode: "sync",
    });

    expect(calls).toContain("files");
    expect(result.warnings).toEqual(["acme shadowed"]);
  });
});

describe.skipIf(process.getuid?.() === 0)("a Claude plugin folder Mate cannot write", () => {
  let root: string;
  let folder: string;

  /** What every pass learns of the folder: Mate's marketplace file could not be written. */
  const publish = () =>
    publishClaudePluginFolders(
      [
        {
          pluginId: "acme-cap",
          enabled: true,
          contributions: { pluginDirectories: [{ path: folder }] },
        },
      ],
      { bundledPluginRoot: path.join(root, "bundled"), userMarketplaces: new Map() },
    );

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "prepare-plugin-folder-")));
    folder = path.join(root, "acme");
    await fs.mkdir(path.join(folder, ".claude-plugin"), { recursive: true });
    await fs.writeFile(path.join(folder, ".claude-plugin", "plugin.json"), `{"name":"acme"}\n`);
    await fs.chmod(path.join(folder, ".claude-plugin"), 0o555);
    sessionPrepareDeps.syncCompanionFiles = mock(async () => publish());
    sessionPrepareDeps.runWrapPass = mock(async () => ({
      kind: "current" as const,
      projectionRoot: "",
      companionPath,
      documents: [],
      writtenDocuments: [],
      changed: { written: [], removed: [] },
      warnings: [],
      runtimes: new Set<"claude" | "opencode">(["claude"]),
      wrapState: passWrapState,
      claudePluginFolders: await publish(),
    }));
  });

  afterEach(async () => {
    await fs.chmod(path.join(folder, ".claude-plugin"), 0o755);
    await fs.rm(root, { recursive: true, force: true });
  });

  const naming = (warnings: string[]) => warnings.filter((warning) => warning.includes(folder));

  test("a managed launch in a Working Repository names it once, and passes it", async () => {
    const result = await prepareSession({
      runtime: "claude",
      companionPath,
      repository,
      mode: "attended",
      config,
    });

    expect(naming(result.warnings)).toEqual([
      expect.stringContaining("acme-cap: Claude plugin folder"),
    ]);
    expect(result.claudePluginDirectories).toEqual([folder]);
  });

  test("a companion-scoped launch names it once", async () => {
    const result = await prepareSession({
      runtime: "claude",
      companionPath,
      mode: "attended",
      config,
    });

    expect(naming(result.warnings)).toHaveLength(1);
  });

  test.each(["local", "sync"] as const)(
    "a plain session's %s prepare names it not at all",
    async (mode) => {
      sessionPrepareDeps.syncCompanionUnattended = unattended({ changed: true });

      const result = await prepareSession({
        runtime: "claude",
        runtimes: ["claude"],
        companionPath,
        repository,
        mode,
      });

      expect(sessionPrepareDeps.syncCompanionFiles).toHaveBeenCalled();
      expect(sessionPrepareDeps.runWrapPass).toHaveBeenCalled();
      expect(naming(result.warnings)).toEqual([]);
    },
  );

  test("an OpenCode launch names it not at all", async () => {
    const result = await prepareSession({
      runtime: "opencode",
      companionPath,
      repository,
      mode: "attended",
      config,
    });

    expect(naming(result.warnings)).toEqual([]);
  });
});

describe("preflight session kind", () => {
  test.each([
    ["attended", "with a repository", "managed-repo"],
    ["attended", "without a repository", "managed-companion"],
    ["local", "with a repository", "unmanaged"],
  ] as const)("a %s prepare %s preflights a %s session", async (mode, scope, kind) => {
    await prepareSession({
      runtime: "claude",
      companionPath,
      ...(scope === "with a repository" ? { repository } : {}),
      mode,
      config,
    });

    expect(sessionPrepareDeps.runCapabilityPreflight).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "claude", sessionKind: kind }),
    );
  });

  test("a sync prepare preflights an unmanaged session", async () => {
    sessionPrepareDeps.syncCompanionUnattended = unattended({ changed: true });

    await prepareSession({ runtime: "opencode", companionPath, repository, mode: "sync" });

    expect(sessionPrepareDeps.runCapabilityPreflight).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "opencode", sessionKind: "unmanaged" }),
    );
  });
});
