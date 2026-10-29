/**
 * A Capability whose only effect is the Claude Code mod in `claude-plugin/`.
 * Type-only imports from mate-core, as the loader requires.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CapabilityPlugin } from "@uniqbit/mate-core";

const PACKAGE_NAME = "@uniqbit/mate-plugin-companion-mentions";

const pluginRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "claude-plugin");

/** Accepts no configuration, so a typo shows instead of being ignored. */
function rejectConfig(config: unknown): void {
  if (config === undefined || config === null) return;
  if (typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${PACKAGE_NAME} takes no configuration; remove its config block.`);
  }
  const keys = Object.keys(config);
  if (keys.length > 0) {
    throw new Error(`${PACKAGE_NAME} takes no configuration; remove: ${keys.join(", ")}.`);
  }
}

export default function createPlugin(config: unknown): CapabilityPlugin {
  rejectConfig(config);
  return {
    id: "companion-mentions",
    kind: "capability",
    label: "Companion Mentions",
    description: "Find and attach companion files from Claude Code's @ menu as @mate:<path>.",
    defaultSelected: false,
    isEnabled: () => true,
    apply: async () => {},
    teardown: async () => {},
    getRuntimeContributions: () => ({ claude: { pluginDirectories: [{ path: pluginRoot }] } }),
  };
}
