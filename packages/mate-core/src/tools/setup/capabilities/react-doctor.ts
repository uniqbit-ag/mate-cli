import fs from "node:fs/promises";
import path from "node:path";

import type { CapabilityPlugin, SetupContext } from "../plugin";
import { mergeDir, pruneEmptyAncestors } from "../utils";

export const SKILL_SRC = path.join(
  import.meta.dirname,
  "../../../templates/capabilities/react-doctor/skill",
);
export const CLAUDE_HOOK_SRC = path.join(
  import.meta.dirname,
  "../../../templates/capabilities/react-doctor/claude/hooks/react-doctor.sh",
);

export async function applyReactDoctorSkills(skillsDir: string): Promise<void> {
  await mergeDir(SKILL_SRC, skillsDir);
}

export async function teardownReactDoctorSkills(
  skillsDir: string,
  companionPath: string,
): Promise<void> {
  try {
    await fs.rm(skillsDir, { recursive: true, force: true });
  } catch {
    /* not present */
  }
  await pruneEmptyAncestors(path.dirname(skillsDir), companionPath);
}

export function createReactDoctorPlugin(): CapabilityPlugin {
  return {
    id: "react-doctor",
    kind: "capability",
    label: "React Doctor",
    description: "Install React Doctor skills and Claude post-edit scans.",
    defaultSelected: true,
    isEnabled: (config) => (config.capabilities ?? []).some((c) => c.name === "react-doctor"),
    async apply(ctx: SetupContext) {
      // Migrate: remove legacy shared .agents/skills/react-doctor/ from previous installs.
      try {
        await fs.rm(path.join(ctx.companionPath, ".agents", "skills", "react-doctor"), {
          recursive: true,
          force: true,
        });
      } catch {
        /* not present */
      }
      await pruneEmptyAncestors(
        path.join(ctx.companionPath, ".agents", "skills"),
        ctx.companionPath,
      );
      await pruneEmptyAncestors(path.join(ctx.companionPath, ".agents"), ctx.companionPath);
    },
    async teardown() {},
    forProvider: {
      claude: {
        async apply(ctx: SetupContext) {
          const skillsDir = path.join(ctx.companionPath, ".claude", "skills", "react-doctor");
          await applyReactDoctorSkills(skillsDir);
          const hookDest = path.join(ctx.companionPath, ".claude", "hooks", "react-doctor.sh");
          await fs.mkdir(path.dirname(hookDest), { recursive: true });
          await fs.copyFile(CLAUDE_HOOK_SRC, hookDest);
          await fs.chmod(hookDest, 0o755);
        },
        async teardown(ctx: SetupContext) {
          await teardownReactDoctorSkills(
            path.join(ctx.companionPath, ".claude", "skills", "react-doctor"),
            ctx.companionPath,
          );
          try {
            await fs.unlink(path.join(ctx.companionPath, ".claude", "hooks", "react-doctor.sh"));
          } catch {
            /* not present */
          }
          await pruneEmptyAncestors(
            path.join(ctx.companionPath, ".claude", "hooks"),
            ctx.companionPath,
          );
        },
      },
      opencode: {
        async apply(ctx: SetupContext) {
          await applyReactDoctorSkills(
            path.join(ctx.companionPath, ".opencode", "skills", "react-doctor"),
          );
        },
        async teardown(ctx: SetupContext) {
          await teardownReactDoctorSkills(
            path.join(ctx.companionPath, ".opencode", "skills", "react-doctor"),
            ctx.companionPath,
          );
        },
      },
    },
  };
}
