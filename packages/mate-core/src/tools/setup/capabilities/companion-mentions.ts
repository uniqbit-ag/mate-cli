import path from "node:path";

import { runtimeClaudeCapabilityPluginsRoot } from "../../../runtime/runtime-directory";
import type { CapabilityPlugin, RuntimeContributionsByRuntime } from "../plugin";

const ID = "companion-mentions";

export function createCompanionMentionsPlugin(): CapabilityPlugin {
  return {
    id: ID,
    kind: "capability",
    label: "Companion Mentions",
    description: "Find and attach companion files from Claude Code's @ menu as @mate:<path>.",
    defaultSelected: false,
    isEnabled: (config) => (config.capabilities ?? []).some((c) => c.name === ID),
    // The wrap writes this path into settings.local.json, so it names the runtime link, never the install.
    getRuntimeContributions(): RuntimeContributionsByRuntime {
      return {
        claude: {
          pluginDirectories: [{ path: path.join(runtimeClaudeCapabilityPluginsRoot(), ID) }],
        },
      };
    },
    async apply() {},
    async teardown() {},
  };
}
