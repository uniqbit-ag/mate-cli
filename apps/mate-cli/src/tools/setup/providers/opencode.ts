// oxlint-disable no-await-in-loop
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  hasGraphifyCapability,
  hasTokensaveCapability,
} from "../../../lib/orchestrator/capabilities";
import { getEffectiveCliTools } from "../../../lib/orchestrator/setup-compatibilities";
import { fileExists } from "../../../lib/fs-utils";
import {
  buildCodebaseExplorationGuidanceSection,
  buildCompanionGuidance,
} from "../../../playbooks/companion-guidance";
import type { Plugin, SetupContext } from "../plugin";
import { mergeDir, pruneEmptyAncestors } from "../utils";
import { getSetupProvidersRoot } from "./utils";

const LEGACY_PLUGIN_FILES = [
  "kizuna-companion.ts",
  "add-dir.ts",
  "companion.ts",
  "small-model.ts",
  "companion-policy.ts",
  "mate-small-model.ts",
];
const RUNTIME_MANIFEST_FILE = ".mate-runtime.json";
const GUIDANCE_FILE = ".mate-guidance.json";
const RUNTIME_MANIFEST_VERSION = 4;
const LEGACY_SESSION_BANNER_FILE = "plugins/mate-session-banner.ts";
const LEGACY_SESSION_BANNER_TSX_FILE = "plugins/mate-session-banner.tsx";
const TUI_PLUGIN_FILE = "plugins/mate-companion-tui.tsx";
const TUI_DEPENDENCIES = {
  "@opentui/core": "^0.3.4",
  "@opentui/keymap": "^0.3.4",
  "@opentui/solid": "^0.3.4",
};

interface RuntimeManifest {
  version: number;
  sourceHash: string;
  guidanceHash: string;
  fixedFiles: Record<string, string>;
  graphifyEnabled: boolean;
  tokensaveEnabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function listRelativeFiles(root: string, current = root): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const relativePaths: string[] = [];

  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      relativePaths.push(...(await listRelativeFiles(root, entryPath)));
      continue;
    }

    relativePaths.push(path.relative(root, entryPath));
  }

  return relativePaths;
}

async function hashFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function hashFiles(root: string, relativePaths: string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};

  for (const relativePath of relativePaths) {
    hashes[relativePath] = await hashFile(path.join(root, relativePath));
  }

  return hashes;
}

async function sourceRuntimeSnapshot(
  src: string,
): Promise<{ sourceHash: string; relativePaths: string[] }> {
  const relativePaths = (await listRelativeFiles(src)).filter(
    (relativePath) => relativePath !== "opencode.json",
  );
  const hash = crypto.createHash("sha256");

  for (const relativePath of relativePaths) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await fs.readFile(path.join(src, relativePath)));
    hash.update("\0");
  }

  return { sourceHash: hash.digest("hex"), relativePaths };
}

async function loadRuntimeManifest(dest: string): Promise<RuntimeManifest | undefined> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(dest, RUNTIME_MANIFEST_FILE), "utf8"),
    ) as unknown;
    if (!isRecord(parsed)) return undefined;
    if (parsed.version !== RUNTIME_MANIFEST_VERSION) return undefined;
    if (typeof parsed.sourceHash !== "string") return undefined;
    if (typeof parsed.guidanceHash !== "string") return undefined;
    if (!isRecord(parsed.fixedFiles)) return undefined;
    if (typeof parsed.graphifyEnabled !== "boolean") return undefined;
    if (typeof parsed.tokensaveEnabled !== "boolean") return undefined;

    return {
      version: RUNTIME_MANIFEST_VERSION,
      sourceHash: parsed.sourceHash,
      guidanceHash: parsed.guidanceHash,
      fixedFiles: Object.fromEntries(
        Object.entries(parsed.fixedFiles).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      graphifyEnabled: parsed.graphifyEnabled as boolean,
      tokensaveEnabled: parsed.tokensaveEnabled as boolean,
    };
  } catch {
    return undefined;
  }
}

