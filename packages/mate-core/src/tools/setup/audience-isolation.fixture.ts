// oxlint-disable no-await-in-loop
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { FrameworkConfig } from "../../lib/orchestrator/types";
import { pluginPackageRoot } from "./dynamic-plugins/paths";
import type {
  CapabilityPlugin,
  PluginRegistration,
  ProviderPlugin,
  RuntimeContributions,
} from "./plugin";

/**
 * Audience isolation harness: one companion whose base plugin and audience
 * `ba` and `qa` plugins each declare every contribution kind, every value
 * carrying its owner's marker. A test runs a pass, then asserts which markers
 * a surface holds — a marker found where it must not be is a leak.
 */

export type FixtureOwner = "base" | "ba" | "qa";

export const AUDIENCE_MARKERS: Record<FixtureOwner, string> = {
  base: "BASEMARK7",
  ba: "BAMARK7",
  qa: "QAMARK7",
};

export const FIXTURE_AUDIENCES = ["ba", "qa"] as const;

export function fixturePluginId(owner: FixtureOwner): string {
  return `${owner}-plugin`;
}

export function fixturePackage(owner: FixtureOwner): string {
  return `@fixture/${owner}`;
}

export interface FixtureCapabilityOptions {
  apply?: () => Promise<void>;
  teardown?: () => Promise<void>;
  forProvider?: CapabilityPlugin["forProvider"];
  pluginReference?: string;
}

function contributionsFor(
  owner: FixtureOwner,
  skillSourceDir: string,
  runtime: "claude" | "opencode",
  options: FixtureCapabilityOptions,
): RuntimeContributions {
  const marker = AUDIENCE_MARKERS[owner];
  const contributions: RuntimeContributions = {
    mcpServers: [{ name: `${owner}-mcp`, command: `${marker}-server`, args: ["serve"] }],
    guidanceSections: [{ content: `${marker} guidance for ${owner}.` }],
    skillTrees: [{ name: `${owner}-skill`, sourceDir: skillSourceDir }],
    agentDefinitions: [
      {
        name: `${owner}-agent`,
        content: `---\nname: ${owner}-agent\ndescription: ${owner} agent\n---\n${marker} agent prompt.\n`,
      },
    ],
    permissionEntries: [`Bash(${marker}:*)`],
  };
  if (runtime === "claude") {
    contributions.hookGroups = [
      {
        event: "PreToolUse",
        marker: `${marker}-hook.sh`,
        group: { matcher: "Bash", hooks: [{ type: "command", command: `${marker}-hook.sh` }] },
      },
    ];
  }
  if (runtime === "opencode" && options.pluginReference) {
    const reference = options.pluginReference;
    contributions.pluginReferences = [
      { reference, isManagedReference: (entry) => entry === reference },
    ];
  }
  return contributions;
}

/** A capability declaring every contribution kind, each value carrying the owner's marker. */
export function markedCapability(
  owner: FixtureOwner,
  skillSourceDir: string,
  options: FixtureCapabilityOptions = {},
): CapabilityPlugin {
  return {
    id: fixturePluginId(owner),
    kind: "capability",
    label: owner,
    description: `${owner} fixture capability`,
    defaultSelected: true,
    isEnabled: () => true,
    apply: options.apply ?? (async () => {}),
    teardown: options.teardown ?? (async () => {}),
    ...(options.forProvider ? { forProvider: options.forProvider } : {}),
    getRuntimeContributions() {
      return {
        claude: contributionsFor(owner, skillSourceDir, "claude", options),
        opencode: contributionsFor(owner, skillSourceDir, "opencode", options),
      };
    },
  };
}

export function fixtureProvider(id: "claude" | "opencode"): ProviderPlugin {
  return {
    id,
    kind: "provider",
    label: id,
    description: id,
    defaultSelected: true,
    isEnabled: () => true,
    async apply() {},
    async teardown() {},
  };
}

export interface AudienceFixture {
  root: string;
  companionPath: string;
  repoPath: string;
  config: FrameworkConfig;
  skillSources: Record<FixtureOwner, string>;
  /** Providers, the base plugin, and both audiences' plugins, tagged with their source. */
  registrations(
    options?: Partial<Record<FixtureOwner, FixtureCapabilityOptions>>,
  ): PluginRegistration[];
  cleanup(): Promise<void>;
}

const FRAMEWORK_YAML = [
  "type: companion",
  "allowedAgents:",
  "  - claude",
  "  - opencode",
  "plugins:",
  '  - package: "@fixture/base"',
  '    version: "1.0.0"',
  "audiences:",
  "  ba:",
  "    plugins:",
  '      - package: "@fixture/ba"',
  '        version: "1.0.0"',
  "  qa:",
  "    plugins:",
  '      - package: "@fixture/qa"',
  '        version: "1.0.0"',
  "",
].join("\n");

