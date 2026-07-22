import { describe, expect, test } from "bun:test";

import { defaultConfig } from "./config-store";
import {
  applyOpenSpecSchemaSelection,
  BUILTIN_SETUP_COMPATIBILITIES,
  getOpenSpecSchemaSelection,
  getCompatibilityCliTools,
  getEffectiveCliTools,
  getDefaultSetupSelections,
  getSetupSelectionsFromConfig,
  listSetupGitModeCompatibilities,
  listSetupOpenSpecSchemaCompatibilities,
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

  test("openspec schema compatibilities expose labeled options", () => {
    expect(listSetupOpenSpecSchemaCompatibilities()).toEqual([
      {
        id: "default",
        label: "Default (vanilla OpenSpec)",
        description: "Use OpenSpec's built-in spec-driven workflow.",
        defaultSelected: true,
      },
      {
        id: "mate-v1",
        label: "Mate v1",
        description: "Use Mate's schema with proposal, design, spec, and task artifacts.",
        defaultSelected: false,
      },
    ]);
  });

  test("openspec schema compatibilities append a custom entry when a non-builtin schema is active", () => {
    expect(listSetupOpenSpecSchemaCompatibilities("some-custom-schema")).toEqual([
      {
        id: "default",
        label: "Default (vanilla OpenSpec)",
        description: "Use OpenSpec's built-in spec-driven workflow.",
        defaultSelected: true,
      },
      {
        id: "mate-v1",
        label: "Mate v1",
        description: "Use Mate's schema with proposal, design, spec, and task artifacts.",
        defaultSelected: false,
      },
      {
        id: "some-custom-schema",
        label: "Custom",
        description:
          'Keep the project\'s current custom schema profile ("some-custom-schema"). Selecting Default or Mate v1 replaces it.',
        defaultSelected: false,
      },
    ]);
  });

  test("openspec schema compatibilities omit the custom entry when the active schema is builtin", () => {
    expect(listSetupOpenSpecSchemaCompatibilities("default")).toHaveLength(2);
    expect(listSetupOpenSpecSchemaCompatibilities("mate-v1")).toHaveLength(2);
    expect(listSetupOpenSpecSchemaCompatibilities()).toHaveLength(2);
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
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      packageManagers: ["bun"],
      capabilities: [{ name: "openspec" }],
    };

    expect(getEffectiveCliTools(config)).toEqual([
      { name: "openspec", redirectCwd: "companionRoot" },
    ]);
  });

  test("openspec schema selection defaults to default and preserves mate-v1 when present", () => {
    expect(getOpenSpecSchemaSelection([{ name: "openspec" }])).toBe("default");
    expect(getOpenSpecSchemaSelection([{ name: "openspec", schemaProfile: "mate-v1" }])).toBe(
      "mate-v1",
    );
  });

  test("applying openspec schema selection updates only the openspec capability", () => {
    expect(
      applyOpenSpecSchemaSelection([{ name: "openspec" }, { name: "react-doctor" }], "mate-v1"),
    ).toEqual([{ name: "openspec", schemaProfile: "mate-v1" }, { name: "react-doctor" }]);

    expect(
      applyOpenSpecSchemaSelection([{ name: "openspec", schemaProfile: "mate-v1" }], "default"),
    ).toEqual([{ name: "openspec" }]);
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
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        packageManagers: ["bun", "uv"],
        capabilities: [],
      }),
    ).toMatchObject({
      packageManagers: ["bun", "uv"],
      selectedOpenSpecSchema: "default",
      selectedGitMode: "default",
    });

    expect(
      getSetupSelectionsFromConfig({
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        git: "auto",
        capabilities: [{ name: "openspec", schemaProfile: "mate-v1" }],
      }),
    ).toMatchObject({
      packageManagers: ["bun", "uv"],
      selectedOpenSpecSchema: "mate-v1",
      selectedGitMode: "auto",
    });

    expect(getDefaultSetupSelections().selectedOpenSpecSchema).toBe("default");
    expect(getDefaultSetupSelections().selectedGitMode).toBe("default");
  });
});