async function canSkipOpenCodeRuntimeSync(
  src: string,
  dest: string,
  _cliTools: ReturnType<typeof getEffectiveCliTools>,
  graphifyEnabled: boolean,
  tokensaveEnabled: boolean,
): Promise<boolean> {
  const manifest = await loadRuntimeManifest(dest);
  if (!manifest) return false;

  const snapshot = await sourceRuntimeSnapshot(src);
  if (manifest.sourceHash !== snapshot.sourceHash) return false;
  const expectedGuidanceContent = buildOpenCodeGuidanceFileContent(
    graphifyEnabled,
    tokensaveEnabled,
  );
  const expectedGuidanceHash = crypto
    .createHash("sha256")
    .update(expectedGuidanceContent)
    .digest("hex");
  if (manifest.guidanceHash !== expectedGuidanceHash) return false;

  if (manifest.graphifyEnabled !== graphifyEnabled) return false;
  if (manifest.tokensaveEnabled !== tokensaveEnabled) return false;

  if (!(await fileExists(path.join(dest, "opencode.json")))) return false;

  for (const relativePath of Object.keys(manifest.fixedFiles)) {
    const absolutePath = path.join(dest, relativePath);
    if (!(await fileExists(absolutePath))) {
      return false;
    }
    if ((await hashFile(absolutePath)) !== manifest.fixedFiles[relativePath]) {
      return false;
    }
  }

  const guidancePath = path.join(dest, GUIDANCE_FILE);
  if (!(await fileExists(guidancePath))) return false;
  if ((await hashFile(guidancePath)) !== expectedGuidanceHash) return false;

  for (const file of LEGACY_PLUGIN_FILES) {
    if (await fileExists(path.join(dest, "plugins", file))) {
      return false;
    }
  }

  return true;
}

function mergeConfigDefaults(
  target: Record<string, unknown>,
  defaults: Record<string, unknown>,
): void {
  for (const [key, defaultValue] of Object.entries(defaults)) {
    const existingValue = target[key];

    if (Array.isArray(defaultValue)) {
      if (existingValue === undefined) {
        target[key] = [...defaultValue];
        continue;
      }

      if (Array.isArray(existingValue)) {
        for (const item of defaultValue) {
          if (!existingValue.includes(item)) {
            existingValue.push(item);
          }
        }
      }
      continue;
    }

    if (isRecord(defaultValue)) {
      if (existingValue === undefined) {
        target[key] = structuredClone(defaultValue);
        continue;
      }

      if (isRecord(existingValue)) {
        mergeConfigDefaults(existingValue, defaultValue);
      }
      continue;
    }

    if (existingValue === undefined) {
      target[key] = defaultValue;
    }
  }
}

async function syncOpenCodeConfigFile(srcPath: string, destPath: string): Promise<void> {
  const defaults = JSON.parse(await fs.readFile(srcPath, "utf8")) as Record<string, unknown>;

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(destPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return;
    }
  }

  mergeConfigDefaults(existing, defaults);
  await fs.writeFile(destPath, JSON.stringify(existing, null, 2) + "\n", "utf8");
}

async function syncOpenCodeTuiDependencies(dest: string): Promise<void> {
  const packagePath = path.join(dest, "package.json");
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(packagePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") return;
  }

  const dependencies = isRecord(existing.dependencies) ? existing.dependencies : {};
  mergeConfigDefaults(dependencies, TUI_DEPENDENCIES);
  existing.dependencies = dependencies;
  await fs.mkdir(dest, { recursive: true });
  await fs.writeFile(packagePath, JSON.stringify(existing, null, 2) + "\n", "utf8");
}

