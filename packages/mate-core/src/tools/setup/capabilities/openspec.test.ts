import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { parse as parseYaml } from "yaml";

import { locateOpenSpec, OPENSPEC_ENV, type OpenSpecRun } from "../../../lib/openspec-cli";
import type { ManagedOutputEntry, SetupContext } from "../plugin";

import {
  createOpenspecPlugin,
  MATE_SKILLS,
  MATE_SPECS_RULE,
  MATE_SPECS_RULE_MARKER,
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

const OPENSPEC_OK: OpenSpecRun = { code: 0, stdout: "", stderr: "" };
const OPENSPEC_MISSING = {
  missing: "bundled OpenSpec CLI is missing. Reinstall Mate to restore it.",
};

/** Stands in for the bundled CLI. */
const openspecAvailable = { runOpenSpec: async () => OPENSPEC_OK };

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("createOpenspecPlugin", () => {
  test("ignores the machine-local store metadata in the companion, even once disabled", () => {
    const plugin = createOpenspecPlugin();
    expect(plugin.gitignoreEntries?.(makeCtx("/tmp/companion", ["claude"]))).toEqual([
      ".openspec-store/",
    ]);
    expect(plugin.persistGitignoreEntries).toBe(true);
  });

  test("initializes OpenSpec without tool output and runs no update", async () => {
    const runOpenSpec = mock(async () => OPENSPEC_OK);
    const plugin = createOpenspecPlugin({ runOpenSpec });
    const root = await makeTempDir("mate-openspec-init-none-");
    await plugin.apply(makeCtx(root, ["claude", "opencode"]));

    expect(runOpenSpec.mock.calls as unknown[]).toEqual([
      [["init", "--tools", "none", "--force", root], { cwd: root }],
    ]);
    for (const runtimeDir of [".claude", ".agents"]) {
      await expect(
        fs.access(
          path.join(
            root,
            runtimeDir,
            "skills",
            "mate-explore-change",
            "references",
            "openspec-explore.md",
          ),
        ),
      ).resolves.toBeNull();
      for (const skill of OPENSPEC_SKILLS) {
        await expect(fs.access(path.join(root, runtimeDir, "skills", skill))).rejects.toThrow();
      }
    }
  });

  test("removes earlier OpenSpec output by name and keeps user entries", async () => {
    const root = await makeTempDir("mate-openspec-remove-generated-");
    const write = async (relative: string) => {
      await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await fs.writeFile(path.join(root, relative), "x\n");
    };
    for (const runtimeDir of [".claude", ".agents", ".opencode"]) {
      for (const skill of OPENSPEC_SKILLS) await write(`${runtimeDir}/skills/${skill}/SKILL.md`);
    }
    const kept = [
      ".claude/skills/openspec-acme/SKILL.md",
      ".agents/skills/acme/SKILL.md",
      ".claude/commands/acme/run.md",
      ".opencode/commands/acme.md",
      ".claude/commands/opsx/acme.md",
      ".opencode/commands/opsx-acme.md",
    ];
    for (const file of [
      ...kept,
      ".agents/skills/.openspec-target",
      ".claude/commands/opsx/propose.md",
      ".opencode/commands/opsx-propose.md",
    ]) {
      await write(file);
    }
    const plugin = createOpenspecPlugin(openspecAvailable);

    await plugin.apply(makeCtx(root, ["claude"]));

    for (const runtimeDir of [".claude", ".agents", ".opencode"]) {
      for (const skill of OPENSPEC_SKILLS) {
        await expect(fs.access(path.join(root, runtimeDir, "skills", skill))).rejects.toThrow();
      }
    }
    for (const removed of [
      ".agents/skills/.openspec-target",
      ".claude/commands/opsx/propose.md",
      ".opencode/commands/opsx-propose.md",
    ]) {
      await expect(fs.access(path.join(root, removed))).rejects.toThrow();
    }
    for (const file of kept) {
      await expect(fs.readFile(path.join(root, file), "utf8")).resolves.toBe("x\n");
    }
  });

  test("removes any openspec-* skill OpenSpec authored, beyond the known names", async () => {
    const root = await makeTempDir("mate-openspec-remove-authored-");
    const generated = path.join(root, ".agents", "skills", "openspec-onboard");
    const userOwned = path.join(root, ".agents", "skills", "openspec-acme");
    await fs.mkdir(generated, { recursive: true });
    await fs.mkdir(userOwned, { recursive: true });
    await fs.writeFile(
      path.join(generated, "SKILL.md"),
      "---\nname: openspec-onboard\nmetadata:\n  author: openspec\n---\n",
    );
    await fs.writeFile(path.join(userOwned, "SKILL.md"), "---\nname: openspec-acme\n---\n");
    const plugin = createOpenspecPlugin(openspecAvailable);

    await plugin.apply(makeCtx(root, ["claude"]));

    await expect(fs.access(generated)).rejects.toThrow();
    await expect(fs.access(path.join(userOwned, "SKILL.md"))).resolves.toBeNull();
  });

  test("reports what it removed or deployed, and nothing it left or never found", async () => {
    const root = await makeTempDir("mate-openspec-report-");
    const skill = async (relative: string, source: string) => {
      await fs.mkdir(path.join(root, relative), { recursive: true });
      await fs.writeFile(path.join(root, relative, "SKILL.md"), source);
    };
    await skill(".agents/skills/openspec-onboard", "---\nmetadata:\n  author: openspec\n---\n");
    await skill(".claude/skills/openspec-acme", "---\nname: openspec-acme\n---\n");
    await skill(".claude/skills/mate-artifact-publish", "---\nmetadata:\n  author: mate\n---\n");
    await skill(".claude/skills/mate-openspec-backfill", "---\nmetadata:\n  author: me\n---\n");
    const entries: ManagedOutputEntry[] = [];
    const ctx = {
      ...makeCtx(root, ["claude"]),
      managedOutput: { record: (entry: ManagedOutputEntry) => entries.push(entry) },
    };

    await createOpenspecPlugin(openspecAvailable).apply(ctx);

    const relative = (change: string, owner: string) =>
      entries
        .filter((entry) => entry.change === change && entry.owner === owner)
        .map((entry) => path.relative(root, entry.path).split(path.sep).join("/"));
    expect(relative("removed", "openspec")).toEqual([".agents/skills/openspec-onboard"]);
    expect(relative("removed", "mate")).toEqual([".claude/skills/mate-artifact-publish"]);
    expect(relative("written", "mate")).toEqual(
      MATE_SKILLS.map((name) => `.claude/skills/${name}`),
    );
    await expect(
      fs.access(path.join(root, ".claude/skills/mate-openspec-backfill/SKILL.md")),
    ).resolves.toBeNull();
    await expect(
      fs.access(path.join(root, ".claude/skills/openspec-acme/SKILL.md")),
    ).resolves.toBeNull();
  });

  test("setup fails naming a reinstall when the bundled CLI is missing", async () => {
    const plugin = createOpenspecPlugin({
      runOpenSpec: async () => ({ code: 1, stdout: "", stderr: OPENSPEC_MISSING.missing }),
    });
    const root = await makeTempDir("mate-openspec-missing-bundled-");

    await expect(plugin.apply(makeCtx(root, ["claude"]))).rejects.toThrow(/Reinstall Mate/);
    await expect(fs.access(path.join(root, "openspec", "config.yaml"))).rejects.toThrow();
  });

  test("installs mate-authored openspec skills when Git auto mode is enabled", async () => {
    const root = await makeTempDir("mate-openspec-mate-skills-");
    const plugin = createOpenspecPlugin(openspecAvailable);

    for (const runtimeDir of [".claude", ".opencode"]) {
      for (const name of ["mate-artifact-finish", "mate-openspec-artifact-finish"]) {
        const retired = path.join(root, runtimeDir, "skills", name);
        await fs.mkdir(retired, { recursive: true });
        await fs.writeFile(path.join(retired, "SKILL.md"), "retired\n", "utf8");
      }
    }
    // Renamed without aliases: Mate's own copy goes, a user-authored namesake stays.
    const mateWritten = "---\nname: mate-artifact-publish\nmetadata:\n  author: mate\n---\n";
    const userWritten = "---\nname: mate-openspec-backfill\nmetadata:\n  author: me\n---\n";
    for (const [name, source] of [
      ["mate-artifact-publish", mateWritten],
      ["mate-openspec-backfill", userWritten],
    ]) {
      await fs.mkdir(path.join(root, ".claude", "skills", name), { recursive: true });
      await fs.writeFile(path.join(root, ".claude", "skills", name, "SKILL.md"), source, "utf8");
    }

    await plugin.apply(
      makeCtx(root, ["claude", "opencode"], [{ name: "openspec" }], "setup", "auto"),
    );

    await expect(
      fs.access(path.join(root, ".claude", "skills", "mate-artifact-publish")),
    ).rejects.toThrow();
    expect(
      await fs.readFile(
        path.join(root, ".claude", "skills", "mate-openspec-backfill", "SKILL.md"),
        "utf8",
      ),
    ).toBe(userWritten);

    await expect(fs.access(path.join(root, ".opencode", "skills"))).rejects.toThrow();
    for (const runtimeDir of [".claude", ".agents"]) {
      const markers: Record<(typeof MATE_SKILLS)[number], string> = {
        "mate-publish-artifact": "artifact pending --json",
        "mate-create-report": "open Studio → Reports",
        "mate-backfill-spec": "Drifted specs",
        "mate-clarify-intent": "../mate-interview-me/SKILL.md",
        "mate-explore-change": "CONTEXT-MAP.md",
        "mate-propose-change": "mate-minimal",
        "mate-apply-change": "mate artifact link",
        "mate-archive-change": "mate artifact archive",
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
        path.join(root, runtimeDir, "skills", "mate-publish-artifact", "SKILL.md"),
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
            "mate-publish-artifact",
            "references",
            "openspec.md",
          ),
          "utf8",
        ),
      ).resolves.toContain("Sequencing A Multi-Part Selection");
    }
  });

  test("moves Mate skills out of the legacy opencode root and keeps third-party skills", async () => {
    const root = await makeTempDir("mate-openspec-opencode-legacy-");
    for (const skill of ["mate-grill-me", "graphify"]) {
      const file = path.join(root, ".opencode", "skills", skill, "SKILL.md");
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `${skill}\n`, "utf8");
    }
    const plugin = createOpenspecPlugin(openspecAvailable);

    await plugin.apply(makeCtx(root, ["opencode"]));

    await expect(
      fs.access(path.join(root, ".opencode", "skills", "mate-grill-me")),
    ).rejects.toThrow();
    await expect(
      fs.readFile(path.join(root, ".opencode", "skills", "graphify", "SKILL.md"), "utf8"),
    ).resolves.toBe("graphify\n");
    await expect(
      fs.access(path.join(root, ".agents", "skills", "mate-grill-me", "SKILL.md")),
    ).resolves.toBeNull();
    await expect(fs.access(path.join(root, ".claude", "skills"))).rejects.toThrow();
  });

  test("keeps a user-authored skill of a retired name in every shared root", async () => {
    const root = await makeTempDir("mate-openspec-retired-user-");
    const dirs = [".agents", ".opencode"].map((runtimeDir) =>
      path.join(root, runtimeDir, "skills", "mate-artifact-publish"),
    );
    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: mate-artifact-publish\n---\n");
    }
    const plugin = createOpenspecPlugin(openspecAvailable);

    await plugin.apply(makeCtx(root, ["opencode"]));
    await plugin.teardown(makeCtx(root, ["opencode"]));

    for (const dir of dirs) {
      await expect(fs.access(path.join(dir, "SKILL.md"))).resolves.toBeNull();
    }
  });

  test("removes legacy managed opencode skills even when opencode is inactive", async () => {
    const root = await makeTempDir("mate-openspec-legacy-inactive-");
    const legacy = path.join(root, ".opencode", "skills", "mate-grill-me");
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, "SKILL.md"), "legacy\n", "utf8");
    const plugin = createOpenspecPlugin(openspecAvailable);

    await plugin.apply(makeCtx(root, ["claude"]));

    await expect(fs.access(path.join(root, ".opencode"))).rejects.toThrow();
    await expect(fs.access(path.join(root, ".agents"))).rejects.toThrow();
  });

  test("shared root receives the agents skill variant", async () => {
    const root = await makeTempDir("mate-openspec-agents-variant-");
    const plugin = createOpenspecPlugin(openspecAvailable);

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

    const plugin = createOpenspecPlugin(openspecAvailable);
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
      fs.access(path.join(root, ".claude", "skills", "mate-publish-artifact", "SKILL.md")),
    ).resolves.toBeNull();
  });

  test("does not install a Claude archive-finish hook file", async () => {
    const root = await makeTempDir("mate-openspec-claude-hook-");
    const plugin = createOpenspecPlugin(openspecAvailable);

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
    const plugin = createOpenspecPlugin(openspecAvailable);

    await plugin.forProvider!.claude.apply(
      makeCtx(root, ["claude"], [{ name: "openspec" }], "setup", "auto"),
    );

    expect(await fs.readdir(stateDir)).toEqual(["other.json"]);
  });

  test("Claude runtime contributions include mate skill permissions", () => {
    const plugin = createOpenspecPlugin({ wrapperBinPath: () => "/bin" });
    const entries = plugin.getRuntimeContributions?.().claude?.permissionEntries ?? [];
    expect(entries).toContain("Skill(mate-publish-artifact)");
    expect(entries).not.toContain("Skill(mate-artifact-finish)");
    expect(entries).toContain("Skill(mate-backfill-spec)");
    expect(entries).not.toContain("Skill(mate-artifact-publish)");
    expect(entries).not.toContain("Skill(mate-openspec-backfill)");
    expect(entries).not.toContain("Skill(mate-update-change)");
    for (const skill of [
      "mate-clarify-intent",
      "mate-explore-change",
      "mate-propose-change",
      "mate-apply-change",
      "mate-archive-change",
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
    expect(entries.filter((entry) => entry.startsWith("Skill(openspec-"))).toEqual([]);
  });

  test("does not install mate-authored skills for unsupported providers", async () => {
    const root = await makeTempDir("mate-openspec-mate-skills-inactive-");
    const plugin = createOpenspecPlugin(openspecAvailable);

    await plugin.apply(makeCtx(root, ["custom"]));

    await expect(fs.access(path.join(root, ".claude", "skills"))).rejects.toThrow();
    await expect(fs.access(path.join(root, ".agents", "skills"))).rejects.toThrow();
    await expect(fs.access(path.join(root, ".opencode", "skills"))).rejects.toThrow();
  });

  test("capability teardown removes mate-authored openspec skills too", async () => {
    const root = await makeTempDir("mate-openspec-mate-skills-teardown-");
    const plugin = createOpenspecPlugin(openspecAvailable);

    for (const runtimeDir of [".claude", ".agents", ".opencode"]) {
      for (const skill of [
        ...MATE_SKILLS,
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

  test("setup initializes OpenSpec even without an active agent runtime", async () => {
    const root = await makeTempDir("mate-openspec-no-runtime-");
    const runOpenSpec = mock(async () => OPENSPEC_OK);
    const plugin = createOpenspecPlugin({ runOpenSpec });

    await plugin.apply(makeCtx(root, []));

    expect(runOpenSpec.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      ["init", "--tools", "none", "--force", root],
    ]);
    await expect(fs.access(path.join(root, ".claude", "skills"))).rejects.toThrow();
    await expect(fs.access(path.join(root, ".agents", "skills"))).rejects.toThrow();
  });

  test("re-syncs bundled Mate skills idempotently without duplicating files", async () => {
    const root = await makeTempDir("mate-openspec-mate-skills-resync-");
    const runOpenSpec = mock(async () => OPENSPEC_OK);
    const plugin = createOpenspecPlugin({ runOpenSpec });
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
    const plugin = createOpenspecPlugin(openspecAvailable);

    await plugin.apply(makeCtx(root, ["claude"]));
    await plugin.teardown(makeCtx(root, []));

    await expect(fs.readFile(unmanaged, "utf8")).resolves.toBe("keep me\n");
    await expect(
      fs.access(path.join(root, ".claude", "skills", "mate-grill-me")),
    ).rejects.toThrow();
  });

  test("seeds mate-v1 schema files and activates mate-v1 in config", async () => {
    const root = await makeTempDir("mate-openspec-schema-seed-");
    const runOpenSpec = mock(async () => OPENSPEC_OK);
    const plugin = createOpenspecPlugin({ runOpenSpec });

    await plugin.apply(makeCtx(root, ["claude"]));

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

  test("seeds mate-minimal while mate-v1 stays the companion default", async () => {
    const root = await makeTempDir("mate-openspec-minimal-schema-seed-");
    const plugin = createOpenspecPlugin(openspecAvailable);

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
    expect(
      parseYaml(await fs.readFile(path.join(root, "openspec", "config.yaml"), "utf8")),
    ).toMatchObject({ schema: "mate-v1" });
  });

  test("mate-minimal templates carry parser-compatible user-story rules", async () => {
    const root = await makeTempDir("mate-openspec-minimal-schema-templates-");
    const plugin = createOpenspecPlugin(openspecAvailable);

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

  test("activation replaces another schema in a config Mate did not write", async () => {
    const root = await makeTempDir("mate-openspec-schema-user-config-");
    const plugin = createOpenspecPlugin(openspecAvailable);
    await fs.mkdir(path.join(root, "openspec"), { recursive: true });
    const configPath = path.join(root, "openspec", "config.yaml");
    await fs.writeFile(configPath, "schema: spec-driven\n", "utf8");

    await plugin.apply(makeCtx(root, ["claude"]));

    expect(parseYaml(await fs.readFile(configPath, "utf8"))).toEqual({
      schema: "mate-v1",
      rules: { specs: [MATE_SPECS_RULE] },
    });
    await expect(
      fs.access(path.join(root, "openspec", "schemas", "mate-minimal", "schema.yaml")),
    ).resolves.toBeNull();
  });

  test("activation keeps mate-minimal chosen by hand", async () => {
    const root = await makeTempDir("mate-openspec-schema-keep-minimal-");
    const plugin = createOpenspecPlugin(openspecAvailable);
    await fs.mkdir(path.join(root, "openspec"), { recursive: true });
    const configPath = path.join(root, "openspec", "config.yaml");
    await fs.writeFile(configPath, "schema: mate-minimal\n", "utf8");

    await plugin.apply(makeCtx(root, ["claude"]));

    expect(parseYaml(await fs.readFile(configPath, "utf8"))).toEqual({
      schema: "mate-minimal",
      rules: { specs: [MATE_SPECS_RULE] },
    });
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
    const plugin = createOpenspecPlugin(openspecAvailable);
    const ctx = makeCtx(root, ["claude"]);
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
    const plugin = createOpenspecPlugin(openspecAvailable);
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

    await plugin.apply(makeCtx(root, ["claude"]));

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

  test("activates mate-v1 over the default schema a fresh `openspec init` writes", async () => {
    const root = await makeTempDir("mate-openspec-schema-after-init-");
    // The bundled CLI writes `schema: spec-driven` plus commented guidance.
    const location = locateOpenSpec();
    if ("missing" in location) throw new Error(location.missing);
    execFileSync(location.bin, ["init", "--tools", "none", "--force", root], {
      env: { ...process.env, ...OPENSPEC_ENV },
      stdio: "ignore",
    });
    const configPath = path.join(root, "openspec", "config.yaml");
    const initialized = await fs.readFile(configPath, "utf8");
    expect(parseYaml(initialized)).toMatchObject({ schema: "spec-driven" });
    const plugin = createOpenspecPlugin(openspecAvailable);

    await plugin.apply(makeCtx(root, ["claude"]));

    const activated = await fs.readFile(configPath, "utf8");
    expect(parseYaml(activated)).toEqual({
      schema: "mate-v1",
      rules: { specs: [MATE_SPECS_RULE] },
    });
    // OpenSpec's commented guidance stays.
    expect(activated).toContain("# Project context (optional)");
  });

  test("adds rules.specs to a config that has other rules only", async () => {
    const root = await makeTempDir("mate-openspec-schema-add-specs-");
    const plugin = createOpenspecPlugin(openspecAvailable);
    await fs.mkdir(path.join(root, "openspec"), { recursive: true });
    const configPath = path.join(root, "openspec", "config.yaml");
    await fs.writeFile(configPath, 'schema: mate-v1\nrules:\n  tasks:\n    - "custom task rule"\n');

    await plugin.apply(makeCtx(root, ["claude"]));

    expect(parseYaml(await fs.readFile(configPath, "utf8"))).toEqual({
      schema: "mate-v1",
      rules: { tasks: ["custom task rule"], specs: [MATE_SPECS_RULE] },
    });
  });

  test("replaces an outdated Mate entry in place without duplicating it", async () => {
    const root = await makeTempDir("mate-openspec-schema-outdated-");
    const plugin = createOpenspecPlugin(openspecAvailable);
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

    await plugin.apply(makeCtx(root, ["claude"]));

    expect(parseYaml(await fs.readFile(configPath, "utf8"))).toEqual({
      schema: "mate-v1",
      rules: { specs: ["first", MATE_SPECS_RULE, "last"] },
    });
  });

  test("leaves an unparseable config alone with one stderr line", async () => {
    const root = await makeTempDir("mate-openspec-schema-broken-");
    const plugin = createOpenspecPlugin(openspecAvailable);
    await fs.mkdir(path.join(root, "openspec"), { recursive: true });
    const configPath = path.join(root, "openspec", "config.yaml");
    const broken = "schema: mate-v1\nrules: [\n";
    await fs.writeFile(configPath, broken);
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await plugin.apply(makeCtx(root, ["claude"]));
      const lines = stderr.mock.calls.map(([chunk]) => String(chunk));
      expect(lines.filter((line) => line.includes("openspec/config.yaml"))).toHaveLength(1);
    } finally {
      stderr.mockRestore();
    }
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(broken);
  });

  test("ignores a leftover schemaProfile key in the saved capability", async () => {
    const root = await makeTempDir("mate-openspec-schema-leftover-profile-");
    const plugin = createOpenspecPlugin(openspecAvailable);
    const leftover = { name: "openspec", schemaProfile: "default" } as { name: string };

    await plugin.apply(makeCtx(root, ["claude"], [leftover]));

    expect(
      parseYaml(await fs.readFile(path.join(root, "openspec", "config.yaml"), "utf8")),
    ).toEqual({ schema: "mate-v1", rules: { specs: [MATE_SPECS_RULE] } });
  });

  test("activation keeps user keys and a user-chosen schema while replacing the Mate entry", async () => {
    const root = await makeTempDir("mate-openspec-schema-activate-user-");
    const plugin = createOpenspecPlugin(openspecAvailable);
    await fs.mkdir(path.join(root, "openspec"), { recursive: true });
    const configPath = path.join(root, "openspec", "config.yaml");
    await fs.writeFile(
      configPath,
      `schema: acme-flow\ncontext: Acme\nrules:\n  proposal:\n    - "Name the customer."\n  specs:\n    - "Keep scenarios short."\n    - "${MATE_SPECS_RULE_MARKER}old"\n`,
    );

    await plugin.apply(makeCtx(root, ["claude"]));

    expect(parseYaml(await fs.readFile(configPath, "utf8"))).toEqual({
      schema: "acme-flow",
      context: "Acme",
      rules: {
        proposal: ["Name the customer."],
        specs: ["Keep scenarios short.", MATE_SPECS_RULE],
      },
    });
  });

  test("provider teardown removes only that runtime's openspec skills", async () => {
    const root = await makeTempDir("mate-openspec-provider-teardown-");
    const plugin = createOpenspecPlugin(openspecAvailable);

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
    const plugin = createOpenspecPlugin(openspecAvailable);
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
    const plugin = createOpenspecPlugin(openspecAvailable);

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
    const plugin = createOpenspecPlugin(openspecAvailable);
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
  test("invokes no OpenSpec command and still deploys Mate skills", async () => {
    const root = await makeTempDir("mate-openspec-launch-");
    await writeGeneratedSkill(root, ".claude", "openspec-explore", generatedBy("1.14.2"));
    const before = await fs.readFile(
      path.join(root, ".claude", "skills", "openspec-explore", "SKILL.md"),
      "utf8",
    );
    const runOpenSpec = mock(async () => OPENSPEC_OK);
    const plugin = createOpenspecPlugin({ runOpenSpec });

    await plugin.apply(makeCtx(root, ["claude"], [{ name: "openspec" }], "sync"));

    expect(runOpenSpec).not.toHaveBeenCalled();
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

  test("warns naming a reinstall when the bundled CLI is missing, and still deploys Mate skills", async () => {
    const root = await makeTempDir("mate-openspec-launch-missing-");
    const runOpenSpec = mock(async () => OPENSPEC_OK);
    const plugin = createOpenspecPlugin({ runOpenSpec, locateOpenSpec: () => OPENSPEC_MISSING });

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await plugin.apply(makeCtx(root, ["claude"], [{ name: "openspec" }], "sync"));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Reinstall Mate"));
    } finally {
      stderrSpy.mockRestore();
    }

    expect(runOpenSpec).not.toHaveBeenCalled();
    await expect(
      fs.access(path.join(root, ".claude", "skills", "mate-grill-me", "SKILL.md")),
    ).resolves.toBeNull();
  });
  test("warns about a missing bundled CLI without any skill runtime active", async () => {
    const root = await makeTempDir("mate-openspec-launch-missing-headless-");
    const plugin = createOpenspecPlugin({
      ...openspecAvailable,
      locateOpenSpec: () => OPENSPEC_MISSING,
    });

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await plugin.apply(makeCtx(root, [], [{ name: "openspec" }], "sync"));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Reinstall Mate"));
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
