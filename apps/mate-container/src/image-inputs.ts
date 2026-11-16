import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

/** The container app's own root, so tests and build scripts agree on where the inputs live. */
export const CONTAINER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const IMAGE_INPUTS_FILE = path.join(CONTAINER_ROOT, "image-inputs.yaml");

export interface ImageTarget {
  platform: string;
  arch: string;
  node_arch: string;
}

export interface CheckedArtifact {
  file: string;
  sha256: string;
}

export interface ToolInput {
  detect: string;
  version: string;
  source: string;
  package?: string;
  from?: string;
  base_url?: string;
  index?: string;
  artifacts?: Record<string, CheckedArtifact>;
}

export interface ImageInputs {
  schema: number;
  targets: ImageTarget[];
  base_images: Record<string, { tag: string; digest: string } & Record<string, unknown>>;
  os_packages: { suite: string; packages: Record<string, string> };
  mate: { version: string; minimum_compatible: string; registry: string };
  opencode: {
    version: string;
    release_base_url: string;
    artifacts: Record<string, CheckedArtifact>;
  };
  claude: {
    version: string;
    release_base_url: string;
    artifacts: Record<string, CheckedArtifact>;
  };
  tools: Record<string, ToolInput>;
  locks: Record<string, { manifest: string; lockfile: string }>;
  prebuilt_workspace: {
    path: string;
    manifest_file: string;
    packages: Record<string, string>;
    compatibility: { platform: string; node_version: string };
  };
  runtime: {
    user: string;
    uid: number;
    group: string;
    gid: number;
    home: string;
    companions_dir: string;
  };
}

/** mate-core's tool manifest: the shared tool versions a member's computer uses too. */
export const TOOL_MANIFEST_FILE = path.join(
  CONTAINER_ROOT,
  "..",
  "..",
  "packages",
  "mate-core",
  "tool-manifest.yaml",
);

/** The image inputs with the manifest's image tools merged into `tools`; a tool in both files throws. */
export function readImageInputs(
  file: string = IMAGE_INPUTS_FILE,
  manifestFile: string = TOOL_MANIFEST_FILE,
): ImageInputs {
  const inputs = parse(fs.readFileSync(file, "utf8")) as ImageInputs;
  const manifest = parse(fs.readFileSync(manifestFile, "utf8")) as {
    tools: Record<string, ToolInput>;
  };
  for (const [name, tool] of Object.entries(manifest.tools)) {
    // mate-core's own npm dependencies; no image installs them.
    if (tool.source === "npm_dependency") continue;
    if (name in inputs.tools) {
      throw new Error(`${name} is listed in both ${file} and ${manifestFile}`);
    }
    inputs.tools[name] = tool;
  }
  return inputs;
}

/** Each global-tools lock dependency that differs from the version the inputs pin. */
export function globalToolsLockDrift(inputs: ImageInputs, root: string): string[] {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, inputs.locks.global_tools!.manifest), "utf8"),
  ) as { dependencies: Record<string, string> };
  const pinned: Record<string, string> = { "@uniqbit/mate": inputs.mate.version };
  for (const tool of Object.values(inputs.tools)) {
    if (tool.source === "npm_global" && tool.package) pinned[tool.package] = tool.version;
  }
  return Object.entries(pinned)
    .filter(([name, version]) => manifest.dependencies[name] !== version)
    .map(([name, version]) => `${name}: lock ${manifest.dependencies[name]}, inputs ${version}`);
}

/**
 * Every command name the installation gate can look for on `PATH`, and the
 * runtime package references the agent loads. The image carries all of them
 * because the gate is evaluated against the mounted companion's selections,
 * which the image has never seen.
 *
 * Kept as a literal rather than derived from the CLI: this is the list the
 * image is *asserted* against, so it has to fail when the CLI grows a
 * requirement the image was not told about.
 */
export const REQUIRED_TOOL_COMMANDS = [
  "bun",
  "uv",
  "graphify",
  "rtk",
  "tokensave",
  "context7-mcp",
] as const;

/** A version that could resolve to something other than itself on a rebuild. */
const MOVING_REFERENCE = /(\^|~|\*|\bx\b|latest|canary|main|master|HEAD|>=|<=|>|<)/i;

export function isMovingReference(value: string): boolean {
  // A canary *version* is exact (0.17.0-canary.3); a canary *tag* is not.
  if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(value)) return false;
  return MOVING_REFERENCE.test(value);
}