async function teardownOpenCodeTuiDependencies(dest: string): Promise<void> {
  const packagePath = path.join(dest, "package.json");
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(await fs.readFile(packagePath, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }

  const dependencies = isRecord(existing.dependencies) ? existing.dependencies : undefined;
  if (!dependencies) return;

  let changed = false;
  for (const [name, version] of Object.entries(TUI_DEPENDENCIES)) {
    if (dependencies[name] !== version && dependencies[name] !== version.slice(1)) continue;
    delete dependencies[name];
    changed = true;
  }
  if (!changed) return;

  if (Object.keys(dependencies).length === 0) {
    delete existing.dependencies;
  }
  if (Object.keys(existing).length === 0) {
    await fs.unlink(packagePath).catch(() => {});
    return;
  }
  await fs.writeFile(packagePath, JSON.stringify(existing, null, 2) + "\n", "utf8");
}

async function syncOpenCodeFixedRuntimeFiles(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });

  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "opencode.json" || entry.name === "tui.json") continue;

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await mergeDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }

  for (const file of LEGACY_PLUGIN_FILES) {
    try {
      await fs.unlink(path.join(dest, "plugins", file));
    } catch {
      // not present, nothing to do
    }
  }

  try {
    await fs.unlink(path.join(dest, LEGACY_SESSION_BANNER_FILE));
  } catch {
    // not present, nothing to do
  }
  try {
    await fs.unlink(path.join(dest, LEGACY_SESSION_BANNER_TSX_FILE));
  } catch {
    // not present, nothing to do
  }
}

