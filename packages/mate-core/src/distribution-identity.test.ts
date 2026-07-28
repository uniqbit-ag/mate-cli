import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { getActiveDistribution, setActiveDistribution } from "./distribution";
import type { DistributionUpdateConfig } from "./distribution";
import { usage } from "./cli/usage";
import { LaunchAdapter, type AdapterContext } from "./lib/orchestrator/adapters/base";
import { getDefaultWorkingRepoPath } from "./lib/orchestrator/working-repo-store";
import { repoLocalDirPath } from "./lib/orchestrator/repo-local-registry";
import { formatSetupGuardrailError } from "./lib/orchestrator/setup-preflight";
import { getUpdateConfig } from "./lib/update-checker";
import { buildCompanionGuidance } from "./playbooks/companion-guidance";
import { mateFolderReadme, updateProjectGitignore } from "./tools/setup";
import { deployMateSkillDir } from "./tools/setup/capabilities/openspec";
import {
  getCompanionClaudeSettingsPath,
  syncCompanionClaudeSettings,
} from "./tools/setup/providers/claude";
import type { FrameworkConfig } from "./lib/orchestrator/types";

const originalDistribution = getActiveDistribution();
const tempRoots: string[] = [];

function useDistribution(name: string, update?: DistributionUpdateConfig): void {
  setActiveDistribution({
    config: { ...originalDistribution.config, name, update },
    registry: originalDistribution.registry,
  });
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

class TestAdapter extends LaunchAdapter {
  readonly toolName = "claude";
  buildArgs(): string[] {
    return [];
  }
}

function adapterContext(companionPath: string): AdapterContext {
  return {
    repository: { id: "app", path: path.join(companionPath, "repo"), profile: "default" },
    policy: {} as AdapterContext["policy"],
    companionPath,
    capabilities: [{ name: "openspec" }, { name: "tokensave" }],
  };
}

const COMPANION_CONFIG: FrameworkConfig = {
  type: "companion",
  profiles: { default: { name: "default", allowedAgents: ["claude"] } },
  capabilities: [{ name: "openspec" }, { name: "graphify" }],
};

afterEach(async () => {
  setActiveDistribution(originalDistribution);
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("acme whitelabel distribution", () => {
  test("usage renders acme commands and the identity package reference", () => {
    useDistribution("acme");
    const text = usage();
    expect(text).toContain("Acme CLI (@uniqbit/mate)");
    expect(text).toContain(" acme companion link");
    expect(text).toContain(" acme doctor");
    expect(text).not.toMatch(/^ mate /m);
  });

  test("usage prefers the configured update package name", () => {
    useDistribution("acme", { packageName: "@acme/acme" });
    expect(usage()).toContain("Acme CLI (@acme/acme)");
  });

  test("command hints follow the invocation name", () => {
    useDistribution("acme");
    const message = formatSetupGuardrailError("/tmp/sample", {
      companionPath: "/tmp/companion",
      repositoryId: "app",
    });
    expect(message).toContain("`acme setup`");
    expect(message).not.toContain("`mate setup`");
  });

  test("companion guidance invokes acme against the mate framework identity", () => {
    useDistribution("acme");
    const companionPath = "/tmp/companion";
    const guidance = buildCompanionGuidance(adapterContext(companionPath), {
      wrapperBinPath: "/pkg/wrappers/bin",
    });
    expect(guidance).toContain('<companion-policy framework="mate" priority="mandatory">');
    expect(guidance).toContain('<cli name="mate" type="global" invokeAs="acme" />');
    expect(guidance).toContain('acme artifact finish "<name>" --json');
    expect(guidance).toContain("run acme cap index --tokensave.");
  });

  test("state paths stay mate", () => {
    useDistribution("acme");
    expect(getDefaultWorkingRepoPath()).toBe(".mate/config/registry.yaml");
    expect(repoLocalDirPath("/tmp/sample-repo")).toBe("/tmp/sample-repo/.mate");
  });

  test("managed gitignore markers stay mate", async () => {
    useDistribution("acme");
    const companionPath = await makeTempDir("acme-gitignore-");
    await updateProjectGitignore(companionPath, COMPANION_CONFIG);
    const content = await fs.readFile(path.join(companionPath, ".gitignore"), "utf8");
    expect(content).toContain("# mate managed: start");
    expect(content).toContain("# mate managed: end");
    expect(content).not.toContain("acme");
  });

  test("update package reference falls back to the identity, not the bin name", () => {
    useDistribution("acme");
    expect(getUpdateConfig().packageName).toBe("@uniqbit/mate");
  });

  test("launch env exposes identity and invocation name separately", () => {
    useDistribution("acme");
    const env = new TestAdapter().environment(adapterContext("/tmp/companion"));
    expect(env.MATE_NAME).toBe("mate");
    expect(env.MATE_COMMAND).toBe("acme");
  });

  test("claude permission entries use the invocation name", async () => {
    useDistribution("acme");
    const companionPath = await makeTempDir("acme-claude-perm-");
    await syncCompanionClaudeSettings(companionPath, COMPANION_CONFIG);
    const settings = JSON.parse(
      await fs.readFile(getCompanionClaudeSettingsPath(companionPath), "utf8"),
    ) as { permissions?: { allow?: string[] } };
    expect(settings.permissions?.allow).toContain("Bash(acme:*)");
    expect(settings.permissions?.allow).toContain("Bash(acme cap graphify:*)");
    expect(settings.permissions?.allow).not.toContain("Bash(mate:*)");
    expect(settings.permissions?.allow).not.toContain("Bash(mate cap graphify:*)");
  });

  test("companion readme mixes identity directory with acme commands", () => {
    useDistribution("acme");
    const readme = mateFolderReadme();
    expect(readme).toContain("# .mate");
    expect(readme).toContain("**mate** companion framework (`@uniqbit/mate`)");
    expect(readme).toContain("| `acme companion setup` |");
    expect(readme).toContain("Edit `.mate/config/framework.yaml`");
    expect(readme).not.toContain("`mate companion");
  });
});

describe("default mate distribution output", () => {
  test("usage is the pre-split output", () => {
    const text = usage();
    expect(text).toContain("Mate CLI (@uniqbit/mate)");
    expect(text).toContain(" mate companion link");
    expect(text).toContain(" mate cap index [--graphify] [--tokensave]");
  });

  test("companion guidance is the pre-split output", () => {
    const guidance = buildCompanionGuidance(adapterContext("/tmp/companion"), {
      wrapperBinPath: "/pkg/wrappers/bin",
    });
    expect(guidance).toContain('<companion-policy framework="mate" priority="mandatory">');
    expect(guidance).toContain('<cli name="mate" type="global" invokeAs="mate" />');
    expect(guidance).toContain('mate artifact finish "<name>" --json');
    expect(guidance).toContain("run mate cap index --tokensave.");
  });

  test("companion readme is the pre-split output", () => {
    const readme = mateFolderReadme();
    expect(readme).toContain("# .mate");
    expect(readme).toContain("**mate** companion framework (`@uniqbit/mate`)");
    expect(readme).toContain("| `mate companion setup` |");
  });

  test("gitignore block and claude permissions are the pre-split output", async () => {
    const companionPath = await makeTempDir("mate-default-output-");
    await updateProjectGitignore(companionPath, COMPANION_CONFIG);
    const gitignore = await fs.readFile(path.join(companionPath, ".gitignore"), "utf8");
    expect(gitignore).toContain("# mate managed: start");

    await syncCompanionClaudeSettings(companionPath, COMPANION_CONFIG);
    const settings = JSON.parse(
      await fs.readFile(getCompanionClaudeSettingsPath(companionPath), "utf8"),
    ) as { permissions?: { allow?: string[] } };
    expect(settings.permissions?.allow).toContain("Bash(mate:*)");
    expect(settings.permissions?.allow).toContain("Bash(mate cap graphify:*)");
  });
});

describe("skill template deploy substitution", () => {
  const SKILL_TEMPLATE_DIR = path.join(
    import.meta.dirname,
    "templates/capabilities/openspec-cap/mate-skills/mate-artifact-finish",
  );

  test("substitutes the placeholder and byte-copies placeholder-free files", async () => {
    useDistribution("acme");
    const root = await makeTempDir("acme-skill-deploy-");
    const src = path.join(root, "src");
    await fs.mkdir(path.join(src, "references"), { recursive: true });
    await fs.writeFile(
      path.join(src, "SKILL.md"),
      "Run `{{MATE_COMMAND}} artifact finish` to finish.\n",
      "utf8",
    );
    const plainContent = "No placeholder here.\r\né\n";
    await fs.writeFile(path.join(src, "references", "plain.md"), plainContent, "utf8");

    const dest = path.join(root, "dest");
    await deployMateSkillDir(src, dest);

    const skill = await fs.readFile(path.join(dest, "SKILL.md"), "utf8");
    expect(skill).toBe("Run `acme artifact finish` to finish.\n");
    const srcBytes = await fs.readFile(path.join(src, "references", "plain.md"));
    const destBytes = await fs.readFile(path.join(dest, "references", "plain.md"));
    expect(destBytes.equals(srcBytes)).toBe(true);
  });

  test("the shipped skill template deploys without unsubstituted placeholders", async () => {
    useDistribution("acme");
    const dest = await makeTempDir("acme-skill-template-");
    await deployMateSkillDir(SKILL_TEMPLATE_DIR, dest);

    const files: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(entryPath);
        } else {
          files.push(entryPath);
        }
      }
    }
    await walk(dest);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      expect(await fs.readFile(file, "utf8")).not.toContain("{{MATE_COMMAND}}");
    }
    const skill = await fs.readFile(path.join(dest, "SKILL.md"), "utf8");
    expect(skill).toContain("acme artifact finish");
    expect(skill).not.toContain("`mate artifact finish`");
  });

  test("the default distribution deploys the skill with mate invocations", async () => {
    const dest = await makeTempDir("mate-skill-template-");
    await deployMateSkillDir(SKILL_TEMPLATE_DIR, dest);
    const skill = await fs.readFile(path.join(dest, "SKILL.md"), "utf8");
    expect(skill).toContain("`mate artifact finish`");
    expect(skill).not.toContain("{{MATE_COMMAND}}");
  });
});
