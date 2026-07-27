import { describe, expect, mock, spyOn, test } from "bun:test";

import type { SetupContext } from "../plugin";
import { createHeadroomPlugin } from "./headroom";

function makeCtx(companionPath: string): SetupContext {
  return {
    companionPath,
    activeProviders: [],
    mode: "setup",
    config: {
      profiles: { default: { name: "default", allowedAgents: [] } },
      capabilities: [{ name: "headroom" }],
    },
  };
}

describe("createHeadroomPlugin apply()", () => {
  test("skips install prompt when headroom binary is already on PATH", async () => {
    const confirmMock = mock(async (_: string) => false);
    const checkPathMock = mock((_command: string, _path: string) => true);

    const plugin = createHeadroomPlugin({
      confirm: confirmMock,
      isCommandOnPath: checkPathMock,
    });

    await plugin.apply(makeCtx("/tmp/companion"));

    expect(confirmMock).not.toHaveBeenCalled();
  });

  test("skips install prompt when headroom-ai is installed via uv tool (not on PATH)", async () => {
    const confirmMock = mock(async (_: string) => false);
    const checkPathMock = mock((_command: string, _path: string) => false);
    const checkUvToolMock = mock((pkg: string) => pkg === "headroom-ai");

    const plugin = createHeadroomPlugin({
      confirm: confirmMock,
      isCommandOnPath: checkPathMock,
      isInstalledViaUvTool: checkUvToolMock,
    });

    await plugin.apply(makeCtx("/tmp/companion"));

    expect(confirmMock).not.toHaveBeenCalled();
    expect(checkUvToolMock).toHaveBeenCalledWith("headroom-ai");
  });

  test("prompts uv tool install when headroom is missing", async () => {
    const confirmMock = mock(async (_: string) => false);
    const checkPathMock = mock((command: string, _path: string) => command !== "headroom");
    const checkUvToolMock = mock((_pkg: string) => false);

    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      const plugin = createHeadroomPlugin({
        confirm: confirmMock,
        isCommandOnPath: checkPathMock,
        isInstalledViaUvTool: checkUvToolMock,
      });

      await plugin.apply(makeCtx("/tmp/companion"));

      expect(stdoutSpy).toHaveBeenCalledWith(
        expect.stringContaining(`uv tool install --python ">=3.13" "headroom-ai[all]"`),
      );
      expect(confirmMock).toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  test("does not run install when user declines", async () => {
    const confirmMock = mock(async (_: string) => false);
    const checkPathMock = mock((command: string, _path: string) => command !== "headroom");
    const checkUvToolMock = mock((_pkg: string) => false);
    const runCommandMock = mock(async () => {});

    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      const plugin = createHeadroomPlugin({
        confirm: confirmMock,
        isCommandOnPath: checkPathMock,
        isInstalledViaUvTool: checkUvToolMock,
      });

      await plugin.apply(makeCtx("/tmp/companion"));

      expect(confirmMock).toHaveBeenCalled();
      expect(runCommandMock).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  test("skips install prompt in sync mode (e.g. during launch)", async () => {
    const confirmMock = mock(async (_: string) => false);
    const checkPathMock = mock((command: string, _path: string) => command !== "headroom");
    const checkUvToolMock = mock((_pkg: string) => false);

    const plugin = createHeadroomPlugin({
      confirm: confirmMock,
      isCommandOnPath: checkPathMock,
      isInstalledViaUvTool: checkUvToolMock,
    });

    await plugin.apply({ ...makeCtx("/tmp/companion"), mode: "sync" });

    expect(confirmMock).not.toHaveBeenCalled();
  });

  test("teardown is a no-op", async () => {
    const confirmMock = mock(async (_: string) => false);
    const plugin = createHeadroomPlugin({ confirm: confirmMock });

    await expect(plugin.teardown(makeCtx("/tmp/companion"))).resolves.toBeUndefined();
    expect(confirmMock).not.toHaveBeenCalled();
  });
});
