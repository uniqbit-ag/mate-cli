import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { UnattendedSyncOutcome } from "../../runtime/companion-sync";
import { EMPTY_MANIFEST } from "../../runtime/runtime-document-manifest";
import { wrapStateOf } from "../../runtime/wrap-state";
import { prepareSession, sessionPrepareDeps } from "./session-prepare";
import { LaunchPreflightError, type FrameworkConfig } from "./types";

const original = { ...sessionPrepareDeps };
const calls: string[] = [];
const lockOptions: Array<{ wait?: boolean; timeoutMs?: number }> = [];
const repository = { id: "acme", path: "/work/acme" };
const companionPath = "/companions/acme";
const passWrapState = wrapStateOf(EMPTY_MANIFEST);
const config = { allowedAgents: ["opencode", "claude"], capabilities: [], git: "auto" } as never;

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
  sessionPrepareDeps.audienceSelection = () => null;
  sessionPrepareDeps.wrappedAudience = () => null;
  sessionPrepareDeps.ensureAudienceLayer = mock(async (request: { audience: string }) => {
    calls.push(`layer:${request.audience}`);
    return { audience: request.audience, root: `/layers/${request.audience}`, rendered: true };
  });
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

describe("audience layer", () => {
  const withAudiences = { audiences: { ba: { plugins: [] }, qa: { plugins: [] } } } as never;

  test("an attended prepare with an active audience renders its layer after the base prepare", async () => {
    stub(withAudiences);
    sessionPrepareDeps.audienceSelection = () => "ba";

    const result = await prepareSession({
      runtime: "claude",
      companionPath,
      repository,
      mode: "attended",
    });

    expect(calls).toEqual([
      "config",
      "git",
      "files",
      "launch",
      "projection-root",
      "wrap",
      "preflight",
      "layer:ba",
    ]);
    expect(result.ok).toBe(true);
    expect(result.audienceLayer).toEqual({ audience: "ba", root: "/layers/ba", rendered: true });
    expect(result.steps.at(-1)).toEqual({
      step: "audience-layer",
      outcome: "ok",
      detail: "ba: rendered",
    });
  });

  test("an attended prepare without an audience renders no layer", async () => {
    stub(withAudiences);

    const result = await prepareSession({ runtime: "opencode", companionPath, mode: "attended" });

    expect(calls.some((call) => call.startsWith("layer:"))).toBe(false);
    expect(result.audienceLayer).toBeUndefined();
    expect(result.steps.some((step) => step.step === "audience-layer")).toBe(false);
  });

  test("an audience the companion does not declare renders no layer", async () => {
    stub(withAudiences);
    sessionPrepareDeps.audienceSelection = () => "ops";

    const result = await prepareSession({ runtime: "claude", companionPath, mode: "attended" });

    expect(calls.some((call) => call.startsWith("layer:"))).toBe(false);
    expect(result.audienceLayer).toBeUndefined();
  });

  test("a bare session's prepare never renders a layer, whatever MATE_AUDIENCE says", async () => {
    stub(withAudiences);
    sessionPrepareDeps.audienceSelection = () => "ba";

    const result = await prepareSession({
      runtime: "claude",
      runtimes: ["claude", "opencode"],
      companionPath,
      repository,
      mode: "local",
    });

    expect(calls.some((call) => call.startsWith("layer:"))).toBe(false);
    expect(result.audienceLayer).toBeUndefined();
  });

  test("a failed layer render fails the attended prepare", async () => {
    stub(withAudiences);
    sessionPrepareDeps.audienceSelection = () => "ba";
    sessionPrepareDeps.ensureAudienceLayer = mock(async () => {
      throw new Error("disk full");
    });

    const result = await prepareSession({ runtime: "claude", companionPath, mode: "attended" });

    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({ step: "audience-layer", outcome: "failed" });
  });
});

describe("a managed launch in a checkout wrapped for an audience", () => {
  const withAudiences = { audiences: { ba: { plugins: [] }, qa: { plugins: [] } } } as never;

  test("adopts the wrapped audience when MATE_AUDIENCE is unset: no launch layer", async () => {
    stub(withAudiences);
    sessionPrepareDeps.wrappedAudience = () => "ba";

    const result = await prepareSession({
      runtime: "claude",
      companionPath,
      repository,
      mode: "attended",
    });

    expect(result.ok).toBe(true);
    expect(calls.some((call) => call.startsWith("layer:"))).toBe(false);
    expect(result.audienceLayer).toBeUndefined();
    expect(result.steps.at(-1)).toEqual({
      step: "audience-layer",
      outcome: "ok",
      detail: "ba: from the wrap",
    });
  });

  test("the same audience is adopted the same way", async () => {
    stub(withAudiences);
    sessionPrepareDeps.wrappedAudience = () => "ba";
    sessionPrepareDeps.audienceSelection = () => "ba";

    const result = await prepareSession({
      runtime: "claude",
      companionPath,
      repository,
      mode: "attended",
    });

    expect(result.ok).toBe(true);
    expect(calls.some((call) => call.startsWith("layer:"))).toBe(false);
  });

  test("a different audience is refused before anything runs", async () => {
    stub(withAudiences);
    sessionPrepareDeps.wrappedAudience = () => "ba";
    sessionPrepareDeps.audienceSelection = () => "qa";

    const result = await prepareSession({
      runtime: "claude",
      companionPath,
      repository,
      mode: "attended",
    });

    expect(result.ok).toBe(false);
    expect(calls).toEqual(["config"]);
    const message = (result.failure as Error).message;
    for (const part of ['"ba"', '"qa"', "mate wrap --audience qa", "worktree"]) {
      expect(message).toContain(part);
    }
  });
});
