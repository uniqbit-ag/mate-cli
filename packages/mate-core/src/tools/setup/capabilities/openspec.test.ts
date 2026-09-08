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
  OPENSPEC_SKILLS,
} from "./openspec";

interface MinimalSchema {
  name: string;
  version: number;
  artifacts: { id: string; template: string; requires: string[] }[];
  apply: { requires: string[]; tracks: string; instruction: string };
}

const tempRoots: string[] = [];

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
      "opencode",
    ]);
  });
});

describe("createOpenspecPlugin", () => {
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
    });
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      "openspec",
      ["init", "--tools", "claude,opencode", "--force", "/tmp/companion"],
      { cwd: "/tmp/companion" },
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      3,
      "openspec",
      ["update", "--force", "/tmp/companion"],
      { cwd: "/tmp/companion" },
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
      { cwd: "/tmp/companion" },
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
      { cwd: "/tmp/companion" },
    );
  });

  test("sync automatically upgrades openspec before reconciliation", async () => {
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
      await plugin.apply(makeCtx("/tmp/companion", ["claude"], [{ name: "openspec" }], "sync"));
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

    for (const runtimeDir of [".claude", ".opencode"]) {
      const markers: Record<(typeof MATE_SKILLS)[number], string> = {
        "mate-artifact-publish": "artifact pending --json",
        "mate-create-report": "report --input",
        "mate-openspec-backfill": "backfill-spec-",
        "mate-interview-me": "one-question-at-a-time",
        "mate-grill-me": "mate-grilling",
        "mate-grilling": "design tree",
        "mate-grill-with-docs": "mate-domain-modeling",
        "mate-domain-modeling": "CONTEXT-MAP.md",
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

    // Every runtime confirms the commit + tag + push before the first finish
    // call and keeps the deterministic CLI as the publication primitive.
    for (const runtimeDir of [".claude", ".opencode"]) {
      const publishSkill = await fs.readFile(
        path.join(root, runtimeDir, "skills", "mate-artifact-publish", "SKILL.md"),
        "utf8",
      );
      expect(publishSkill).toContain("commit, tag, and push");
      expect(publishSkill).toContain("numbered list");
      expect(publishSkill).toContain('artifact finish "<change-name>" --json');
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
      ).resolves.toContain("Sequencing A Multi-Change Selection");
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
    git("tag", "-a", `openspec/${anchor}`, "-m", `Finish ${anchor}`);
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
    await expect(fs.access(path.join(root, ".opencode", "skills"))).rejects.toThrow();
  });

  test("capability teardown removes mate-authored openspec skills too", async () => {
    const root = await makeTempDir("mate-openspec-mate-skills-teardown-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}) });

    for (const runtimeDir of [".claude", ".opencode"]) {
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

    await expect(fs.readFile(path.join(root, "openspec", "config.yaml"), "utf8")).resolves.toBe(
      "schema: mate-v1\n",
    );
    await expect(
      fs.access(path.join(root, "openspec", "schemas", "mate-v1", "schema.yaml")),
    ).resolves.toBeNull();

    const schema = await fs.readFile(
      path.join(root, "openspec", "schemas", "mate-v1", "schema.yaml"),
      "utf8",
    );
    expect(schema).toContain("version: 8");
    expect(schema).toContain("openspec/mate-conventions.yaml");
    expect(schema).toContain("id: proposal");
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

  test("never rewrites an existing config.yaml, even with user-added keys", async () => {
    const root = await makeTempDir("mate-openspec-schema-preserve-");
    const runCommand = mock(async () => {});
    const plugin = createOpenspecPlugin({ runCommand, ...openspecAvailable });
    await fs.mkdir(path.join(root, "openspec"), { recursive: true });
    const userConfig = 'schema: mate-v1\nrules:\n  tasks:\n    - "custom task rule"\n';
    await fs.writeFile(path.join(root, "openspec", "config.yaml"), userConfig, "utf8");

    await plugin.apply(makeCtx(root, ["claude"], [{ name: "openspec", schemaProfile: "mate-v1" }]));

    await expect(fs.readFile(path.join(root, "openspec", "config.yaml"), "utf8")).resolves.toBe(
      userConfig,
    );
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
      await fs.mkdir(path.join(root, ".opencode", "skills", skill), { recursive: true });
      await fs.writeFile(
        path.join(root, ".opencode", "skills", skill, "SKILL.md"),
        "opencode\n",
        "utf8",
      );
    }
    for (const skill of MATE_SKILLS) {
      await fs.mkdir(path.join(root, ".claude", "skills", skill), { recursive: true });
      await fs.mkdir(path.join(root, ".opencode", "skills", skill), { recursive: true });
    }

    await plugin.forProvider!.claude.teardown(makeCtx(root, ["opencode"]));

    await expect(fs.access(path.join(root, ".claude", "skills"))).rejects.toThrow();
    await expect(
      fs.access(path.join(root, ".opencode", "skills", "openspec-explore", "SKILL.md")),
    ).resolves.toBeNull();
  });

  test("capability teardown removes all managed openspec skill runtimes", async () => {
    const root = await makeTempDir("mate-openspec-full-teardown-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}) });

    for (const runtimeDir of [".claude", ".opencode"]) {
      for (const skill of OPENSPEC_SKILLS) {
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
    await expect(fs.access(path.join(root, ".opencode", "skills"))).rejects.toThrow();
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
    await fs.writeFile(path.join(root, "openspec", "config.yaml"), "schema: mate-v1\n", "utf8");

    await plugin.teardown(makeCtx(root, []));

    await expect(fs.access(path.join(root, "openspec", "config.yaml"))).rejects.toThrow();
    await expect(fs.access(path.join(root, "openspec", "schemas", "mate-v1"))).rejects.toThrow();
    await expect(
      fs.access(path.join(root, "openspec", "schemas", "mate-minimal")),
    ).rejects.toThrow();
    await expect(fs.access(path.join(root, "openspec", "mate-conventions.yaml"))).rejects.toThrow();
  });
});
