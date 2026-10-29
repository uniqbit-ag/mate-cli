import type { CapabilityConfig, CliToolConfig, FrameworkConfig, GitModeProfile } from "./types";

export type GitModeSelection = GitModeProfile | "default";
export const DEFAULT_GIT_MODE_SELECTION: GitModeSelection = "default";

export interface GitModeCompatibility {
  id: GitModeSelection;
  label: string;
  description: string;
  defaultSelected: boolean;
}

const BUILTIN_GIT_MODE_COMPATIBILITIES: GitModeCompatibility[] = [
  {
    id: "default",
    label: "Off (manual git flow)",
    description: "Keep companion Git synchronization manual.",
    defaultSelected: true,
  },
  {
    id: "auto",
    label: "On (auto mode)",
    description: "Automatically synchronize the companion Git state before agent launches.",
    defaultSelected: false,
  },
];

export interface SetupSelections {
  allowedAgents: string[];
  packageManagers: string[];
  capabilities: CapabilityConfig[];
  selectedGitMode: GitModeSelection;
}

interface SetupCompatibilityBase {
  id: string;
  label: string;
  description: string;
  defaultSelected: boolean;
  templateRoot?: string;
}

export interface SetupProviderCompatibility extends SetupCompatibilityBase {
  kind: "provider";
  agent: string;
}

export interface SetupCapabilityCompatibility extends SetupCompatibilityBase {
  kind: "capability";
  capability: CapabilityConfig;
  cliTools?: CliToolConfig[];
  requires?: {
    packageManagers: string[];
  };
}

export interface SetupPackageManagerCompatibility extends SetupCompatibilityBase {
  kind: "packageManager";
  packageManager: string;
  language: string;
  locked?: boolean;
}

export type SetupCompatibility =
  | SetupProviderCompatibility
  | SetupPackageManagerCompatibility
  | SetupCapabilityCompatibility;

export const BUILTIN_SETUP_COMPATIBILITIES: SetupCompatibility[] = [
  {
    id: "claude",
    kind: "provider",
    agent: "claude",
    label: "Claude",
    description: "Install Claude companion files, hooks, and guidance.",
    defaultSelected: true,
    templateRoot: "setup-providers/claude",
  },
  {
    id: "opencode",
    kind: "provider",
    agent: "opencode",
    label: "OpenCode",
    description: "Install the OpenCode plugin workspace and wrappers.",
    defaultSelected: false,
    templateRoot: "setup-providers/opencode",
  },
  {
    id: "bun",
    kind: "packageManager",
    packageManager: "bun",
    language: "node",
    label: "bun",
    description: "Framework runtime package manager for Node.js workflows.",
    defaultSelected: true,
    locked: true,
  },
  {
    id: "uv",
    kind: "packageManager",
    packageManager: "uv",
    language: "python",
    label: "uv",
    description: "Python package manager and project bootstrap for companion capabilities.",
    defaultSelected: true,
    locked: true,
  },
  {
    id: "openspec",
    kind: "capability",
    capability: { name: "openspec" },
    label: "OpenSpec",
    description: "Route OpenSpec commands to the companion root and enable planning workflows.",
    defaultSelected: true,
    cliTools: [{ name: "openspec", redirectCwd: "companionRoot" }],
  },
  {
    id: "react-doctor",
    kind: "capability",
    capability: { name: "react-doctor" },
    label: "React Doctor",
    description: "Install the mate-react-doctor skill that verifies React changes during apply.",
    defaultSelected: true,
    templateRoot: "capabilities/react-doctor",
  },
  {
    id: "tokensave",
    kind: "capability",
    capability: { name: "tokensave" },
    label: "TokenSave",
    description: "Enable TokenSave MCP access while keeping native repo-local .tokensave storage.",
    defaultSelected: false,
  },
  {
    id: "rtk",
    kind: "capability",
    capability: { name: "rtk" },
    label: "RTK",
    description: "Patch supported agent providers with the RTK token-optimizing CLI proxy.",
    defaultSelected: false,
  },
  {
    id: "graphify",
    kind: "capability",
    capability: { name: "graphify" },
    label: "Graphify",
    description:
      "Enable Graphify code graph analysis with companion-managed wrappers for supported agent sessions.",
    defaultSelected: false,
  },
];

export function listSetupProviderCompatibilities(): SetupProviderCompatibility[] {
  return BUILTIN_SETUP_COMPATIBILITIES.filter(
    (entry): entry is SetupProviderCompatibility => entry.kind === "provider",
  );
}