async function configureOpenCodeCompanionPlugin(
  dest: string,
  graphifyEnabled: boolean,
  tokensaveEnabled: boolean,
): Promise<boolean> {
  const pluginPath = path.join(dest, "plugins", "mate-companion.ts");
  try {
    await fs.access(pluginPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  await fs.writeFile(
    path.join(dest, GUIDANCE_FILE),
    buildOpenCodeGuidanceFileContent(graphifyEnabled, tokensaveEnabled),
    "utf8",
  );

  return true;
}

function buildOpenCodeGuidanceFileContent(graphifyEnabled: boolean, tokensaveEnabled: boolean) {
  return (
    JSON.stringify(buildOpenCodeGuidanceFile(graphifyEnabled, tokensaveEnabled), null, 2) + "\n"
  );
}

function buildOpenCodeGuidanceFile(graphifyEnabled: boolean, tokensaveEnabled: boolean) {
  const companionGuidance = buildCompanionGuidance(
    {
      companionPath: "$MATE_ARTIFACT_PATH",
      repository: {
        id: "$MATE_REPO_ID",
        path: "$MATE_REPO_PATH",
        profile: "$MATE_REPO_PROFILE",
      },
      policy: { allowedAgents: [] },
      capabilities: [],
    },
    { wrapperBinPath: "$MATE_WRAPPER_BIN_PATH" },
  );
  const codebaseExplorationGuidance = buildCodebaseExplorationGuidanceSection({
    useGraphify: graphifyEnabled,
    useTokensave: tokensaveEnabled,
  });
  const errors: string[] = [];

  if (!companionGuidance.includes("<companion-policy ")) {
    errors.push("companion guidance was not injected");
  }
  if (
    (graphifyEnabled || tokensaveEnabled) &&
    !codebaseExplorationGuidance.includes("<codebase-exploration-rules ")
  ) {
    errors.push("codebase exploration guidance was not injected");
  }

  return {
    version: 1,
    companionGuidance,
    codebaseExplorationGuidance,
    errors,
  };
}

async function writeRuntimeManifest(
  src: string,
  dest: string,
  _cliTools: ReturnType<typeof getEffectiveCliTools>,
  graphifyEnabled: boolean,
  tokensaveEnabled: boolean,
): Promise<void> {
  const snapshot = await sourceRuntimeSnapshot(src);
  const guidanceContent = buildOpenCodeGuidanceFileContent(graphifyEnabled, tokensaveEnabled);
  const manifest: RuntimeManifest = {
    version: RUNTIME_MANIFEST_VERSION,
    sourceHash: snapshot.sourceHash,
    guidanceHash: crypto.createHash("sha256").update(guidanceContent).digest("hex"),
    fixedFiles: await hashFiles(dest, snapshot.relativePaths),
    graphifyEnabled,
    tokensaveEnabled,
  };

  await fs.writeFile(
    path.join(dest, RUNTIME_MANIFEST_FILE),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
}

async function syncOpenCodeRuntimeFiles(
  src: string,
  companionPath: string,
  cliTools: ReturnType<typeof getEffectiveCliTools>,
  mode: SetupContext["mode"],
  graphifyEnabled: boolean,
  tokensaveEnabled: boolean,
): Promise<void> {
  const dest = path.join(companionPath, ".opencode");
  await fs.mkdir(dest, { recursive: true });

  await syncOpenCodeConfigFile(path.join(src, "opencode.json"), path.join(dest, "opencode.json"));
  await syncOpenCodeConfigFile(path.join(src, "tui.json"), path.join(dest, "tui.json"));
  await syncOpenCodeTuiDependencies(dest);

  if (
    mode === "sync" &&
    (await canSkipOpenCodeRuntimeSync(src, dest, cliTools, graphifyEnabled, tokensaveEnabled))
  ) {
    return;
  }

  await syncOpenCodeFixedRuntimeFiles(src, dest);
  const configuredPlugin = await configureOpenCodeCompanionPlugin(
    dest,
    graphifyEnabled,
    tokensaveEnabled,
  );
  if (!configuredPlugin) {
    if (mode === "setup") {
      throw new Error(
        `OpenCode runtime source is incomplete: missing ${path.join(src, "plugins", "mate-companion.ts")}`,
      );
    }
    return;
  }
  await writeRuntimeManifest(src, dest, cliTools, graphifyEnabled, tokensaveEnabled);
}

async function teardownOpenCode(companionPath: string): Promise<void> {
  try {
    await fs.unlink(path.join(companionPath, ".opencode", RUNTIME_MANIFEST_FILE));
  } catch {
    /* not present */
  }
  try {
    await fs.unlink(path.join(companionPath, ".opencode", GUIDANCE_FILE));
  } catch {
    /* not present */
  }
  try {
    await fs.unlink(path.join(companionPath, ".opencode", "opencode.json"));
  } catch {
    /* not present */
  }
  try {
    await fs.unlink(path.join(companionPath, ".opencode", "plugins", "mate-add-dir.ts"));
  } catch {
    /* not present */
  }
  try {
    await fs.unlink(path.join(companionPath, ".opencode", "plugins", "mate-companion.ts"));
  } catch {
    /* not present */
  }
  try {
    await fs.unlink(path.join(companionPath, ".opencode", "plugins", "mate-companion-policy.ts"));
  } catch {
    /* not present */
  }
  try {
    await fs.unlink(path.join(companionPath, ".opencode", "plugins", "mate-companion-hooks.ts"));
  } catch {
    /* not present */
  }
  try {
    await fs.unlink(path.join(companionPath, ".opencode", "plugins", "mate-session-banner.ts"));
  } catch {
    /* not present */
  }
  try {
    await fs.unlink(path.join(companionPath, ".opencode", TUI_PLUGIN_FILE));
  } catch {
    /* not present */
  }
  try {
    await fs.unlink(path.join(companionPath, ".opencode", LEGACY_SESSION_BANNER_TSX_FILE));
  } catch {
    /* not present */
  }
  try {
    await fs.unlink(path.join(companionPath, ".opencode", "tui.json"));
  } catch {
    /* not present */
  }
  await teardownOpenCodeTuiDependencies(path.join(companionPath, ".opencode"));
  for (const file of LEGACY_PLUGIN_FILES) {
    try {
      await fs.unlink(path.join(companionPath, ".opencode", "plugins", file));
    } catch {
      /* not present */
    }
  }
  await pruneEmptyAncestors(path.join(companionPath, ".opencode", "plugins"), companionPath);
  await pruneEmptyAncestors(path.join(companionPath, ".opencode", "skills"), companionPath);
  await pruneEmptyAncestors(path.join(companionPath, ".opencode"), companionPath);
}

export const opencodePlugin: Plugin = {
  id: "opencode",
  kind: "provider",
  label: "OpenCode",
  description: "Install the OpenCode plugin workspace.",
  defaultSelected: false,
  isEnabled: (config) => (config.profiles.default?.allowedAgents ?? []).includes("opencode"),
  async apply(ctx: SetupContext) {
    await syncOpenCodeRuntimeFiles(
      path.join(getSetupProvidersRoot(), "opencode"),
      ctx.companionPath,
      getEffectiveCliTools(ctx.config),
      ctx.mode,
      hasGraphifyCapability(ctx.config.capabilities),
      hasTokensaveCapability(ctx.config.capabilities),
    );
  },
  async teardown(ctx: SetupContext) {
    await teardownOpenCode(ctx.companionPath);
  },
};
