import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { getReactDoctorBinPath } from "../../../lib/package-paths";
import type { SetupContext } from "../plugin";
import { createReactDoctorPlugin } from "./react-doctor";

const reactDoctorPlugin = createReactDoctorPlugin();

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function context(companionPath: string, enabled = true): SetupContext {
  return {
    companionPath,
    config: {
      allowedAgents: ["claude", "opencode"],
      capabilities: enabled ? [{ name: "react-doctor" }] : [],
    },
    mode: "setup",
    activeProviders: ["claude", "opencode"],
  };
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(
    () => true,
    () => false,
  );
}

/** Seeds every artifact an earlier, hook-based release could have left behind. */
async function seedLegacyArtifacts(companionPath: string): Promise<string[]> {
  const legacy = [
    path.join(companionPath, ".claude", "skills", "react-doctor"),
    path.join(companionPath, ".agents", "skills", "react-doctor"),
    path.join(companionPath, ".opencode", "skills", "react-doctor"),
  ];
  for (const dir of legacy) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), "react-doctor\n", "utf8");
  }
  const hook = path.join(companionPath, ".claude", "hooks", "react-doctor.sh");
  await fs.mkdir(path.dirname(hook), { recursive: true });
  await fs.writeFile(hook, "#!/bin/sh\nexit 0\n", "utf8");
  return [...legacy, hook];
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("reactDoctorPlugin", () => {
  test("contributes no hooks for any runtime", async () => {
    const contributions = reactDoctorPlugin.getRuntimeContributions?.(
      context(await makeTempDir("mate-react-doctor-hooks-")),
    );

    expect(contributions?.claude?.hookGroups ?? []).toEqual([]);
    expect(contributions?.opencode?.hookGroups ?? []).toEqual([]);
  });

  test("ships the mate-react-doctor skill to Claude and the shared root", async () => {
    const contributions = reactDoctorPlugin.getRuntimeContributions?.(
      context(await makeTempDir("mate-react-doctor-skill-")),
    );

    for (const runtime of ["claude", "opencode"] as const) {
      const trees = contributions?.[runtime]?.skillTrees ?? [];
      expect(trees.map((tree) => tree.name)).toEqual(["mate-react-doctor"]);
      const skill = await fs.readFile(path.join(trees[0].sourceDir, "SKILL.md"), "utf8");
      expect(skill).toContain("name: mate-react-doctor");
      expect(skill).toContain("credits:");
      expect(skill).toContain("author: Million Software, Inc.");
      expect(skill).toContain("MATE_REACT_DOCTOR_BIN_PATH");
      expect(skill).not.toMatch(/npx react-doctor(@latest)? --/);
      expect(skill.replace(/^metadata:[\s\S]*?^---$/m, "")).not.toContain("https://");
      await expect(
        fs.access(path.join(trees[0].sourceDir, "references", "explain.md")),
      ).resolves.toBeNull();
    }
  });

  test("pre-seeds the skill and the pinned binary instead of npx", async () => {
    const contributions = reactDoctorPlugin.getRuntimeContributions?.(
      context(await makeTempDir("mate-react-doctor-perms-")),
    );

    expect(contributions?.claude?.permissionEntries).toEqual([
      "Skill(mate-react-doctor)",
      `Bash(${getReactDoctorBinPath()}:*)`,
    ]);
  });

  test("apply removes legacy hook and skill artifacts", async () => {
    const companionPath = await makeTempDir("mate-react-doctor-apply-");
    const legacy = await seedLegacyArtifacts(companionPath);

    await reactDoctorPlugin.apply(context(companionPath));
    await reactDoctorPlugin.forProvider?.claude?.apply?.(context(companionPath));

    for (const target of legacy) expect(await exists(target)).toBe(false);
    expect(await exists(path.join(companionPath, ".claude", "hooks"))).toBe(false);
  });

  test("teardown removes legacy hook and skill artifacts", async () => {
    const companionPath = await makeTempDir("mate-react-doctor-teardown-");
    const legacy = await seedLegacyArtifacts(companionPath);

    await reactDoctorPlugin.teardown(context(companionPath, false));
    await reactDoctorPlugin.forProvider?.claude?.teardown?.(context(companionPath, false));

    for (const target of legacy) expect(await exists(target)).toBe(false);
  });

  test("cleanup is silent when nothing is present", async () => {
    const companionPath = await makeTempDir("mate-react-doctor-empty-");

    await reactDoctorPlugin.apply(context(companionPath));
    await reactDoctorPlugin.forProvider?.claude?.apply?.(context(companionPath));
    await reactDoctorPlugin.teardown(context(companionPath, false));
    await reactDoctorPlugin.forProvider?.claude?.teardown?.(context(companionPath, false));

    expect(await fs.readdir(companionPath)).toEqual([]);
  });

  test("cleanup keeps other hook files", async () => {
    const companionPath = await makeTempDir("mate-react-doctor-other-hooks-");
    await seedLegacyArtifacts(companionPath);
    const other = path.join(companionPath, ".claude", "hooks", "user-hook.sh");
    await fs.writeFile(other, "#!/bin/sh\n", "utf8");

    await reactDoctorPlugin.forProvider?.claude?.apply?.(context(companionPath));

    expect(await exists(other)).toBe(true);
  });

  test("teardown leaves companion Claude settings untouched", async () => {
    const companionPath = await makeTempDir("mate-react-doctor-claude-teardown-");
    const settingsPath = path.join(companionPath, ".claude", "settings.local.json");
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    const settings = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: 'sh "/tmp/react-doctor.sh"' }] }],
        PreToolUse: [{ matcher: "Write", hooks: [] }],
      },
    };
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");

    await reactDoctorPlugin.forProvider?.claude?.teardown?.(context(companionPath, false));

    expect(JSON.parse(await fs.readFile(settingsPath, "utf8"))).toEqual(settings);
  });
});