export function listSetupCapabilityCompatibilities(): SetupCapabilityCompatibility[] {
  return BUILTIN_SETUP_COMPATIBILITIES.filter(
    (entry): entry is SetupCapabilityCompatibility => entry.kind === "capability",
  );
}

export function listSetupPackageManagerCompatibilities(): SetupPackageManagerCompatibility[] {
  return BUILTIN_SETUP_COMPATIBILITIES.filter(
    (entry): entry is SetupPackageManagerCompatibility => entry.kind === "packageManager",
  );
}

export function listSetupGitModeCompatibilities(): GitModeCompatibility[] {
  return [...BUILTIN_GIT_MODE_COMPATIBILITIES];
}

function getLockedPackageManagers(): string[] {
  const locked: string[] = [];
  for (const entry of listSetupPackageManagerCompatibilities()) {
    if (entry.locked) locked.push(entry.packageManager);
  }
  return locked;
}

export function getDefaultSetupSelections(): SetupSelections {
  const allowedAgents: string[] = [];
  for (const entry of listSetupProviderCompatibilities()) {
    if (entry.defaultSelected) allowedAgents.push(entry.agent);
  }

  const packageManagers: string[] = [];
  for (const entry of listSetupPackageManagerCompatibilities()) {
    if (entry.defaultSelected) packageManagers.push(entry.packageManager);
  }

  const capabilities: CapabilityConfig[] = [];
  for (const entry of listSetupCapabilityCompatibilities()) {
    if (entry.defaultSelected) capabilities.push(entry.capability);
  }

  return {
    allowedAgents,
    packageManagers,
    capabilities,
    selectedGitMode: DEFAULT_GIT_MODE_SELECTION,
  };
}

export function getSetupSelectionsFromConfig(config: FrameworkConfig): SetupSelections {
  return {
    allowedAgents: [...new Set(config.allowedAgents ?? [])],
    packageManagers: [
      ...new Set([...getLockedPackageManagers(), ...(config.packageManagers ?? [])]),
    ],
    capabilities: dedupeCapabilities(config.capabilities ?? []),
    selectedGitMode: config.git ?? DEFAULT_GIT_MODE_SELECTION,
  };
}

/**
 * Re-selected capabilities keep their saved settings (such as openspec's
 * `protectedBranches`); pickers and flags only name the capabilities.
 */
export function keepCapabilitySettings(
  selected: CapabilityConfig[],
  saved: CapabilityConfig[],
): CapabilityConfig[] {
  const byName = new Map(saved.map((capability) => [capability.name, capability]));
  return selected.map((capability) => {
    // `schemaProfile` is a removed setting; a re-save drops it.
    const { schemaProfile: _removed, ...settings } = (byName.get(capability.name) ??
      {}) as CapabilityConfig & { schemaProfile?: unknown };
    return { ...capability, ...settings };
  });
}

export function dedupeCapabilities(capabilities: CapabilityConfig[]): CapabilityConfig[] {
  const seen = new Set<string>();
  const result: CapabilityConfig[] = [];
  for (const capability of capabilities) {
    if (seen.has(capability.name)) continue;
    seen.add(capability.name);
    result.push(capability);
  }
  return result;
}

export function mergeCliTools(
  defaults: CliToolConfig[],
  userList: CliToolConfig[] | undefined,
): CliToolConfig[] {
  if (!userList || userList.length === 0) return defaults;

  const merged = [...defaults];
  for (const tool of userList) {
    const index = merged.findIndex((entry) => entry.name === tool.name);
    if (index >= 0) {
      merged[index] = tool;
    } else {
      merged.push(tool);
    }
  }

  return merged;
}

export function getCompatibilityCliTools(capabilities: CapabilityConfig[]): CliToolConfig[] {
  const selected = new Set(capabilities.map((entry) => entry.name));
  const tools: CliToolConfig[] = [];
  for (const compatibility of listSetupCapabilityCompatibilities()) {
    if (!selected.has(compatibility.capability.name)) continue;
    for (const tool of compatibility.cliTools ?? []) {
      const existing = tools.findIndex((entry) => entry.name === tool.name);
      if (existing >= 0) {
        tools[existing] = tool;
      } else {
        tools.push(tool);
      }
    }
  }
  return tools;
}

export function getEffectiveCliTools(config: FrameworkConfig): CliToolConfig[] {
  return mergeCliTools(getCompatibilityCliTools(config.capabilities ?? []), config.cliTools);
}
