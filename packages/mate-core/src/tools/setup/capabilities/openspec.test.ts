import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { parse as parseYaml } from "yaml";

import type { SetupContext } from "../plugin";

import {
  createOpenspecPlugin,
  deriveOpenSpecTools,
  MATE_ARTIFACT_SKILLS,
  MATE_SKILLS,
  MATE_SPECS_RULE,
  MATE_SPECS_RULE_MARKER,
  OPENSPEC_ENV,
  OPENSPEC_SKILLS,
  readCompanionGeneratedOpenSpecVersion,
} from "./openspec";

interface MinimalSchema {
  name: string;
  version: number;
  artifacts: { id: string; template: string; requires: string[] }[];
  apply: { requires: string[]; tracks: string; instruction: string };
}

const tempRoots: string[] = [];

function setUpdatePolicy(value: string | undefined): () => void {
  const previous = process.env.MATE_UPDATE_POLICY;
  if (value === undefined) delete process.env.MATE_UPDATE_POLICY;
  else process.env.MATE_UPDATE_POLICY = value;
  return () => {
    if (previous === undefined) delete process.env.MATE_UPDATE_POLICY;
    else process.env.MATE_UPDATE_POLICY = previous;
  };
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function makeCtx(
  companionPath: string,
  activeProviders: string[],
  capabilities = [{ name: "openspec" }],
  mode: SetupContext["mode"] = "setup",
  git?: "auto",
): SetupContext {
  return {
    companionPath,
    activeProviders,
    mode,
    config: {
      allowedAgents: activeProviders,
      capabilities,
      git,
    },
  };
}

const openspecAvailable = {
  isCommandOnPath: (command: string) => command === "openspec",
  getInstalledVersion: async () => undefined,
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("deriveOpenSpecTools", () => {
  test("keeps only supported providers in stable runtime order", () => {
    expect(deriveOpenSpecTools(["tokensave", "claude", "custom", "opencode"])).toEqual([
      "claude",
      "agents",
      "opencode",
    ]);
  });

  test("maps opencode to the shared agents tool plus opencode commands", () => {
    expect(deriveOpenSpecTools(["opencode"])).toEqual(["agents", "opencode"]);
    expect(deriveOpenSpecTools(["claude"])).toEqual(["claude"]);
  });
});

describe("createOpenspecPlugin", () => {
  test("ignores the machine-local store metadata in the companion, even once disabled", () => {
    const plugin = createOpenspecPlugin();
    expect(plugin.gitignoreEntries?.(makeCtx("/tmp/companion", ["claude"]))).toEqual([
      ".openspec-store/",
    ]);
    expect(plugin.persistGitignoreEntries).toBe(true);
  });

  test("runs openspec init and update for active supported providers", async () => {
    const runCommand = mock(async () => {});
    const installCommand = mock(async () => {});
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand,
      isCommandOnPath: (command) => command === "openspec",
      getInstalledVersion: async () => undefined,
    });
    const ctx = makeCtx("/tmp/companion", ["claude", "opencode"]);
    await plugin.apply(ctx);

    expect(installCommand).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenNthCalledWith(1, "openspec", ["config", "reset", "--all", "-y"], {
      cwd: "/tmp/companion",
      env: OPENSPEC_ENV,
    });
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      "openspec",
      ["init", "--tools", "claude,agents,opencode", "--force", "/tmp/companion"],
      { cwd: "/tmp/companion", env: OPENSPEC_ENV },
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      3,
      "openspec",
      ["update", "--force", "/tmp/companion"],
      { cwd: "/tmp/companion", env: OPENSPEC_ENV },
    );
  });

  test("setup installs missing openspec with npm before reconciliation", async () => {
    const runCommand = mock(async () => {});
    const installCommand = mock(async () => {});
    const confirm = mock(async () => true);
    let openspecAvailable = false;
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand: async (...args) => {
        await installCommand(...args);
        openspecAvailable = true;
      },
      confirm,
      isCommandOnPath: (command) =>
        command === "npm" || (command === "openspec" && openspecAvailable),
    });

    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await plugin.apply(makeCtx("/tmp/companion", ["claude"]));
      expect(stdoutSpy).toHaveBeenCalledWith(
        expect.stringContaining("npm install -g @fission-ai/openspec@latest"),
      );
    } finally {
      stdoutSpy.mockRestore();
    }

    expect(confirm).toHaveBeenCalledWith("Run this install command now?");
    expect(installCommand).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "@fission-ai/openspec@latest"],
      { cwd: "/tmp/companion" },
    );
    expect(runCommand).toHaveBeenCalledWith(
      "openspec",
      ["init", "--tools", "claude", "--force", "/tmp/companion"],
      { cwd: "/tmp/companion", env: OPENSPEC_ENV },
    );
  });

  test("a pinned deployment neither checks a registry nor upgrades the tool", async () => {
    /** Pinned image tools must not trigger a registry lookup or replacement. */
    const restorePolicy = setUpdatePolicy("pinned");
    const runCommand = mock(async () => {});
    const installCommand = mock(async () => {});
    const fetchLatestVersion = mock(async () => "1.6.0");
    const getInstalledVersion = mock(async () => "1.2.0");
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand,
      confirm: mock(async () => true),
      isCommandOnPath: (command) => command === "openspec",
      getInstalledVersion,
      fetchLatestVersion,
    });

    try {
      await plugin.apply(makeCtx("/tmp/companion", ["claude"]));

      expect(fetchLatestVersion).not.toHaveBeenCalled();
      expect(installCommand).not.toHaveBeenCalled();
      /** The capability still reconciles; only the upgrade is declined. */
      expect(runCommand).toHaveBeenCalledWith(
        "openspec",
        ["init", "--tools", "claude", "--force", "/tmp/companion"],
        { cwd: "/tmp/companion", env: OPENSPEC_ENV },
      );
    } finally {
      restorePolicy();
    }
  });

  test("an unpinned deployment still checks and upgrades", async () => {
    const restorePolicy = setUpdatePolicy(undefined);
    const fetchLatestVersion = mock(async () => "1.6.0");
    const installCommand = mock(async () => {});
    const plugin = createOpenspecPlugin({
      runCommand: mock(async () => {}),
      installCommand,
      confirm: mock(async () => true),
      isCommandOnPath: (command) => command === "openspec",
      getInstalledVersion: async () => "1.2.0",
      fetchLatestVersion,
    });

    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await plugin.apply(makeCtx("/tmp/companion", ["claude"]));
    } finally {
      stdoutSpy.mockRestore();
      restorePolicy();
    }

    expect(fetchLatestVersion).toHaveBeenCalled();
    expect(installCommand).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "@fission-ai/openspec@latest"],
      { cwd: "/tmp/companion" },
    );
  });

  test("setup automatically upgrades when the installed openspec is outdated", async () => {
    const runCommand = mock(async () => {});
    const installCommand = mock(async () => {});
    const confirm = mock(async () => true);
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand,
      confirm,
      isCommandOnPath: (command) => command === "openspec",
      getInstalledVersion: async () => "1.2.0",
      fetchLatestVersion: async () => "1.6.0",
    });

    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await plugin.apply(makeCtx("/tmp/companion", ["claude"]));
      expect(stdoutSpy).toHaveBeenCalledWith(
        expect.stringContaining("installed version 1.2.0 is outdated (latest 1.6.0)"),
      );
    } finally {
      stdoutSpy.mockRestore();
    }

    expect(confirm).not.toHaveBeenCalled();
    expect(installCommand).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "@fission-ai/openspec@latest"],
      { cwd: "/tmp/companion" },
    );
    expect(runCommand).toHaveBeenCalledWith(
      "openspec",
      ["init", "--tools", "claude", "--force", "/tmp/companion"],
      { cwd: "/tmp/companion", env: OPENSPEC_ENV },
    );
  });

  test("setup continues with the installed version when the automatic upgrade fails", async () => {
    const runCommand = mock(async () => {});
    const confirm = mock(async () => false);
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand: mock(async () => {
        throw new Error("install failed");
      }),
      confirm,
      isCommandOnPath: (command) => command === "openspec",
      getInstalledVersion: async () => "1.2.0",
      fetchLatestVersion: async () => "1.6.0",
    });

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await plugin.apply(makeCtx("/tmp/companion", ["claude"]));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("upgrade failed"));
    } finally {
      stderrSpy.mockRestore();
    }

    expect(confirm).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledWith(
      "openspec",
      ["init", "--tools", "claude", "--force", "/tmp/companion"],
      { cwd: "/tmp/companion", env: OPENSPEC_ENV },
    );
  });

  test("sync with a regeneration request upgrades openspec before reconciliation", async () => {
    const events: string[] = [];
    const runCommand = mock(async (_command: string, args: string[]) => {
      events.push(args[0]);
    });
    const installCommand = mock(async () => {
      events.push("npm install");
    });
    const confirm = mock(async () => true);
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand,
      confirm,
      isCommandOnPath: (command) => command === "openspec",
      getInstalledVersion: async () => "1.2.0",
      fetchLatestVersion: async () => "1.6.0",
    });

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await plugin.apply({
        ...makeCtx("/tmp/companion", ["claude"], [{ name: "openspec" }], "sync"),
        regenerateOpenSpec: true,
      });
    } finally {
      stderrSpy.mockRestore();
    }

    expect(confirm).not.toHaveBeenCalled();
    expect(installCommand).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "@fission-ai/openspec@latest"],
      { cwd: "/tmp/companion" },
    );
    expect(events).toEqual(["npm install", "config", "init", "update"]);
  });

  test("does not prompt when the installed openspec version is current", async () => {
    const runCommand = mock(async () => {});
    const installCommand = mock(async () => {});
    const confirm = mock(async () => true);
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand,
      confirm,
      isCommandOnPath: (command) => command === "openspec",
      getInstalledVersion: async () => "1.6.0",
      fetchLatestVersion: async () => "1.6.0",
    });

    await plugin.apply(makeCtx("/tmp/companion", ["claude"]));

    expect(confirm).not.toHaveBeenCalled();
    expect(installCommand).not.toHaveBeenCalled();
  });

  test("does not prompt when the version lookup fails", async () => {
    const runCommand = mock(async () => {});
    const installCommand = mock(async () => {});
    const confirm = mock(async () => true);
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand,
      confirm,
      isCommandOnPath: (command) => command === "openspec",
      getInstalledVersion: async () => "1.2.0",
      fetchLatestVersion: async () => undefined,
    });

    await plugin.apply(makeCtx("/tmp/companion", ["claude"]));

    expect(confirm).not.toHaveBeenCalled();
    expect(installCommand).not.toHaveBeenCalled();
  });

  test("setup reports manual install and skips reconciliation when npm is unavailable", async () => {
    const runCommand = mock(async () => {});
    const installCommand = mock(async () => {});
    const confirm = mock(async () => true);
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand,
      confirm,
      isCommandOnPath: () => false,
    });

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await plugin.apply(makeCtx("/tmp/companion", ["claude"]));
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("npm install -g @fission-ai/openspec@latest"),
      );
    } finally {
      stderrSpy.mockRestore();
    }

    expect(confirm).not.toHaveBeenCalled();
    expect(installCommand).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  test("setup skips reconciliation when openspec install fails", async () => {
    const runCommand = mock(async () => {});
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand: mock(async () => {
        throw new Error("install failed");
      }),
      confirm: mock(async () => true),
      isCommandOnPath: (command) => command === "npm",
    });

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await plugin.apply(makeCtx("/tmp/companion", ["claude"]));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("openspec: install failed"));
    } finally {
      stderrSpy.mockRestore();
    }

    expect(runCommand).not.toHaveBeenCalled();
  });

  test("setup reports mismatch when install completes but openspec stays unavailable", async () => {
    const runCommand = mock(async () => {});
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand: mock(async () => {}),
      confirm: mock(async () => true),
      isCommandOnPath: (command) => command === "npm",
    });

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await plugin.apply(makeCtx("/tmp/companion", ["claude"]));
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("openspec install completed but the binary is still not available"),
      );
    } finally {
      stderrSpy.mockRestore();
    }

    expect(runCommand).not.toHaveBeenCalled();
  });

  test("sync reports manual install without prompting or running openspec reconciliation", async () => {
    const runCommand = mock(async () => {});
    const installCommand = mock(async () => {});
    const confirm = mock(async () => true);
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand,
      confirm,
      isCommandOnPath: () => false,
    });

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await plugin.apply(makeCtx("/tmp/companion", ["claude"], [{ name: "openspec" }], "sync"));
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("npm install -g @fission-ai/openspec@latest"),
      );
    } finally {
      stderrSpy.mockRestore();
    }

    expect(confirm).not.toHaveBeenCalled();
    expect(installCommand).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  test("installs mate-authored openspec skills when Git auto mode is enabled", async () => {
    const root = await makeTempDir("mate-openspec-mate-skills-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });

    for (const runtimeDir of [".claude", ".opencode"]) {
      for (const name of ["mate-artifact-finish", "mate-openspec-artifact-finish"]) {
        const retired = path.join(root, runtimeDir, "skills", name);
        await fs.mkdir(retired, { recursive: true });
        await fs.writeFile(path.join(retired, "SKILL.md"), "retired\n", "utf8");
      }
    }

    await plugin.apply(
      makeCtx(root, ["claude", "opencode"], [{ name: "openspec" }], "setup", "auto"),
    );

    await expect(fs.access(path.join(root, ".opencode", "skills"))).rejects.toThrow();
    for (const runtimeDir of [".claude", ".agents"]) {
      const markers: Record<(typeof MATE_SKILLS)[number], string> = {
        "mate-artifact-publish": "artifact pending --json",
        "mate-create-report": "open Studio → Reports",
        "mate-openspec-backfill": "Drifted specs",
        "mate-interview-me": "one-question-at-a-time",
        "mate-grill-me": "mate-grilling",
        "mate-grilling": "design tree",
        "mate-grill-with-docs": "mate-domain-modeling",
        "mate-domain-modeling": "CONTEXT-MAP.md",
        "mate-show-me": "Browser Report Required",
        "mate-simplify-code": "Preserve Behavior Exactly",
      };
      for (const skill of MATE_SKILLS) {
        await expect(
          fs.readFile(path.join(root, runtimeDir, "skills", skill, "SKILL.md"), "utf8"),
        ).resolves.toContain(markers[skill]);
      }
      for (const retired of ["mate-artifact-finish", "mate-openspec-artifact-finish"]) {
        await expect(fs.access(path.join(root, runtimeDir, "skills", retired))).rejects.toThrow();
      }
    }

    // The deployed create-report skill documents the optional presentation fields.
    for (const runtimeDir of [".claude", ".agents"]) {
      const reportSkill = await fs.readFile(
        path.join(root, runtimeDir, "skills", "mate-create-report", "SKILL.md"),
        "utf8",
      );
      for (const marker of [
        "## Presentation Fields",
        '"tone": "warn"',
        '"format": "markdown"',
        '"caption":',
        "Raw HTML is shown as text",
        "icon-only print control",
        "from a CDN",
        "`class` or `:::`",
        "`added`, `changed`, and `removed`",
      ]) {
        expect(reportSkill).toContain(marker);
      }
    }

    // Every runtime confirms the commit + tag + push before the first finish
    // call and keeps the deterministic CLI as the publication primitive.
    for (const runtimeDir of [".claude", ".agents"]) {
      const publishSkill = await fs.readFile(
        path.join(root, runtimeDir, "skills", "mate-artifact-publish", "SKILL.md"),
        "utf8",
      );
      expect(publishSkill).toContain("commit, tag, and push");
      expect(publishSkill).toContain("Present both sections as Markdown tables");
      expect(publishSkill).toContain('artifact publish "<anchor-or-name>" --json');
      expect(publishSkill).toContain("artifact publish --specs");
      expect(publishSkill).toContain("artifact publish --all --json");
      await expect(
        fs.readFile(
          path.join(
            root,
            runtimeDir,
            "skills",
            "mate-artifact-publish",
            "references",
            "openspec.md",
          ),
          "utf8",
        ),
      ).resolves.toContain("Sequencing A Multi-Part Selection");
    }
  });

  test("removes opencode-tool skill duplicates after update and keeps opsx commands", async () => {
    const root = await makeTempDir("mate-openspec-opencode-duplicates-");
    /** Simulates the openspec CLI: `update` re-creates the opencode tool's skills. */
    const runCommand = mock(async (_command: string, args: string[]) => {
      if (args[0] !== "update") return;
      for (const skill of OPENSPEC_SKILLS) {
        const dir = path.join(root, ".opencode", "skills", skill);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "SKILL.md"), "opencode\n", "utf8");
      }
      await fs.mkdir(path.join(root, ".opencode", "commands"), { recursive: true });
      await fs.writeFile(path.join(root, ".opencode", "commands", "opsx-propose.md"), "x\n");
    });
    const graphify = path.join(root, ".opencode", "skills", "graphify", "SKILL.md");
    await fs.mkdir(path.dirname(graphify), { recursive: true });
    await fs.writeFile(graphify, "graphify\n", "utf8");
    const plugin = createOpenspecPlugin({ runCommand, ...openspecAvailable });

    await plugin.apply(makeCtx(root, ["opencode"]));

    for (const skill of [...OPENSPEC_SKILLS, ...MATE_SKILLS]) {
      await expect(fs.access(path.join(root, ".opencode", "skills", skill))).rejects.toThrow();
    }
    await expect(fs.readFile(graphify, "utf8")).resolves.toBe("graphify\n");
    await expect(
      fs.access(path.join(root, ".opencode", "commands", "opsx-propose.md")),
    ).resolves.toBeNull();
    await expect(
      fs.access(path.join(root, ".agents", "skills", "mate-grill-me", "SKILL.md")),
    ).resolves.toBeNull();
    await expect(fs.access(path.join(root, ".claude", "skills"))).rejects.toThrow();
  });

  test("removes legacy managed opencode skills even when opencode is inactive", async () => {
    const root = await makeTempDir("mate-openspec-legacy-inactive-");
    const legacy = path.join(root, ".opencode", "skills", "mate-grill-me");
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, "SKILL.md"), "legacy\n", "utf8");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });

    await plugin.apply(makeCtx(root, ["claude"]));

    await expect(fs.access(path.join(root, ".opencode"))).rejects.toThrow();
    await expect(fs.access(path.join(root, ".agents"))).rejects.toThrow();
  });

  test("shared root receives the agents skill variant", async () => {
    const root = await makeTempDir("mate-openspec-agents-variant-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });

    await plugin.apply(makeCtx(root, ["claude", "opencode"]));

    const templates = path.join(import.meta.dirname, "../../../templates/mate-skills");
    for (const [runtimeDir, bucket] of [
      [".agents", "agents"],
      [".claude", "claude"],
    ] as const) {
      await expect(
        fs.readFile(path.join(root, runtimeDir, "skills", "mate-show-me", "SKILL.md"), "utf8"),
      ).resolves.toBe(
        await fs.readFile(path.join(templates, bucket, "mate-show-me", "SKILL.md"), "utf8"),
      );
    }
  });

  test("reconciliation preserves existing archives and their finish markers", async () => {
    const root = await makeTempDir("mate-openspec-migration-");
    const anchor = "2026-09-07-acme";
    const archiveDir = path.join(root, "openspec", "changes", "archive", anchor);
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(path.join(archiveDir, "proposal.md"), "archived acme\n", "utf8");
    const git = (...args: string[]) => spawnSync("git", args, { cwd: root, stdio: "ignore" });
    git("init");
    git("config", "user.email", "acme@example.test");
    git("config", "user.name", "acme");
    git("add", "-A");
    git("commit", "-m", "seed archive");
    git("tag", "-a", `openspec/${anchor}`, "-m", `Publish ${anchor}`);
    /** A previously deployed runtime still carrying the retired skill. */
    const retired = path.join(root, ".claude", "skills", "mate-artifact-finish");
    await fs.mkdir(retired, { recursive: true });
    await fs.writeFile(path.join(retired, "SKILL.md"), "retired\n", "utf8");

    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });
    await plugin.apply(
      makeCtx(root, ["claude", "opencode"], [{ name: "openspec" }], "reconcile", "auto"),
    );
    await plugin.forProvider!.claude.apply(
      makeCtx(root, ["claude"], [{ name: "openspec" }], "reconcile", "auto"),
    );

    await expect(fs.readFile(path.join(archiveDir, "proposal.md"), "utf8")).resolves.toBe(
      "archived acme\n",
    );
    const tags = spawnSync("git", ["tag", "--list"], { cwd: root, encoding: "utf8" });
    expect(tags.stdout.trim()).toBe(`openspec/${anchor}`);
    await expect(fs.access(retired)).rejects.toThrow();
    await expect(
      fs.access(path.join(root, ".claude", "skills", "mate-artifact-publish", "SKILL.md")),
    ).resolves.toBeNull();
  });

  test("does not install a Claude archive-finish hook file", async () => {
    const root = await makeTempDir("mate-openspec-claude-hook-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });

    await plugin.forProvider!.claude.apply(
      makeCtx(root, ["claude"], [{ name: "openspec" }], "setup", "auto"),
    );

    await expect(
      fs.access(path.join(root, ".claude", "hooks", "mate-artifact-finish.sh")),
    ).rejects.toThrow();
  });

  test("creates no Claude archive-finish state and preserves unrelated state", async () => {
    const root = await makeTempDir("mate-openspec-claude-state-");
    const stateDir = path.join(root, ".claude", "state");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, "other.json"), "{}\n");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });

    await plugin.forProvider!.claude.apply(
      makeCtx(root, ["claude"], [{ name: "openspec" }], "setup", "auto"),
    );

    expect(await fs.readdir(stateDir)).toEqual(["other.json"]);
  });

  test("Claude runtime contributions include mate skill permissions", () => {
    const plugin = createOpenspecPlugin({ wrapperBinPath: () => "/bin" });
    const entries = plugin.getRuntimeContributions?.().claude?.permissionEntries ?? [];
    expect(entries).toContain("Skill(mate-artifact-publish)");
    expect(entries).not.toContain("Skill(mate-artifact-finish)");
    expect(entries).toContain("Skill(mate-openspec-backfill)");
    for (const skill of [
      "mate-interview-me",
      "mate-grill-me",
      "mate-grilling",
      "mate-grill-with-docs",
      "mate-domain-modeling",
      "mate-show-me",
      "mate-simplify-code",
    ]) {
      expect(entries).toContain(`Skill(${skill})`);
    }
  });

  test("does not install mate-authored skills for unsupported providers", async () => {
    const root = await makeTempDir("mate-openspec-mate-skills-inactive-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });

    await plugin.apply(makeCtx(root, ["custom"]));

    await expect(fs.access(path.join(root, ".claude", "skills"))).rejects.toThrow();
    await expect(fs.access(path.join(root, ".agents", "skills"))).rejects.toThrow();
    await expect(fs.access(path.join(root, ".opencode", "skills"))).rejects.toThrow();
  });

  test("capability teardown removes mate-authored openspec skills too", async () => {
    const root = await makeTempDir("mate-openspec-mate-skills-teardown-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}) });

    for (const runtimeDir of [".claude", ".agents", ".opencode"]) {
      for (const skill of [
        ...MATE_SKILLS,
        ...MATE_ARTIFACT_SKILLS,
        "mate-artifact-finish",
        "mate-openspec-artifact-finish",
      ]) {
        await fs.mkdir(path.join(root, runtimeDir, "skills", skill), { recursive: true });
        await fs.writeFile(
          path.join(root, runtimeDir, "skills", skill, "SKILL.md"),
          `${runtimeDir}\n`,
          "utf8",
        );
      }
    }

    await plugin.teardown(makeCtx(root, []));

    await expect(fs.access(path.join(root, ".claude", "skills"))).rejects.toThrow();
    await expect(fs.access(path.join(root, ".agents", "skills"))).rejects.toThrow();
    await expect(fs.access(path.join(root, ".opencode", "skills"))).rejects.toThrow();
  });

  test("skips openspec CLI calls when no supported providers are active", async () => {
    const runCommand = mock(async () => {});
    const plugin = createOpenspecPlugin({ runCommand, ...openspecAvailable });

    await plugin.apply(makeCtx("/tmp/companion", []));

    expect(runCommand).not.toHaveBeenCalled();
  });

  test("re-syncs bundled Mate skills idempotently without duplicating files", async () => {
    const root = await makeTempDir("mate-openspec-mate-skills-resync-");
    const runCommand = mock(async () => {});
    const plugin = createOpenspecPlugin({ runCommand, ...openspecAvailable });
    const ctx = makeCtx(root, ["claude"], [{ name: "openspec" }], "sync");

    await plugin.apply(ctx);
    await plugin.apply(ctx);

    const skillPath = path.join(root, ".claude", "skills", "mate-grill-me", "SKILL.md");
    await expect(fs.readFile(skillPath, "utf8")).resolves.toContain("/mate-grilling");
    await expect(fs.readdir(path.dirname(skillPath))).resolves.toEqual(["SKILL.md"]);
  });

  test("preserves unmanaged skill trees during setup and teardown", async () => {
    const root = await makeTempDir("mate-openspec-mate-skills-unmanaged-");
    const unmanaged = path.join(root, ".claude", "skills", "custom-skill", "SKILL.md");
    await fs.mkdir(path.dirname(unmanaged), { recursive: true });
    await fs.writeFile(unmanaged, "keep me\n", "utf8");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });

    await plugin.apply(makeCtx(root, ["claude"]));
    await plugin.teardown(makeCtx(root, []));

    await expect(fs.readFile(unmanaged, "utf8")).resolves.toBe("keep me\n");
    await expect(
      fs.access(path.join(root, ".claude", "skills", "mate-grill-me")),
    ).rejects.toThrow();
  });

  test("setup installs openspec even when no supported providers are active", async () => {
    const runCommand = mock(async () => {});
    const installCommand = mock(async () => {});
    const confirm = mock(async () => true);
    let openspecAvailable = false;
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand: async (...args) => {
        await installCommand(...args);
        openspecAvailable = true;
      },
      confirm,
      isCommandOnPath: (command) =>
        command === "npm" || (command === "openspec" && openspecAvailable),
    });

    const root = await makeTempDir("mate-openspec-install-without-provider-");
    await plugin.apply(makeCtx(root, ["custom"]));

    expect(confirm).toHaveBeenCalledWith("Run this install command now?");
    expect(installCommand).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "@fission-ai/openspec@latest"],
      { cwd: root },
    );
    expect(runCommand).not.toHaveBeenCalled();
  });

  test("seeds mate-v1 schema files and config when the schema profile is selected", async () => {
    const root = await makeTempDir("mate-openspec-schema-seed-");
    const runCommand = mock(async () => {});
    const plugin = createOpenspecPlugin({ runCommand, ...openspecAvailable });

    await plugin.apply(makeCtx(root, ["claude"], [{ name: "openspec", schemaProfile: "mate-v1" }]));

    expect(
      parseYaml(await fs.readFile(path.join(root, "openspec", "config.yaml"), "utf8")),
    ).toEqual({ schema: "mate-v1", rules: { specs: [MATE_SPECS_RULE] } });
    await expect(
      fs.access(path.join(root, "openspec", "schemas", "mate-v1", "schema.yaml")),
    ).resolves.toBeNull();

    const schema = await fs.readFile(
      path.join(root, "openspec", "schemas", "mate-v1", "schema.yaml"),
      "utf8",
    );
    expect(schema).toContain("version: 10");
    expect(schema).toContain("openspec/mate-conventions.yaml");
    expect(schema).toContain("id: proposal");
    await expect(
      fs.access(path.join(root, "openspec", "schemas", "mate-v1", "templates", "proposal.md")),
    ).resolves.toBeNull();
    expect(schema).not.toContain("id: explore");
    expect(schema).not.toContain("explore-brief.md");
    await expect(
      fs.access(path.join(root, "openspec", "schemas", "mate-v1", "templates", "explore-brief.md")),
    ).rejects.toThrow();
    await expect(
      fs.readFile(path.join(root, "openspec", "mate-conventions.yaml"), "utf8"),
    ).resolves.toContain("name: mate-openspec-conventions");
  });

  test("seeds mate-minimal without activating a companion default", async () => {
    const root = await makeTempDir("mate-openspec-minimal-schema-seed-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });

    await plugin.apply(makeCtx(root, ["claude"], [{ name: "openspec" }]));

    const schemaDir = path.join(root, "openspec", "schemas", "mate-minimal");
    const schema = parseYaml(
      await fs.readFile(path.join(schemaDir, "schema.yaml"), "utf8"),
    ) as MinimalSchema;

    expect(schema.name).toBe("mate-minimal");
    expect(schema.version).toBeGreaterThan(0);
    expect(schema.artifacts.map((artifact) => artifact.id)).toEqual(["specs", "tasks"]);
    expect(schema.artifacts[0].requires).toEqual([]);
    expect(schema.artifacts[1].requires).toEqual(["specs"]);
    expect(schema.apply).toEqual({
      requires: ["tasks"],
      tracks: "tasks.md",
      instruction: expect.any(String),
    });
    await expect(fs.readFile(path.join(root, "openspec", "config.yaml"), "utf8")).rejects.toThrow();
  });

  test("mate-minimal templates carry parser-compatible user-story rules", async () => {
    const root = await makeTempDir("mate-openspec-minimal-schema-templates-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });

    await plugin.apply(makeCtx(root, ["claude"], [{ name: "openspec" }]));

    const schemaDir = path.join(root, "openspec", "schemas", "mate-minimal");
    const schema = parseYaml(
      await fs.readFile(path.join(schemaDir, "schema.yaml"), "utf8"),
    ) as MinimalSchema;
    const spec = await fs.readFile(
      path.join(schemaDir, "templates", schema.artifacts[0].template),
      "utf8",
    );
    const tasks = await fs.readFile(
      path.join(schemaDir, "templates", schema.artifacts[1].template),
      "utf8",
    );

    expect(spec).toContain("## ADDED Requirements");
    expect(spec).toContain("### Requirement:");
    expect(spec).not.toContain("## ADDED User Stories");
    expect(spec).toContain("As a <!-- role -->, I want");
    expect(spec).toContain("The system MUST support");
    expect(spec).toContain("#### Acceptance Criteria");
    for (const marker of ["- **Given**", "- **When**", "- **Then**"]) {
      expect(spec).toContain(marker);
    }
    expect(tasks).toContain("schema: mate-minimal");
    expect(tasks).toContain("scopes:");
    expect(schema.artifacts.some((artifact) => ["proposal", "design"].includes(artifact.id))).toBe(
      false,
    );
  });

  test("deselection leaves a config.yaml Mate did not write", async () => {
    const root = await makeTempDir("mate-openspec-schema-user-config-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });
    await fs.mkdir(path.join(root, "openspec"), { recursive: true });
    const userConfig = "schema: spec-driven\n";
    await fs.writeFile(path.join(root, "openspec", "config.yaml"), userConfig, "utf8");

    await plugin.apply(makeCtx(root, ["claude"], [{ name: "openspec" }]));

    await expect(fs.readFile(path.join(root, "openspec", "config.yaml"), "utf8")).resolves.toBe(
      userConfig,
    );
    await expect(
      fs.access(path.join(root, "openspec", "schemas", "mate-minimal", "schema.yaml")),
    ).resolves.toBeNull();
  });

  test("the Mate specs rule binds only main specs and names the flat header", () => {
    expect(MATE_SPECS_RULE.startsWith(MATE_SPECS_RULE_MARKER)).toBe(true);
    for (const field of [
      "type: spec",
      "capability",
      "repository",
      "areas",
      "tags: [openspec/spec]",
    ]) {
      expect(MATE_SPECS_RULE).toContain(field);
    }
    expect(MATE_SPECS_RULE).toContain("openspec/specs/");
    expect(MATE_SPECS_RULE).toContain("Delta specs");
    expect(MATE_SPECS_RULE).toContain("keep their `mate:delta` comment");
    expect(MATE_SPECS_RULE).not.toContain("delta frontmatter");
    expect(MATE_SPECS_RULE).toContain("openspec/mate-conventions.yaml");
  });

  test("rerun leaves a current config byte-for-byte unchanged", async () => {
    const root = await makeTempDir("mate-openspec-schema-rerun-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });
    const ctx = makeCtx(root, ["claude"], [{ name: "openspec", schemaProfile: "mate-v1" }]);
    const configPath = path.join(root, "openspec", "config.yaml");

    await plugin.apply(ctx);
    const first = await fs.readFile(configPath, "utf8");
    const { mtimeMs } = await fs.stat(configPath);
    await plugin.apply(ctx);

    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(first);
    expect((await fs.stat(configPath)).mtimeMs).toBe(mtimeMs);
  });

  test("merges the Mate entry into a user-edited config without touching user content", async () => {
    const root = await makeTempDir("mate-openspec-schema-merge-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });
    await fs.mkdir(path.join(root, "openspec"), { recursive: true });
    const userConfig = [
      "# acme planning config",
      "schema: mate-v1",
      "context: |",
      "  Acme ships widgets.",
      "rules:",
      "  proposal:",
      '    - "Name the customer."',
      "  specs:",
      '    - "Keep scenarios short."',
      "",
    ].join("\n");
    const configPath = path.join(root, "openspec", "config.yaml");
    await fs.writeFile(configPath, userConfig, "utf8");

    await plugin.apply(makeCtx(root, ["claude"], [{ name: "openspec", schemaProfile: "mate-v1" }]));

    const merged = await fs.readFile(configPath, "utf8");
    expect(merged).toContain("# acme planning config");
    expect(parseYaml(merged)).toEqual({
      schema: "mate-v1",
      context: "Acme ships widgets.\n",
      rules: {
        proposal: ["Name the customer."],
        specs: ["Keep scenarios short.", MATE_SPECS_RULE],
      },
    });
  });

  test("adds rules.specs to a config that has other rules only", async () => {
    const root = await makeTempDir("mate-openspec-schema-add-specs-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });
    await fs.mkdir(path.join(root, "openspec"), { recursive: true });
    const configPath = path.join(root, "openspec", "config.yaml");
    await fs.writeFile(configPath, 'schema: mate-v1\nrules:\n  tasks:\n    - "custom task rule"\n');

    await plugin.apply(makeCtx(root, ["claude"], [{ name: "openspec", schemaProfile: "mate-v1" }]));

    expect(parseYaml(await fs.readFile(configPath, "utf8"))).toEqual({
      schema: "mate-v1",
      rules: { tasks: ["custom task rule"], specs: [MATE_SPECS_RULE] },
    });
  });

  test("replaces an outdated Mate entry in place without duplicating it", async () => {
    const root = await makeTempDir("mate-openspec-schema-outdated-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });
    await fs.mkdir(path.join(root, "openspec"), { recursive: true });
    const configPath = path.join(root, "openspec", "config.yaml");
    await fs.writeFile(
      configPath,
      [
        "schema: mate-v1",
        "rules:",
        "  specs:",
        '    - "first"',
        `    - "${MATE_SPECS_RULE_MARKER}an older Mate rule"`,
        '    - "last"',
        "",
      ].join("\n"),
    );

    await plugin.apply(makeCtx(root, ["claude"], [{ name: "openspec", schemaProfile: "mate-v1" }]));

    expect(parseYaml(await fs.readFile(configPath, "utf8"))).toEqual({
      schema: "mate-v1",
      rules: { specs: ["first", MATE_SPECS_RULE, "last"] },
    });
  });

  test("leaves an unparseable config alone with one stderr line", async () => {
    const root = await makeTempDir("mate-openspec-schema-broken-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });
    await fs.mkdir(path.join(root, "openspec"), { recursive: true });
    const configPath = path.join(root, "openspec", "config.yaml");
    const broken = "schema: mate-v1\nrules: [\n";
    await fs.writeFile(configPath, broken);
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await plugin.apply(
        makeCtx(root, ["claude"], [{ name: "openspec", schemaProfile: "mate-v1" }]),
      );
      const lines = stderr.mock.calls.map(([chunk]) => String(chunk));
      expect(lines.filter((line) => line.includes("openspec/config.yaml"))).toHaveLength(1);
    } finally {
      stderr.mockRestore();
    }
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(broken);
  });

  test("deselection removes a config holding only Mate content", async () => {
    const root = await makeTempDir("mate-openspec-schema-deselect-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });

    await plugin.apply(makeCtx(root, ["claude"], [{ name: "openspec", schemaProfile: "mate-v1" }]));
    await plugin.apply(makeCtx(root, ["claude"], [{ name: "openspec" }]));

    await expect(fs.access(path.join(root, "openspec", "config.yaml"))).rejects.toThrow();
    await expect(fs.access(path.join(root, "openspec", "schemas", "mate-v1"))).resolves.toBeNull();
  });

  test("deselection removes only the Mate entry from a user-edited config", async () => {
    const root = await makeTempDir("mate-openspec-schema-deselect-user-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });
    await fs.mkdir(path.join(root, "openspec"), { recursive: true });
    const configPath = path.join(root, "openspec", "config.yaml");
    await fs.writeFile(
      configPath,
      `schema: mate-v1\ncontext: Acme\nrules:\n  proposal:\n    - "Name the customer."\n  specs:\n    - "${MATE_SPECS_RULE_MARKER}old"\n`,
    );

    await plugin.apply(makeCtx(root, ["claude"], [{ name: "openspec" }]));

    expect(parseYaml(await fs.readFile(configPath, "utf8"))).toEqual({
      schema: "mate-v1",
      context: "Acme",
      rules: { proposal: ["Name the customer."] },
    });
  });

  test("deselection keeps user rules.specs entries next to the removed Mate entry", async () => {
    const root = await makeTempDir("mate-openspec-schema-deselect-specs-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });
    await fs.mkdir(path.join(root, "openspec"), { recursive: true });
    const configPath = path.join(root, "openspec", "config.yaml");
    await fs.writeFile(
      configPath,
      `schema: mate-v1\nrules:\n  specs:\n    - "Keep scenarios short."\n    - "${MATE_SPECS_RULE_MARKER}old"\n`,
    );

    await plugin.apply(makeCtx(root, ["claude"], [{ name: "openspec" }]));

    expect(parseYaml(await fs.readFile(configPath, "utf8"))).toEqual({
      schema: "mate-v1",
      rules: { specs: ["Keep scenarios short."] },
    });
  });

  test("default schema profile keeps schemas available without activating a default", async () => {
    const root = await makeTempDir("mate-openspec-schema-default-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });
    await fs.mkdir(path.join(root, "openspec", "schemas", "mate-v1"), { recursive: true });
    await fs.writeFile(
      path.join(root, "openspec", "schemas", "mate-v1", "schema.yaml"),
      "name: mate-v1\n",
      "utf8",
    );
    await fs.mkdir(path.join(root, "openspec"), { recursive: true });
    await fs.writeFile(path.join(root, "openspec", "config.yaml"), "schema: mate-v1\n", "utf8");

    await plugin.apply(makeCtx(root, ["claude"]));

    await expect(fs.access(path.join(root, "openspec", "config.yaml"))).rejects.toThrow();
    await expect(fs.access(path.join(root, "openspec", "schemas", "mate-v1"))).resolves.toBeNull();
    await expect(
      fs.access(path.join(root, "openspec", "schemas", "mate-minimal")),
    ).resolves.toBeNull();
  });

  test("provider teardown removes only that runtime's openspec skills", async () => {
    const root = await makeTempDir("mate-openspec-provider-teardown-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });

    for (const skill of OPENSPEC_SKILLS) {
      await fs.mkdir(path.join(root, ".claude", "skills", skill), { recursive: true });
      await fs.writeFile(
        path.join(root, ".claude", "skills", skill, "SKILL.md"),
        "claude\n",
        "utf8",
      );
      await fs.mkdir(path.join(root, ".agents", "skills", skill), { recursive: true });
      await fs.writeFile(
        path.join(root, ".agents", "skills", skill, "SKILL.md"),
        "agents\n",
        "utf8",
      );
    }
    for (const skill of MATE_SKILLS) {
      await fs.mkdir(path.join(root, ".claude", "skills", skill), { recursive: true });
      await fs.mkdir(path.join(root, ".agents", "skills", skill), { recursive: true });
    }

    await plugin.forProvider!.claude.teardown(makeCtx(root, ["opencode"]));

    await expect(fs.access(path.join(root, ".claude", "skills"))).rejects.toThrow();
    await expect(
      fs.access(path.join(root, ".agents", "skills", "openspec-explore", "SKILL.md")),
    ).resolves.toBeNull();
  });

  test("opencode teardown clears the shared root when no reading runtime remains", async () => {
    const root = await makeTempDir("mate-openspec-shared-teardown-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });
    const sharedDir = path.join(root, ".agents", "skills");

    for (const skill of [...OPENSPEC_SKILLS, ...MATE_SKILLS, "acme-notes"]) {
      await fs.mkdir(path.join(sharedDir, skill), { recursive: true });
      await fs.mkdir(path.join(root, ".claude", "skills", skill), { recursive: true });
    }
    await fs.writeFile(path.join(sharedDir, ".openspec-target"), "agents\n", "utf8");

    await plugin.forProvider!.opencode.teardown(makeCtx(root, ["claude"]));

    expect(await fs.readdir(sharedDir)).toEqual(["acme-notes"]);
    await expect(
      fs.access(path.join(root, ".claude", "skills", "openspec-explore")),
    ).resolves.toBeNull();
  });

  test("capability teardown removes all managed openspec skill runtimes", async () => {
    const root = await makeTempDir("mate-openspec-full-teardown-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}) });

    for (const runtimeDir of [".claude", ".agents", ".opencode"]) {
      for (const skill of OPENSPEC_SKILLS) {
        await fs.mkdir(path.join(root, runtimeDir, "skills", skill), { recursive: true });
        await fs.writeFile(
          path.join(root, runtimeDir, "skills", skill, "SKILL.md"),
          `${runtimeDir}\n`,
          "utf8",
        );
      }
    }
    await fs.writeFile(path.join(root, ".agents", "skills", ".openspec-target"), "agents\n");
    const thirdParty = path.join(root, ".agents", "skills", "acme-skill", "SKILL.md");
    await fs.mkdir(path.dirname(thirdParty), { recursive: true });
    await fs.writeFile(thirdParty, "acme\n", "utf8");

    await plugin.teardown(makeCtx(root, []));

    await expect(fs.access(path.join(root, ".claude", "skills"))).rejects.toThrow();
    await expect(fs.access(path.join(root, ".opencode", "skills"))).rejects.toThrow();
    expect(await fs.readdir(path.join(root, ".agents", "skills"))).toEqual(["acme-skill"]);
    await expect(fs.readFile(thirdParty, "utf8")).resolves.toBe("acme\n");
  });

  test("capability teardown removes managed mate-v1 schema state", async () => {
    const root = await makeTempDir("mate-openspec-schema-teardown-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}) });
    await fs.mkdir(path.join(root, "openspec", "schemas", "mate-v1"), { recursive: true });
    await fs.writeFile(
      path.join(root, "openspec", "schemas", "mate-v1", "schema.yaml"),
      "name: mate-v1\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "openspec", "config.yaml"),
      `schema: mate-v1\nrules:\n  specs:\n    - "${MATE_SPECS_RULE_MARKER}old"\n`,
      "utf8",
    );

    await plugin.teardown(makeCtx(root, []));

    await expect(fs.access(path.join(root, "openspec", "config.yaml"))).rejects.toThrow();
    await expect(fs.access(path.join(root, "openspec", "schemas", "mate-v1"))).rejects.toThrow();
    await expect(
      fs.access(path.join(root, "openspec", "schemas", "mate-minimal")),
    ).rejects.toThrow();
    await expect(fs.access(path.join(root, "openspec", "mate-conventions.yaml"))).rejects.toThrow();
  });
});

describe("OpenSpec environment", () => {
  test("setup reconcile runs every openspec command with telemetry and update checks off", async () => {
    const before = {
      telemetry: process.env.OPENSPEC_TELEMETRY,
      updateCheck: process.env.OPENSPEC_NO_UPDATE_CHECK,
    };
    const runCommand = mock(async () => {});
    const plugin = createOpenspecPlugin({ runCommand, ...openspecAvailable });

    await plugin.apply(makeCtx("/tmp/companion", ["claude"]));

    expect(OPENSPEC_ENV).toEqual({
      OPENSPEC_TELEMETRY: "0",
      OPENSPEC_NO_UPDATE_CHECK: "1",
    });
    const subcommands = runCommand.mock.calls.map((call) => (call as unknown[])[1] as string[]);
    expect(subcommands.map((args) => args[0])).toEqual(["config", "init", "update"]);
    for (const call of runCommand.mock.calls) {
      expect((call as unknown[])[2]).toEqual({
        cwd: "/tmp/companion",
        env: OPENSPEC_ENV,
      });
    }
    expect(process.env.OPENSPEC_TELEMETRY).toBe(before.telemetry);
    expect(process.env.OPENSPEC_NO_UPDATE_CHECK).toBe(before.updateCheck);
  });

  test("version detection runs openspec --version with both variables set", async () => {
    const before = process.env.OPENSPEC_TELEMETRY;
    const bin = await makeTempDir("mate-openspec-version-env-");
    const record = path.join(bin, "env.txt");
    await fs.writeFile(
      path.join(bin, "openspec"),
      `#!/bin/sh\nprintf '%s %s' "$OPENSPEC_TELEMETRY" "$OPENSPEC_NO_UPDATE_CHECK" > "${record}"\necho 1.6.0\n`,
      { mode: 0o755 },
    );
    const plugin = createOpenspecPlugin({
      runCommand: mock(async () => {}),
      installCommand: mock(async () => {}),
      isCommandOnPath: (command) => command === "openspec",
      pathValue: () => bin,
      fetchLatestVersion: async () => "1.6.0",
      isPinnedDeployment: () => false,
    });

    await plugin.apply(makeCtx("/tmp/companion", ["claude"]));

    await expect(fs.readFile(record, "utf8")).resolves.toBe("0 1");
    expect(process.env.OPENSPEC_TELEMETRY).toBe(before);
  });
});

/** Writes an OpenSpec-generated skill whose frontmatter records `generatedBy`. */
async function writeGeneratedSkill(
  root: string,
  runtimeDir: ".claude" | ".agents",
  skill: string,
  frontmatter: string,
): Promise<void> {
  const dir = path.join(root, runtimeDir, "skills", skill);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\n${frontmatter}---\n\nBody\n`, "utf8");
}

const generatedBy = (version: string) =>
  `name: acme\nmetadata:\n  author: openspec\n  generatedBy: "${version}"\n`;

describe("launch-time sync", () => {
  test("invokes no OpenSpec reconcile and no @latest upgrade, and still deploys Mate skills", async () => {
    const root = await makeTempDir("mate-openspec-launch-");
    await writeGeneratedSkill(root, ".claude", "openspec-explore", generatedBy("1.14.2"));
    const before = await fs.readFile(
      path.join(root, ".claude", "skills", "openspec-explore", "SKILL.md"),
      "utf8",
    );
    const runCommand = mock(async () => {});
    const installCommand = mock(async () => {});
    const fetchLatestVersion = mock(async () => "1.15.0");
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand,
      isCommandOnPath: (command) => command === "openspec",
      getInstalledVersion: async () => "1.14.2",
      fetchLatestVersion,
      isPinnedDeployment: () => false,
    });

    await plugin.apply(makeCtx(root, ["claude"], [{ name: "openspec" }], "sync"));

    expect(runCommand).not.toHaveBeenCalled();
    expect(installCommand).not.toHaveBeenCalled();
    expect(fetchLatestVersion).not.toHaveBeenCalled();
    await expect(
      fs.readFile(path.join(root, ".claude", "skills", "openspec-explore", "SKILL.md"), "utf8"),
    ).resolves.toBe(before);
    await expect(
      fs.access(path.join(root, ".claude", "skills", "mate-grill-me", "SKILL.md")),
    ).resolves.toBeNull();
    await expect(
      fs.access(path.join(root, "openspec", "schemas", "mate-v1", "schema.yaml")),
    ).resolves.toBeNull();
  });

  test("warns about a missing openspec without prompting and still deploys Mate skills", async () => {
    const root = await makeTempDir("mate-openspec-launch-missing-");
    const confirm = mock(async () => true);
    const installCommand = mock(async () => {});
    const plugin = createOpenspecPlugin({
      runCommand: mock(async () => {}),
      installCommand,
      confirm,
      isCommandOnPath: () => false,
    });

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await plugin.apply(makeCtx(root, ["claude"], [{ name: "openspec" }], "sync"));
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("npm install -g @fission-ai/openspec@latest"),
      );
    } finally {
      stderrSpy.mockRestore();
    }

    expect(confirm).not.toHaveBeenCalled();
    expect(installCommand).not.toHaveBeenCalled();
    await expect(
      fs.access(path.join(root, ".claude", "skills", "mate-grill-me", "SKILL.md")),
    ).resolves.toBeNull();
  });
});

describe("readCompanionGeneratedOpenSpecVersion", () => {
  test("returns undefined when no generated skill exists", async () => {
    const root = await makeTempDir("mate-openspec-generated-missing-");
    await expect(readCompanionGeneratedOpenSpecVersion(root)).resolves.toBeUndefined();
  });

  test("ignores malformed frontmatter and invalid versions", async () => {
    const root = await makeTempDir("mate-openspec-generated-malformed-");
    await writeGeneratedSkill(root, ".claude", "openspec-explore", "metadata: [unclosed\n");
    await writeGeneratedSkill(root, ".claude", "openspec-propose", generatedBy("latest"));
    const noFrontmatter = path.join(root, ".claude", "skills", "openspec-sync-specs", "SKILL.md");
    await fs.mkdir(path.dirname(noFrontmatter), { recursive: true });
    await fs.writeFile(noFrontmatter, "No frontmatter\n", "utf8");

    await expect(readCompanionGeneratedOpenSpecVersion(root)).resolves.toBeUndefined();
  });

  test("returns the highest valid version across mixed skills, ignoring non-OpenSpec skills", async () => {
    const root = await makeTempDir("mate-openspec-generated-mixed-");
    await writeGeneratedSkill(root, ".claude", "openspec-explore", generatedBy("1.14.2"));
    await writeGeneratedSkill(root, ".claude", "openspec-propose", generatedBy("not-a-version"));
    await writeGeneratedSkill(root, ".claude", "openspec-apply-change", generatedBy("1.9.0"));
    await writeGeneratedSkill(root, ".claude", "mate-grill-me", generatedBy("9.9.9"));

    await expect(readCompanionGeneratedOpenSpecVersion(root)).resolves.toBe("1.14.2");
  });

  test("reads both the Claude and the shared skill roots", async () => {
    const root = await makeTempDir("mate-openspec-generated-roots-");
    await writeGeneratedSkill(root, ".claude", "openspec-explore", generatedBy("1.14.2"));
    await writeGeneratedSkill(root, ".agents", "openspec-explore", generatedBy("1.15.0"));

    await expect(readCompanionGeneratedOpenSpecVersion(root)).resolves.toBe("1.15.0");
  });
});

describe("launch-time catch-up to the companion's generated version", () => {
  async function launch(options: {
    generated?: string;
    installed?: string;
    pinned?: boolean;
    installFails?: boolean;
  }) {
    const root = await makeTempDir("mate-openspec-catch-up-");
    if (options.generated) {
      await writeGeneratedSkill(
        root,
        ".claude",
        "openspec-explore",
        generatedBy(options.generated),
      );
    }
    const runCommand = mock(async () => {});
    const installCommand = mock(async () => {
      if (options.installFails) throw new Error("npm exited with code 1");
    });
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand,
      isCommandOnPath: (command) => command === "openspec",
      getInstalledVersion: async () => options.installed,
      fetchLatestVersion: async () => "2.0.0",
      isPinnedDeployment: () => options.pinned ?? false,
    });
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    let stderr = "";
    try {
      await plugin.apply(makeCtx(root, ["claude"], [{ name: "openspec" }], "sync"));
      stderr = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
    return { root, runCommand, installCommand, stderr };
  }

  test("a developer behind the companion installs exactly the generated version", async () => {
    const { root, runCommand, installCommand } = await launch({
      generated: "1.15.0",
      installed: "1.14.2",
    });

    expect(installCommand).toHaveBeenCalledTimes(1);
    expect(installCommand).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "@fission-ai/openspec@1.15.0"],
      { cwd: root },
    );
    expect(runCommand).not.toHaveBeenCalled();
  });

  test("a developer ahead of the companion is left alone", async () => {
    const { installCommand, runCommand } = await launch({
      generated: "1.14.2",
      installed: "1.15.0",
    });

    expect(installCommand).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  test("a failed catch-up warns with the manual command and the launch continues", async () => {
    const { root, stderr } = await launch({
      generated: "1.15.0",
      installed: "1.14.2",
      installFails: true,
    });

    expect(stderr).toContain("npm exited with code 1");
    expect(stderr).toContain("npm install -g @fission-ai/openspec@1.15.0");
    await expect(
      fs.access(path.join(root, ".claude", "skills", "mate-grill-me", "SKILL.md")),
    ).resolves.toBeNull();
  });

  test("no recorded version runs no install", async () => {
    const { installCommand } = await launch({ installed: "1.14.2" });
    expect(installCommand).not.toHaveBeenCalled();
  });

  test("an unknown installed version runs no install", async () => {
    const { installCommand } = await launch({ generated: "1.15.0" });
    expect(installCommand).not.toHaveBeenCalled();
  });

  test("a pinned deployment runs no install", async () => {
    const { installCommand } = await launch({
      generated: "1.15.0",
      installed: "1.14.2",
      pinned: true,
    });
    expect(installCommand).not.toHaveBeenCalled();
  });
});