export async function makeAudienceFixture(): Promise<AudienceFixture> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "audience-isolation-")));
  const companionPath = path.join(root, "companion");
  const repoPath = path.join(root, "repo");
  await fs.mkdir(path.join(companionPath, ".mate", "config"), { recursive: true });
  await fs.mkdir(repoPath, { recursive: true });
  await fs.writeFile(
    path.join(companionPath, ".mate", "config", "framework.yaml"),
    FRAMEWORK_YAML,
    "utf8",
  );

  const skillSources = {} as Record<FixtureOwner, string>;
  for (const owner of ["base", "ba", "qa"] as const) {
    const dir = path.join(root, "skill-sources", `${owner}-skill`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      `---\nname: ${owner}-skill\ndescription: ${owner} skill\n---\n${AUDIENCE_MARKERS[owner]} skill body.\n`,
      "utf8",
    );
    skillSources[owner] = dir;
  }

  const config: FrameworkConfig = {
    type: "companion",
    allowedAgents: ["claude", "opencode"],
    capabilities: [],
    plugins: [{ package: "@fixture/base", version: "1.0.0" }],
    audiences: {
      ba: { plugins: [{ package: "@fixture/ba", version: "1.0.0" }] },
      qa: { plugins: [{ package: "@fixture/qa", version: "1.0.0" }] },
    },
  } as FrameworkConfig;

  return {
    root,
    companionPath,
    repoPath,
    config,
    skillSources,
    registrations(options = {}) {
      return [
        { plugin: fixtureProvider("claude"), policy: "required" },
        { plugin: fixtureProvider("opencode"), policy: "required" },
        {
          plugin: markedCapability("base", skillSources.base, options.base),
          policy: "required",
          audience: null,
          packageName: fixturePackage("base"),
        },
        {
          plugin: markedCapability("ba", skillSources.ba, options.ba),
          policy: "optional",
          audience: "ba",
          packageName: fixturePackage("ba"),
        },
        {
          plugin: markedCapability("qa", skillSources.qa, options.qa),
          policy: "optional",
          audience: "qa",
          packageName: fixturePackage("qa"),
        },
      ];
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

/** Every regular file under `root` (symlinks followed), as relative path → text. Missing root: none. */
export async function readTree(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      if (stat.isDirectory()) await walk(full);
      else if (stat.isFile()) files.set(path.relative(root, full), await fs.readFile(full, "utf8"));
    }
  }
  await walk(root);
  return files;
}

/** `<where>: <marker>` for every marker of `owners` found in `text`. */
export function markerHits(where: string, text: string, owners: readonly FixtureOwner[]): string[] {
  return owners
    .filter((owner) => text.includes(AUDIENCE_MARKERS[owner]) || ownerIdentityIn(text, owner))
    .map((owner) => `${where}: ${owner}`);
}

/** Identities without the marker (MCP, skill, agent names) still count as the owner's. */
function ownerIdentityIn(text: string, owner: FixtureOwner): boolean {
  return [`${owner}-mcp`, `${owner}-skill`, `${owner}-agent`, `${owner}-plugin`].some((identity) =>
    text.includes(identity),
  );
}

/** The installed plugin packages: what a plugin is, not what a session loads. */
const PLUGIN_WORKSPACE = `${path.join(".mate", "plugins")}${path.sep}`;

/** Marker hits of `owners` in every file (path and content) under `root`, the plugin workspace aside. */
export async function markerHitsInTree(
  root: string,
  owners: readonly FixtureOwner[],
  skip: readonly string[] = [],
): Promise<string[]> {
  const hits: string[] = [];
  for (const [relative, text] of await readTree(root)) {
    if (relative.startsWith(PLUGIN_WORKSPACE)) continue;
    if (skip.some((prefix) => relative.startsWith(prefix))) continue;
    hits.push(...markerHits(relative, `${relative}\n${text}`, owners));
  }
  return hits;
}

/** Marker hits of `owners` in any JSON-serializable value: rendered documents, launch arguments. */
export function markerHitsInValue(
  where: string,
  value: unknown,
  owners: readonly FixtureOwner[],
): string[] {
  return markerHits(where, JSON.stringify(value), owners);
}

/**
 * Installs `owner`'s fixture plugin into the companion's plugin workspace, so
 * a pass can load it from its declaration alone. Declares exactly what
 * `markedCapability` declares, hook groups and all.
 */
export async function installFixturePackage(
  fixture: AudienceFixture,
  owner: FixtureOwner,
): Promise<void> {
  const name = fixturePackage(owner);
  const root = pluginPackageRoot(fixture.companionPath, name);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name, version: "1.0.0", type: "module", main: "index.js" }),
    "utf8",
  );
  const declared = markedCapability(owner, fixture.skillSources[owner]).getRuntimeContributions!(
    {} as never,
  );
  const source = `
const contributions = ${JSON.stringify(declared)};
export default function createPlugin() {
  return {
    id: ${JSON.stringify(fixturePluginId(owner))},
    kind: "capability",
    label: ${JSON.stringify(owner)},
    description: "installed fixture",
    defaultSelected: true,
    isEnabled: () => true,
    apply: async () => {},
    teardown: async () => {},
    getRuntimeContributions: () => contributions,
  };
}
`;
  await fs.writeFile(path.join(root, "index.js"), source, "utf8");
}
