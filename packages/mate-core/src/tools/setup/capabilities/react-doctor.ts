import fs from "node:fs/promises";
import path from "node:path";

import { getReactDoctorBinPath } from "../../../lib/package-paths";
import type { CapabilityPlugin, RuntimeContributionsByRuntime, SetupContext } from "../plugin";
import { removeLegacyOpenCodeSkills, removeSharedSkills } from "../providers/agents-skill-root";
import { pruneEmptyAncestors } from "../utils";

const SKILL_NAME = "mate-react-doctor";
// The upstream skill earlier releases installed under its own name.
const LEGACY_SKILL_NAME = "react-doctor";

const SKILL_SRC = path.join(
  import.meta.dirname,
  "../../../templates/capabilities/react-doctor/mate-react-doctor",
);

/** Removes the skill copies earlier releases installed under the upstream name. */
async function removeLegacySkills(companionPath: string): Promise<void> {
  const claudeSkillsDir = path.join(companionPath, ".claude", "skills");
  await fs.rm(path.join(claudeSkillsDir, LEGACY_SKILL_NAME), { recursive: true, force: true });
  await pruneEmptyAncestors(claudeSkillsDir, companionPath);
  await removeSharedSkills(companionPath, [LEGACY_SKILL_NAME]);
  await removeLegacyOpenCodeSkills(companionPath, [LEGACY_SKILL_NAME]);
}

/** Removes the post-edit hook script earlier releases copied into the companion. */
async function removeLegacyHookScript(companionPath: string): Promise<void> {
  const hooksDir = path.join(companionPath, ".claude", "hooks");
  await fs.rm(path.join(hooksDir, "react-doctor.sh"), { force: true });
  await pruneEmptyAncestors(hooksDir, companionPath);
}

export function createReactDoctorPlugin(): CapabilityPlugin {
  return {
    id: "react-doctor",
    kind: "capability",
    label: "React Doctor",
    description: "Install the mate-react-doctor skill that verifies React changes during apply.",
    defaultSelected: true,
    isEnabled: (config) => (config.capabilities ?? []).some((c) => c.name === "react-doctor"),
    // React Doctor runs only when an agent invokes the skill (the shared Mate
    // verification rule adds it to OpenSpec task lists), so the capability
    // contributes no hooks: just the skill and its permission pre-seeds.
    getRuntimeContributions(): RuntimeContributionsByRuntime {
      const skillTrees = [{ name: SKILL_NAME, sourceDir: SKILL_SRC }];
      return {
        claude: {
          permissionEntries: [`Skill(${SKILL_NAME})`, `Bash(${getReactDoctorBinPath()}:*)`],
          skillTrees,
        },
        opencode: { skillTrees },
      };
    },
    async apply(ctx: SetupContext) {
      await removeLegacySkills(ctx.companionPath);
    },
    async teardown(ctx: SetupContext) {
      await removeLegacySkills(ctx.companionPath);
    },
    // Cleanup only: stale hook groups are stripped by settings-sync through the
    // `react-doctor.sh` managed marker; the script file itself is removed here.
    forProvider: {
      claude: {
        async apply(ctx: SetupContext) {
          await removeLegacyHookScript(ctx.companionPath);
        },
        async teardown(ctx: SetupContext) {
          await removeLegacyHookScript(ctx.companionPath);
        },
      },
    },
  };
}
