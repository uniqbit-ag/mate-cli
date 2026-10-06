import fs from "node:fs/promises";
import path from "node:path";

import type { CapabilityPlugin, RuntimeContributionsByRuntime, SetupContext } from "../plugin";
import { removeLegacyOpenCodeSkills } from "../providers/agents-skill-root";
import { pruneEmptyAncestors } from "../utils";

const SKILL_NAME = "react-doctor";

const SKILL_SRC = path.join(
  import.meta.dirname,
  "../../../templates/capabilities/react-doctor/skill",
);
export const CLAUDE_HOOK_SRC = path.join(
  import.meta.dirname,
  "../../../templates/capabilities/react-doctor/claude/hooks/react-doctor.sh",
);

export function createReactDoctorPlugin(): CapabilityPlugin {
  return {
    id: "react-doctor",
    kind: "capability",
    label: "React Doctor",
    description: "Install React Doctor skills and Claude post-edit scans.",
    defaultSelected: true,
    isEnabled: (config) => (config.capabilities ?? []).some((c) => c.name === "react-doctor"),
    // Skills, session hooks, and permission pre-seeds are declared and
    // reconciled by each runtime's Runtime Surface. Only the hook script file
    // itself is copied imperatively below (script files are not a config
    // format the surface owns).
    getRuntimeContributions(ctx: SetupContext): RuntimeContributionsByRuntime {
      const hookCommand = `sh "${ctx.companionPath}/.claude/hooks/react-doctor.sh"`;
      const skillTrees = [{ name: SKILL_NAME, sourceDir: SKILL_SRC }];
      return {
        claude: {
          hookGroups: [
            // Record edits cheaply, then scan once when the edited turn finishes.
            {
              event: "PostToolUse",
              marker: "react-doctor.sh",
              group: {
                matcher: "Write|Edit|MultiEdit|NotebookEdit|ApplyPatch",
                hooks: [{ type: "command", command: hookCommand, timeout: 5 }],
              },
            },
            {
              event: "Stop",
              marker: "react-doctor.sh",
              group: { hooks: [{ type: "command", command: hookCommand, timeout: 45 }] },
            },
          ],
          permissionEntries: [
            "Skill(react-doctor)",
            "Bash(npx react-doctor:*)",
            "Bash(npx react-doctor@latest *)",
          ],
          skillTrees,
        },
        opencode: { skillTrees },
      };
    },
    async apply(ctx: SetupContext) {
      await removeLegacyOpenCodeSkills(ctx.companionPath, [SKILL_NAME]);
    },
    async teardown(ctx: SetupContext) {
      await removeLegacyOpenCodeSkills(ctx.companionPath, [SKILL_NAME]);
    },
    forProvider: {
      claude: {
        async apply(ctx: SetupContext) {
          const hookDest = path.join(ctx.companionPath, ".claude", "hooks", "react-doctor.sh");
          await fs.mkdir(path.dirname(hookDest), { recursive: true });
          await fs.copyFile(CLAUDE_HOOK_SRC, hookDest);
          await fs.chmod(hookDest, 0o755);
        },
        async teardown(ctx: SetupContext) {
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
    },
  };
}
