import { describe, expect, test } from "bun:test";

import { defaultConfig } from "./config-store";
import {
  BUILTIN_SETUP_COMPATIBILITIES,
  getCompatibilityCliTools,
  getEffectiveCliTools,
  getDefaultSetupSelections,
  getSetupSelectionsFromConfig,
  keepCapabilitySettings,
  listSetupGitModeCompatibilities,
  listSetupPackageManagerCompatibilities,
  mergeCliTools,
} from "./setup-compatibilities";
import type { FrameworkConfig } from "./types";

describe("setup compatibilities", () => {
  test("default config includes the default provider and capabilities", () => {
    const config = defaultConfig();
    const selections = getSetupSelectionsFromConfig(config);

    expect(selections.allowedAgents).toEqual(["claude"]);
    expect(selections.packageManagers).toEqual(["bun", "uv"]);
    expect(selections.capabilities.map((entry) => entry.name)).toEqual([
      "openspec",
      "react-doctor",
    ]);
  });

  test("package manager compatibilities include locked bun and locked uv, both always installed", () => {
    expect(listSetupPackageManagerCompatibilities()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ packageManager: "bun", language: "node", locked: true }),
        expect.objectContaining({ packageManager: "uv", language: "python", locked: true }),
      ]),
    );
  });

  test("default selections include bun and uv package managers", () => {
    expect(getDefaultSetupSelections().packageManagers).toEqual(["bun", "uv"]);
  });

  test("lists RTK as an optional capability that is not selected by default", () => {
    expect(
      BUILTIN_SETUP_COMPATIBILITIES.filter(
        (entry) => entry.kind === "capability" && entry.id === "rtk",
      ),
    ).toEqual([
      expect.objectContaining({
        id: "rtk",
        capability: { name: "rtk" },
        defaultSelected: false,
      }),
    ]);
  });

  test("git mode compatibilities expose labeled options", () => {
    expect(listSetupGitModeCompatibilities()).toEqual([
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
    ]);
  });

  test("selected openspec contributes the default redirected cli tool", () => {
    const config: FrameworkConfig = {
      allowedAgents: ["claude"],
      packageManagers: ["bun"],
      capabilities: [{ name: "openspec" }],
    };

    expect(getEffectiveCliTools(config)).toEqual([
      { name: "openspec", redirectCwd: "companionRoot" },
    ]);
  });

  test("user cliTools override compatibility-provided wrappers by name", () => {
    expect(
      mergeCliTools(
        [{ name: "openspec", redirectCwd: "companionRoot" }],
        [{ name: "openspec", redirectCwd: false }],
      ),
    ).toEqual([{ name: "openspec", redirectCwd: false }]);
  });

  test("user cliTools append new tool names that are not in the defaults", () => {
    expect(
      mergeCliTools(
        [{ name: "openspec", redirectCwd: "companionRoot" }],
        [{ name: "custom-tool", redirectCwd: false }],
      ),
    ).toEqual([
      { name: "openspec", redirectCwd: "companionRoot" },
      { name: "custom-tool", redirectCwd: false },
    ]);
  });

  test("compatibility cli tools replace earlier entries when multiple capabilities provide the same tool", () => {
    BUILTIN_SETUP_COMPATIBILITIES.push(
      {
        id: "test-tool-one",
        kind: "capability",
        capability: { name: "test-tool-one" },
        label: "Test Tool One",
        description: "first",
        defaultSelected: false,
        cliTools: [{ name: "shared", redirectCwd: "companionRoot" }],
      },
      {
        id: "test-tool-two",
        kind: "capability",
        capability: { name: "test-tool-two" },
        label: "Test Tool Two",
        description: "second",
        defaultSelected: false,
        cliTools: [{ name: "shared", redirectCwd: false }],
      },
    );

    try {
      expect(
        getCompatibilityCliTools([{ name: "test-tool-one" }, { name: "test-tool-two" }]),
      ).toEqual([{ name: "shared", redirectCwd: false }]);
    } finally {
      BUILTIN_SETUP_COMPATIBILITIES.splice(-2, 2);
    }
  });

  test("selections read packageManagers from config and always include both locked package managers", () => {
    expect(
      getSetupSelectionsFromConfig({
        allowedAgents: ["claude"],
        packageManagers: ["bun", "uv"],
        capabilities: [],
      }),
    ).toMatchObject({
      packageManagers: ["bun", "uv"],
      selectedGitMode: "default",
    });

    expect(
      getSetupSelectionsFromConfig({
        allowedAgents: ["claude"],
        git: "auto",
        capabilities: [{ name: "openspec" }],
      }),
    ).toMatchObject({
      packageManagers: ["bun", "uv"],
      capabilities: [{ name: "openspec" }],
      selectedGitMode: "auto",
    });

    expect(getDefaultSetupSelections().selectedGitMode).toBe("default");
  });

  test("re-selected capabilities keep their saved settings", () => {
    expect(
      keepCapabilitySettings(
        [{ name: "openspec" }, { name: "rtk" }],
        [{ name: "openspec", protectedBranches: ["release/*"] }, { name: "graphify" }],
      ),
    ).toEqual([{ name: "openspec", protectedBranches: ["release/*"] }, { name: "rtk" }]);
  });

  test("a saved schemaProfile is dropped on re-selection", () => {
    const leftover = { name: "openspec", schemaProfile: "mate-v1" } as { name: string };
    expect(keepCapabilitySettings([{ name: "openspec" }], [leftover])).toEqual([
      { name: "openspec" },
    ]);
  });
});
