import { PassThrough } from "node:stream";

import { describe, expect, test } from "bun:test";

import {
  buildWizardSteps,
  getDisabledCapabilityIds,
  getItemsForStep,
  getOpenSpecSchemaStepMessage,
  getSelectableItems,
  OPENSPEC_SCHEMA_SKIP_MESSAGE,
  parseSelectorInput,
  selectRadioItem,
  selectSetupCompatibilities,
  toggleSelectableItem,
} from "./setup-selector";

function createTtyInput(): NodeJS.ReadStream & PassThrough {
  const stdin = new PassThrough() as NodeJS.ReadStream & PassThrough;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

function createTtyOutput(): NodeJS.WriteStream & PassThrough {
  const stream = new PassThrough() as NodeJS.WriteStream & PassThrough;
  stream.isTTY = true;
  stream.columns = 80;
  stream.rows = 24;
  return stream;
}

function createInitialSelections(overrides: Partial<ReturnType<typeof getInitialSelections>> = {}) {
  return { ...getInitialSelections(), ...overrides };
}

function getInitialSelections() {
  return {
    allowedAgents: ["claude"],
    packageManagers: ["bun"],
    capabilities: [] as { name: string; schemaProfile?: string }[],
    selectedOpenSpecSchema: "default" as const,
    selectedGitMode: "default" as const,
  };
}

describe("required plugins in the wizard", () => {
  const distributionConfig = {
    name: "mate",
    legacyNames: [],
    runtime: "bun",
    supportedAdapters: ["claude"],
    version: "1.0.0",
  };

  function makeCapabilityPlugin(id: string) {
    return {
      id,
      kind: "capability" as const,
      label: id,
      description: `${id} capability`,
      defaultSelected: false,
      isEnabled: () => false,
      async apply() {},
      async teardown() {},
    };
  }

  async function withRequiredAcme<T>(run: () => T): Promise<T> {
    const { createMate } = await import("../create-mate");
    const { resetActiveDistribution } = await import("../distribution");
    createMate({
      config: distributionConfig,
      plugins: [{ plugin: makeCapabilityPlugin("acme-mcp"), policy: "required" }],
    });
    try {
      return run();
    } finally {
      resetActiveDistribution();
    }
  }

  test("required capability appears as a locked, explained wizard item", async () => {
    await withRequiredAcme(() => {
      const item = getSelectableItems().find((entry) => entry.id === "acme-mcp");
      expect(item?.kind).toBe("capability");
      expect(item?.required).toBe(true);
      expect(item?.description).toContain("Required by this distribution");
    });
  });

  test("toggle keys do not deselect a required capability", async () => {
    await withRequiredAcme(() => {
      const item = getSelectableItems().find((entry) => entry.id === "acme-mcp");
      const state = {
        selectedProviders: new Set<string>(),
        selectedPackageManagers: new Set<string>(),
        selectedCapabilities: new Set(["acme-mcp"]),
        selectedOpenSpecSchema: "default" as const,
        selectedGitMode: "default" as const,
      };
      const next = toggleSelectableItem(state, item!);
      expect(next.selectedCapabilities.has("acme-mcp")).toBe(true);
    });
  });

  test("capabilities step lists the distribution's extra capability", async () => {
    await withRequiredAcme(() => {
      const items = getItemsForStep("capabilities");
      expect(items.map((entry) => entry.id)).toContain("acme-mcp");
    });
  });
});

describe("parseSelectorInput", () => {
  test("maps arrow keys and toggle", () => {
    expect(parseSelectorInput("\u001b[A")).toBe("up");
    expect(parseSelectorInput("\u001b[B")).toBe("down");
    expect(parseSelectorInput(" ")).toBe("toggle");
  });

  test("maps left arrow to back", () => {
    expect(parseSelectorInput("\u001b[D")).toBe("back");
  });

  test("maps submit and cancel keys", () => {
    expect(parseSelectorInput("\r")).toBe("submit");
    expect(parseSelectorInput("\n")).toBe("submit");
    expect(parseSelectorInput("q")).toBe("cancel");
    expect(parseSelectorInput("\u001b")).toBe("cancel");
  });
});

describe("selectSetupCompatibilities", () => {
  test("requires a TTY for interactive selection", async () => {
    await expect(
      selectSetupCompatibilities({
        initialSelections: createInitialSelections(),
        stdin: { isTTY: false } as NodeJS.ReadStream,
        stdout: { isTTY: false } as NodeJS.WriteStream,
      }),
    ).rejects.toThrow("Interactive setup selection requires a TTY");
  });

  test("selectable items include package managers", () => {
    expect(getSelectableItems()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "packageManager", id: "bun", locked: true }),
        expect.objectContaining({ kind: "packageManager", id: "uv", locked: true }),
      ]),
    );
  });

  test("no capabilities are disabled regardless of package manager selection", () => {
    expect(getDisabledCapabilityIds(new Set(["bun"]))).toEqual(new Set());
    expect(getDisabledCapabilityIds(new Set(["bun", "uv"]))).toEqual(new Set());
  });

  test("locked bun toggle is a no-op and headroom can be selected without uv", () => {
    const items = getSelectableItems();
    const bun = items.find((item) => item.kind === "packageManager" && item.id === "bun");
    const headroom = items.find((item) => item.kind === "capability" && item.id === "headroom");

    const initialState = {
      selectedProviders: new Set<string>(["claude"]),
      selectedPackageManagers: new Set<string>(["bun"]),
      selectedCapabilities: new Set<string>(),
      selectedOpenSpecSchema: "default" as const,
      selectedGitMode: "default" as const,
    };

    const bunAttempt = toggleSelectableItem(initialState, bun!);
    expect(bunAttempt).toBe(initialState);

    const withHeadroom = toggleSelectableItem(initialState, headroom!);
    expect(withHeadroom.selectedCapabilities).toEqual(new Set(["headroom"]));
  });

  test("schema step items include a custom entry only when a non-builtin schema is active", () => {
    const withoutCustom = getItemsForStep("openspecSchema", "default");
    expect(withoutCustom.map((item) => item.id)).toEqual(["default", "mate-v1"]);

    const withCustom = getItemsForStep("openspecSchema", "some-custom-schema");
    expect(withCustom.map((item) => item.id)).toEqual(["default", "mate-v1", "some-custom-schema"]);
    expect(withCustom.find((item) => item.id === "some-custom-schema")).toMatchObject({
      kind: "openspecSchema",
      label: "Custom",
    });
  });

  test("git mode is a radio step with manual mode selected by default", () => {
    expect(getItemsForStep("gitMode").map((item) => item.id)).toEqual(["default", "auto"]);

    const state = {
      selectedProviders: new Set<string>(["claude"]),
      selectedPackageManagers: new Set<string>(["bun"]),
      selectedCapabilities: new Set<string>(),
      selectedOpenSpecSchema: "default" as const,
      selectedGitMode: "default" as const,
    };
    const auto = getItemsForStep("gitMode").find((item) => item.id === "auto");

    expect(auto).toBeDefined();
    expect(selectRadioItem(state, auto!).selectedGitMode).toBe("auto");
    expect(state.selectedGitMode).toBe("default");
  });

  test("package manager items never appear as navigable items in any wizard step", () => {
    for (const step of buildWizardSteps({ selectedCapabilities: new Set(["openspec"]) })) {
      const items = getItemsForStep(step);
      for (const item of items) {
        expect(item.kind).not.toBe("packageManager");
      }
    }
  });

  test("builds dynamic step arrays when openspec is selected", () => {
    expect(buildWizardSteps({ selectedCapabilities: new Set() })).toEqual([
      "providers",
      "capabilities",
      "gitMode",
    ]);
    expect(buildWizardSteps({ selectedCapabilities: new Set(["openspec"]) })).toEqual([
      "providers",
      "capabilities",
      "openspecSchema",
      "gitMode",
    ]);
    expect(
      buildWizardSteps({ selectedCapabilities: new Set(), lockOpenSpecSchemaStep: true }),
    ).toEqual(["providers", "capabilities", "openspecSchema", "gitMode"]);
  });

  test("navigates through the schema step and submits updated selections", async () => {
    const stdin = createTtyInput();
    const stdout = createTtyOutput();
    const stderr = createTtyOutput();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const selectionPromise = selectSetupCompatibilities({
      initialSelections: createInitialSelections({ capabilities: [{ name: "openspec" }] }),
      stdin,
      stdout,
      stderr,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    stdin.write("x");
    stdin.write("\u001b[B");
    stdin.write(" ");
    stdin.write("\r");

    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\u001b[B");
    stdin.write("\u001b[B");
    stdin.write("\u001b[B");
    stdin.write(" ");
    stdin.write("\r");

    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\r");

    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\r");

    await new Promise((resolve) => setTimeout(resolve, 30));

    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write(" ");
    stdin.write("\r");

    await expect(selectionPromise).resolves.toEqual({
      allowedAgents: ["claude", "opencode"],
      packageManagers: ["bun", "uv"],
      capabilities: [{ name: "openspec" }, { name: "headroom" }],
      selectedOpenSpecSchema: "default",
      selectedGitMode: "default",
    });

    expect(output).toContain("Agents");
    expect(output).toContain("Always installing: bun (node) · uv (python)");
  });

  test("headroom selection keeps the required package managers in the result", async () => {
    const stdin = createTtyInput();
    const stdout = createTtyOutput();
    const stderr = createTtyOutput();

    const selectionPromise = selectSetupCompatibilities({
      initialSelections: createInitialSelections(),
      stdin,
      stdout,
      stderr,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    stdin.write("\r");
    stdin.write("\u001b[B");
    stdin.write("\u001b[B");
    stdin.write("\u001b[B");
    stdin.write(" ");
    stdin.write("\r");
    stdin.write("\r");

    await expect(selectionPromise).resolves.toEqual({
      allowedAgents: ["claude"],
      packageManagers: ["bun", "uv"],
      capabilities: [{ name: "headroom" }],
      selectedOpenSpecSchema: "default",
      selectedGitMode: "default",
    });
  });

  test("returns null when the selector is cancelled", async () => {
    const stdin = createTtyInput();
    const stdout = createTtyOutput();
    const stderr = createTtyOutput();

    const selectionPromise = selectSetupCompatibilities({
      initialSelections: createInitialSelections(),
      stdin,
      stdout,
      stderr,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write("q");

    await expect(selectionPromise).resolves.toBeNull();
  });

  test("wraps upward navigation from the first item to the last item of the current step", async () => {
    const stdin = createTtyInput();
    const stdout = createTtyOutput();
    const stderr = createTtyOutput();

    const selectionPromise = selectSetupCompatibilities({
      initialSelections: createInitialSelections(),
      stdin,
      stdout,
      stderr,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    stdin.write("\u001b[A");
    stdin.write(" ");
    stdin.write("\r");
    stdin.write("\r");
    stdin.write("\r");

    await expect(selectionPromise).resolves.toEqual({
      allowedAgents: ["claude", "opencode"],
      packageManagers: ["bun", "uv"],
      capabilities: [],
      selectedOpenSpecSchema: "default",
      selectedGitMode: "default",
    });
  });

  test("Enter on the final step resolves with full selections", async () => {
    const stdin = createTtyInput();
    const stdout = createTtyOutput();
    const stderr = createTtyOutput();

    const selectionPromise = selectSetupCompatibilities({
      initialSelections: createInitialSelections({ capabilities: [{ name: "openspec" }] }),
      stdin,
      stdout,
      stderr,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    stdin.write("\r");
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\r");
    stdin.write("\r");
    stdin.write("\r");

    await expect(selectionPromise).resolves.toEqual({
      allowedAgents: ["claude"],
      packageManagers: ["bun", "uv"],
      capabilities: [{ name: "openspec" }],
      selectedOpenSpecSchema: "default",
      selectedGitMode: "default",
    });
  });

  test("radio selection updates only the selected openspec schema option", () => {
    const state = {
      selectedProviders: new Set<string>(["claude"]),
      selectedPackageManagers: new Set<string>(["bun"]),
      selectedCapabilities: new Set<string>(["openspec"]),
      selectedOpenSpecSchema: "default" as const,
      selectedGitMode: "default" as const,
    };

    expect(
      selectRadioItem(state, {
        kind: "openspecSchema",
        id: "mate-v1",
        label: "Mate v1",
        description: "desc",
      }).selectedOpenSpecSchema,
    ).toBe("mate-v1");
  });

  test("OpenSpec schema profile can be selected with Enter", async () => {
    const stdin = createTtyInput();
    const stdout = createTtyOutput();
    const stderr = createTtyOutput();

    const selectionPromise = selectSetupCompatibilities({
      initialSelections: createInitialSelections({ capabilities: [{ name: "openspec" }] }),
      stdin,
      stdout,
      stderr,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    stdin.write("\r");
    stdin.write("\r");
    stdin.write("\u001b[B");
    stdin.write("\r");
    stdin.write("\r");
    stdin.write("\r");
    stdin.write("\r");
    stdin.write("\r");
    stdin.write("\r");

    await expect(selectionPromise).resolves.toEqual({
      allowedAgents: ["claude"],
      packageManagers: ["bun", "uv"],
      capabilities: [{ name: "openspec", schemaProfile: "mate-v1" }],
      selectedOpenSpecSchema: "mate-v1",
      selectedGitMode: "default",
    });
  });

  test("preloaded OpenSpec schema profile is preserved on submit", async () => {
    const stdin = createTtyInput();
    const stdout = createTtyOutput();
    const stderr = createTtyOutput();

    const selectionPromise = selectSetupCompatibilities({
      initialSelections: createInitialSelections({
        capabilities: [{ name: "openspec", schemaProfile: "mate-v1" }],
        selectedOpenSpecSchema: "mate-v1",
        selectedGitMode: "default",
      }),
      stdin,
      stdout,
      stderr,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    stdin.write("\r");
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\r");

    await expect(selectionPromise).resolves.toEqual({
      allowedAgents: ["claude"],
      packageManagers: ["bun", "uv"],
      capabilities: [{ name: "openspec", schemaProfile: "mate-v1" }],
      selectedOpenSpecSchema: "mate-v1",
      selectedGitMode: "default",
    });
  });

  test("preloaded custom OpenSpec schema profile is preserved on submit", async () => {
    const stdin = createTtyInput();
    const stdout = createTtyOutput();
    const stderr = createTtyOutput();

    const selectionPromise = selectSetupCompatibilities({
      initialSelections: createInitialSelections({
        capabilities: [{ name: "openspec", schemaProfile: "custom-schema" }],
        selectedOpenSpecSchema: "custom-schema",
        selectedGitMode: "default",
      }),
      stdin,
      stdout,
      stderr,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    stdin.write("\r");
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\r");

    await expect(selectionPromise).resolves.toEqual({
      allowedAgents: ["claude"],
      packageManagers: ["bun", "uv"],
      capabilities: [{ name: "openspec", schemaProfile: "custom-schema" }],
      selectedOpenSpecSchema: "custom-schema",
      selectedGitMode: "default",
    });
  });

  test("selecting default overrides an active custom OpenSpec schema profile", async () => {
    const stdin = createTtyInput();
    const stdout = createTtyOutput();
    const stderr = createTtyOutput();

    const selectionPromise = selectSetupCompatibilities({
      initialSelections: createInitialSelections({
        capabilities: [{ name: "openspec", schemaProfile: "custom-schema" }],
        selectedOpenSpecSchema: "custom-schema",
        selectedGitMode: "default",
      }),
      stdin,
      stdout,
      stderr,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    stdin.write("\r");
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\u001b[A");
    stdin.write("\u001b[A");
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\r");

    await expect(selectionPromise).resolves.toEqual({
      allowedAgents: ["claude"],
      packageManagers: ["bun", "uv"],
      capabilities: [{ name: "openspec" }],
      selectedOpenSpecSchema: "default",
      selectedGitMode: "default",
    });
  });

  test("left arrow on step 1+ goes back to the previous step", async () => {
    const stdin = createTtyInput();
    const stdout = createTtyOutput();
    const stderr = createTtyOutput();

    const selectionPromise = selectSetupCompatibilities({
      initialSelections: createInitialSelections(),
      stdin,
      stdout,
      stderr,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    stdin.write("\r");
    stdin.write("\u001b[D");
    stdin.write(" ");
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\r");
    stdin.write("\r");
    stdin.write("\r");
    stdin.write("\r");

    await expect(selectionPromise).resolves.toEqual({
      allowedAgents: [],
      packageManagers: ["bun", "uv"],
      capabilities: [],
      selectedOpenSpecSchema: "default",
      selectedGitMode: "default",
    });
  });

  test("left arrow on step 0 is a no-op", async () => {
    const stdin = createTtyInput();
    const stdout = createTtyOutput();
    const stderr = createTtyOutput();

    const selectionPromise = selectSetupCompatibilities({
      initialSelections: createInitialSelections(),
      stdin,
      stdout,
      stderr,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    stdin.write("\u001b[D");
    stdin.write(" ");
    stdin.write("\r");
    stdin.write("\r");
    stdin.write("\r");

    await expect(selectionPromise).resolves.toEqual({
      allowedAgents: [],
      packageManagers: ["bun", "uv"],
      capabilities: [],
      selectedOpenSpecSchema: "default",
      selectedGitMode: "default",
    });
  });

  test("activeIndex resets to 0 on step advance and step back", async () => {
    const stdin = createTtyInput();
    const stdout = createTtyOutput();
    const stderr = createTtyOutput();

    const selectionPromise = selectSetupCompatibilities({
      initialSelections: createInitialSelections(),
      stdin,
      stdout,
      stderr,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    stdin.write("\u001b[B");
    stdin.write("\r");
    stdin.write(" ");
    stdin.write("\u001b[D");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write(" ");
    stdin.write("\r");
    stdin.write(" ");
    stdin.write("\r");
    stdin.write("\r");

    await expect(selectionPromise).resolves.toEqual({
      allowedAgents: [],
      packageManagers: ["bun", "uv"],
      capabilities: [],
      selectedOpenSpecSchema: "default",
      selectedGitMode: "default",
    });
  });

  test("returns the skip message when openspec is deselected after the schema step is locked", async () => {
    const stdin = createTtyInput();
    const stdout = createTtyOutput();
    const stderr = createTtyOutput();
    const selectionPromise = selectSetupCompatibilities({
      initialSelections: createInitialSelections({ capabilities: [{ name: "openspec" }] }),
      stdin,
      stdout,
      stderr,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    stdin.write("\r");
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\u001b[D");
    stdin.write(" ");
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\r");

    await expect(selectionPromise).resolves.toEqual({
      allowedAgents: ["claude"],
      packageManagers: ["bun", "uv"],
      capabilities: [],
      selectedOpenSpecSchema: "default",
      selectedGitMode: "default",
    });

    expect(getOpenSpecSchemaStepMessage("openspecSchema", new Set())).toBe(
      OPENSPEC_SCHEMA_SKIP_MESSAGE,
    );
  });
});
