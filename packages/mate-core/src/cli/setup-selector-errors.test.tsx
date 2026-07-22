import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createTtyInput, createTtyOutput } from "../../test/helpers";

type RenderResult = {
  rerender: (tree: unknown) => void;
  unmount: () => void;
  waitUntilExit: () => Promise<unknown>;
};

let renderImpl: (tree: unknown, options: unknown) => RenderResult;
const { selectSetupCompatibilities, setupSelectorDeps } = await import("./setup-selector");
const originalRender = setupSelectorDeps.render;

beforeEach(() => {
  renderImpl = () => ({
    rerender: () => {},
    unmount: () => {},
    waitUntilExit: async () => undefined,
  });
  setupSelectorDeps.render = (tree, options) => renderImpl(tree, options) as never;
});

afterEach(() => {
  setupSelectorDeps.render = originalRender;
});

describe("selectSetupCompatibilities error handling", () => {
  test("rejects when Ink render throws during startup", async () => {
    renderImpl = () => {
      throw new Error("render failed");
    };

    await expect(
      selectSetupCompatibilities({
        initialSelections: {
          allowedAgents: ["claude"],
          packageManagers: ["bun"],
          capabilities: [],
          selectedOpenSpecSchema: "default",
          selectedGitMode: "default",
        },
        stdin: createTtyInput(),
        stdout: createTtyOutput(),
        stderr: createTtyOutput(),
      }),
    ).rejects.toThrow("render failed");
  });

  test("rejects when Ink exits before a selection is made", async () => {
    await expect(
      selectSetupCompatibilities({
        initialSelections: {
          allowedAgents: ["claude"],
          packageManagers: ["bun"],
          capabilities: [],
          selectedOpenSpecSchema: "default",
          selectedGitMode: "default",
        },
        stdin: createTtyInput(),
        stdout: createTtyOutput(),
        stderr: createTtyOutput(),
      }),
    ).rejects.toThrow(
      "Interactive setup selector exited unexpectedly before a selection was made.",
    );
  });

  test("rejects with Ink errors surfaced from waitUntilExit", async () => {
    renderImpl = () => ({
      rerender: () => {},
      unmount: () => {},
      waitUntilExit: async () => {
        throw new Error("ink exploded");
      },
    });

    await expect(
      selectSetupCompatibilities({
        initialSelections: {
          allowedAgents: ["claude"],
          packageManagers: ["bun"],
          capabilities: [],
          selectedOpenSpecSchema: "default",
          selectedGitMode: "default",
        },
        stdin: createTtyInput(),
        stdout: createTtyOutput(),
        stderr: createTtyOutput(),
      }),
    ).rejects.toThrow("ink exploded");
  });
});
