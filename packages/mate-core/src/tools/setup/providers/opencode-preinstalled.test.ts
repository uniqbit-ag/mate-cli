import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  CONTEXT_MODE_PACKAGE_NAME,
  CONTEXT_MODE_VERSION,
  isContextModePackageReference,
} from "../../../lib/context-mode-package";
import {
  PREBUILT_BUNDLE_MARKER,
  getLocalWorkspaceDir,
  getPreinstalledPluginDir,
} from "../../../lib/preinstalled-plugins";
import type { CapabilityContributionInput, SetupContext } from "../plugin";
import { reconcileOpenCodeContributions } from "./opencode";

const tempRoots: string[] = [];

async function makeCompanion(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-preinstalled-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function makeCtx(companionPath: string): SetupContext {
  return {
    companionPath,
    config: { allowedAgents: ["opencode"], capabilities: [] },
    mode: "sync",
    activeProviders: ["opencode"],
  };
}

/** The declaration the context-mode Capability contributes for OpenCode. */
function contextModeContribution(enabled = true): CapabilityContributionInput {
  return {
    pluginId: "context-mode",
    enabled,
    contributions: {
      pluginReferences: [
        {
          reference: `${CONTEXT_MODE_PACKAGE_NAME}@${CONTEXT_MODE_VERSION}`,
          isManagedReference: isContextModePackageReference,
          configFiles: ["opencode.json", "tui.json"],
          preinstalled: {
            packageName: CONTEXT_MODE_PACKAGE_NAME,
            version: CONTEXT_MODE_VERSION,
          },
        },
      ],
    },
  };
}

async function installCopy(companionPath: string, version: string): Promise<string> {
  const dir = getPreinstalledPluginDir(companionPath, CONTEXT_MODE_PACKAGE_NAME);
  await fs.mkdir(dir, { recursive: true });
  await markSupplied(companionPath);
  await fs.writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: CONTEXT_MODE_PACKAGE_NAME, version }, null, 2)}\n`,
    "utf8",
  );
  return dir;
}

/** Preparation's marker: the only sign the distribution supplied this workspace. */
async function markSupplied(companionPath: string): Promise<void> {
  await fs.mkdir(getLocalWorkspaceDir(companionPath), { recursive: true });
  await fs.writeFile(
    path.join(getLocalWorkspaceDir(companionPath), PREBUILT_BUNDLE_MARKER),
    JSON.stringify({ fingerprint: "test" }),
    "utf8",
  );
}

async function readConfigs(companionPath: string): Promise<[unknown, unknown]> {
  const read = async (name: string) =>
    (
      JSON.parse(await fs.readFile(path.join(companionPath, ".opencode", name), "utf8")) as {
        plugin?: unknown;
      }
    ).plugin;
  return [await read("opencode.json"), await read("tui.json")];
}

describe("binding a declared plugin reference to a preinstalled package", () => {
  test("a supplied installed copy is bound to its installed files", async () => {
    const companionPath = await makeCompanion();
    const installed = await installCopy(companionPath, CONTEXT_MODE_VERSION);

    await reconcileOpenCodeContributions(makeCtx(companionPath), [contextModeContribution()]);

    const [opencode, tui] = await readConfigs(companionPath);
    expect(opencode).toEqual([installed]);
    expect(tui).toEqual([installed]);
  });

  test("without an installed copy, the published reference is written as before", async () => {
    const companionPath = await makeCompanion();

    await reconcileOpenCodeContributions(makeCtx(companionPath), [contextModeContribution()]);

    const [opencode, tui] = await readConfigs(companionPath);
    expect(opencode).toEqual([`${CONTEXT_MODE_PACKAGE_NAME}@${CONTEXT_MODE_VERSION}`]);
    expect(tui).toEqual([`${CONTEXT_MODE_PACKAGE_NAME}@${CONTEXT_MODE_VERSION}`]);
  });

  test("a package-manager cache entry is not a binding", async () => {
    const companionPath = await makeCompanion();
    /** Present in a download cache, absent from the local workspace. */
    const cacheDir = path.join(
      companionPath,
      ".cache",
      "opencode",
      "packages",
      `${CONTEXT_MODE_PACKAGE_NAME}@${CONTEXT_MODE_VERSION}`,
      "node_modules",
      CONTEXT_MODE_PACKAGE_NAME,
    );
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, "package.json"),
      JSON.stringify({ name: CONTEXT_MODE_PACKAGE_NAME, version: CONTEXT_MODE_VERSION }),
      "utf8",
    );

    await reconcileOpenCodeContributions(makeCtx(companionPath), [contextModeContribution()]);

    const [opencode] = await readConfigs(companionPath);
    expect(opencode).toEqual([`${CONTEXT_MODE_PACKAGE_NAME}@${CONTEXT_MODE_VERSION}`]);
  });

  test("a mismatched installed copy is named and refused rather than bound", async () => {
    const companionPath = await makeCompanion();
    await installCopy(companionPath, "0.0.1");

    const attempt = reconcileOpenCodeContributions(makeCtx(companionPath), [
      contextModeContribution(),
    ]);

    await expect(attempt).rejects.toThrow(CONTEXT_MODE_PACKAGE_NAME);
    await expect(attempt).rejects.toThrow("0.0.1");
    await expect(attempt).rejects.toThrow(CONTEXT_MODE_VERSION);
    await expect(
      fs.access(path.join(companionPath, ".opencode", "opencode.json")),
    ).rejects.toThrow();
  });

  test("binding is idempotent and changes no recorded selection", async () => {
    const companionPath = await makeCompanion();
    await fs.mkdir(path.join(companionPath, ".mate", "config"), { recursive: true });
    const configFile = path.join(companionPath, ".mate", "config", "framework.yaml");
    await fs.writeFile(
      configFile,
      "type: companion\ncapabilities:\n  - name: context-mode\n",
      "utf8",
    );
    await installCopy(companionPath, CONTEXT_MODE_VERSION);
    const ctx = makeCtx(companionPath);

    await reconcileOpenCodeContributions(ctx, [contextModeContribution()]);
    const first = await fs.readFile(path.join(companionPath, ".opencode", "opencode.json"), "utf8");
    const firstTui = await fs.readFile(path.join(companionPath, ".opencode", "tui.json"), "utf8");

    await reconcileOpenCodeContributions(ctx, [contextModeContribution()]);

    expect(await fs.readFile(path.join(companionPath, ".opencode", "opencode.json"), "utf8")).toBe(
      first,
    );
    expect(await fs.readFile(path.join(companionPath, ".opencode", "tui.json"), "utf8")).toBe(
      firstTui,
    );
    expect(await fs.readFile(configFile, "utf8")).toBe(
      "type: companion\ncapabilities:\n  - name: context-mode\n",
    );
  });

  test("unmanaged plugin entries in the runtime config are left untouched", async () => {
    const companionPath = await makeCompanion();
    const installed = await installCopy(companionPath, CONTEXT_MODE_VERSION);
    const configPath = path.join(companionPath, ".opencode", "opencode.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ plugin: ["user-plugin"], theme: "acme" }),
      "utf8",
    );

    await reconcileOpenCodeContributions(makeCtx(companionPath), [contextModeContribution()]);

    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(config.plugin).toEqual(["user-plugin", installed]);
    expect(config.theme).toBe("acme");
  });
});

describe("Mate's own OpenCode plugin binds the same way", () => {
  test("a supplied installed copy is bound; without one the published reference is written", async () => {
    const { createOpenCodePlugin } = await import("./opencode");
    const { OPENCODE_PLUGIN_PACKAGE_NAME } = await import("../../../lib/opencode-plugin-package");
    const { getCurrentVersion } = await import("../../../lib/update-checker");

    const withoutCopy = await makeCompanion();
    await createOpenCodePlugin().apply?.(makeCtx(withoutCopy));
    const published = JSON.parse(
      await fs.readFile(path.join(withoutCopy, ".opencode", "opencode.json"), "utf8"),
    ) as { plugin?: string[] };
    expect(published.plugin).toContain(`${OPENCODE_PLUGIN_PACKAGE_NAME}@${getCurrentVersion()}`);

    const withCopy = await makeCompanion();
    const installed = getPreinstalledPluginDir(withCopy, OPENCODE_PLUGIN_PACKAGE_NAME);
    await fs.mkdir(installed, { recursive: true });
    await markSupplied(withCopy);
    await fs.writeFile(
      path.join(installed, "package.json"),
      JSON.stringify({ name: OPENCODE_PLUGIN_PACKAGE_NAME, version: getCurrentVersion() }),
      "utf8",
    );

    await createOpenCodePlugin().apply?.(makeCtx(withCopy));

    const bound = JSON.parse(
      await fs.readFile(path.join(withCopy, ".opencode", "opencode.json"), "utf8"),
    ) as { plugin?: string[] };
    expect(bound.plugin).toContain(installed);
    expect(bound.plugin).not.toContain(`${OPENCODE_PLUGIN_PACKAGE_NAME}@${getCurrentVersion()}`);
  });
});
