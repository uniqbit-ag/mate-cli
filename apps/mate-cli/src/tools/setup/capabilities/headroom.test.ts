import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import type { SetupContext } from "../plugin";
import { createHeadroomPlugin } from "./headroom";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

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
      isRtkOnPath: () => true,
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
      isRtkOnPath: () => true,
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
        isRtkOnPath: () => false,
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
        isRtkOnPath: () => false,
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
      isRtkOnPath: () => false,
    });

    await plugin.apply({ ...makeCtx("/tmp/companion"), mode: "sync" });

    expect(confirmMock).not.toHaveBeenCalled();
  });

  test("teardown is a no-op", async () => {
    const confirmMock = mock(async (_: string) => false);
    const plugin = createHeadroomPlugin({ confirm: confirmMock, isRtkOnPath: () => false });

    await expect(plugin.teardown(makeCtx("/tmp/companion"))).resolves.toBeUndefined();
    expect(confirmMock).not.toHaveBeenCalled();
  });
});

describe("RTK install in apply()", () => {
  test("prompts RTK install when RTK is missing (brew available)", async () => {
    const confirmMock = mock(async (_: string) => false);
    const checkPathMock = mock((_command: string, _path: string) => true);

    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      const plugin = createHeadroomPlugin({
        confirm: confirmMock,
        isCommandOnPath: checkPathMock,
        isInstalledViaUvTool: () => false,
        isRtkOnPath: () => false,
        isBrewAvailable: () => true,
      });

      await plugin.apply(makeCtx("/tmp/companion"));

      expect(stdoutSpy).toHaveBeenCalledWith(
        expect.stringContaining("brew install rtk-ai/tap/rtk"),
      );
      expect(confirmMock).toHaveBeenCalledTimes(1);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  test("falls back to curl installer when brew is not available", async () => {
    const confirmMock = mock(async (_: string) => false);
    const checkPathMock = mock((_command: string, _path: string) => true);

    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      const plugin = createHeadroomPlugin({
        confirm: confirmMock,
        isCommandOnPath: checkPathMock,
        isInstalledViaUvTool: () => false,
        isRtkOnPath: () => false,
        isBrewAvailable: () => false,
      });

      await plugin.apply(makeCtx("/tmp/companion"));

      expect(stdoutSpy).toHaveBeenCalledWith(
        expect.stringContaining("curl -fsSL https://rtk.ai/install | bash"),
      );
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  test("runs RTK install command when user confirms", async () => {
    const confirmMock = mock(async (_: string) => true);
    const runRtkMock = mock(async () => {});
    const checkPathMock = mock((_command: string, _path: string) => true);

    const plugin = createHeadroomPlugin({
      confirm: confirmMock,
      isCommandOnPath: checkPathMock,
      isInstalledViaUvTool: () => false,
      isRtkOnPath: () => false,
      isBrewAvailable: () => true,
      runRtkInstallCmd: runRtkMock,
    });

    await plugin.apply(makeCtx("/tmp/companion"));

    expect(runRtkMock).toHaveBeenCalledWith("brew install rtk-ai/tap/rtk");
  });

  test("skips RTK install prompt in sync mode", async () => {
    const confirmMock = mock(async (_: string) => false);
    const checkPathMock = mock((_command: string, _path: string) => true);

    const plugin = createHeadroomPlugin({
      confirm: confirmMock,
      isCommandOnPath: checkPathMock,
      isInstalledViaUvTool: () => false,
      isRtkOnPath: () => false,
      isBrewAvailable: () => true,
    });

    await plugin.apply({ ...makeCtx("/tmp/companion"), mode: "sync" });

    expect(confirmMock).not.toHaveBeenCalled();
  });

  test("skips RTK install prompt when RTK already on PATH", async () => {
    const confirmMock = mock(async (_: string) => false);
    const checkPathMock = mock((_command: string, _path: string) => true);

    const plugin = createHeadroomPlugin({
      confirm: confirmMock,
      isCommandOnPath: checkPathMock,
      isInstalledViaUvTool: () => false,
      isRtkOnPath: () => true,
    });

    await plugin.apply(makeCtx("/tmp/companion"));

    expect(confirmMock).not.toHaveBeenCalled();
  });
});

describe("RTK provider init/uninstall in forProvider", () => {
  const providers = ["claude", "opencode"] as const;

  for (const provider of providers) {
    test(`${provider}: apply runs RTK init when RTK is on PATH and mode is setup`, async () => {
      const companionDir = await fs.mkdtemp(path.join(os.tmpdir(), `mate-rtk-${provider}-`));
      tempRoots.push(companionDir);

      const runRtkMock = mock(async () => {});
      const plugin = createHeadroomPlugin({
        isCommandOnPath: () => true,
        isInstalledViaUvTool: () => false,
        isRtkOnPath: () => true,
        runRtkInstallCmd: runRtkMock,
      });

      const ctx = { ...makeCtx(companionDir), activeProviders: [provider] };
      await plugin.forProvider![provider].apply(ctx);

      const expectedCmd =
        provider === "claude"
          ? "rtk init -g --auto-patch"
          : `rtk init -g --${provider} --auto-patch`;
      expect(runRtkMock).toHaveBeenCalledWith(expectedCmd);
    });

    test(`${provider}: apply runs RTK init silently during sync mode`, async () => {
      const runRtkMock = mock(async () => {});
      const plugin = createHeadroomPlugin({
        isCommandOnPath: () => true,
        isInstalledViaUvTool: () => false,
        isRtkOnPath: () => true,
        runRtkInstallCmd: runRtkMock,
      });

      const ctx = { ...makeCtx("/tmp/companion"), mode: "sync", activeProviders: [provider] };
      await plugin.forProvider![provider].apply(ctx);

      const expectedCmd =
        provider === "claude"
          ? "rtk init -g --auto-patch"
          : `rtk init -g --${provider} --auto-patch`;
      expect(runRtkMock).toHaveBeenCalledWith(expectedCmd);
    });

    test(`${provider}: apply skips RTK init when RTK not on PATH`, async () => {
      const runRtkMock = mock(async () => {});
      const plugin = createHeadroomPlugin({
        isCommandOnPath: () => true,
        isInstalledViaUvTool: () => false,
        isRtkOnPath: () => false,
        runRtkInstallCmd: runRtkMock,
      });

      await plugin.forProvider![provider].apply(makeCtx("/tmp/companion"));
      expect(runRtkMock).not.toHaveBeenCalled();
    });

    test(`${provider}: teardown runs RTK uninstall when RTK is on PATH`, async () => {
      const runRtkMock = mock(async () => {});
      const plugin = createHeadroomPlugin({
        isCommandOnPath: () => true,
        isInstalledViaUvTool: () => false,
        isRtkOnPath: () => true,
        runRtkInstallCmd: runRtkMock,
      });

      await plugin.forProvider![provider].teardown(makeCtx("/tmp/companion"));

      const expectedCmd =
        provider === "claude" ? "rtk init -g --uninstall" : `rtk init -g --uninstall --${provider}`;
      expect(runRtkMock).toHaveBeenCalledWith(expectedCmd);
    });

    test(`${provider}: teardown skips RTK uninstall when RTK not on PATH`, async () => {
      const runRtkMock = mock(async () => {});
      const plugin = createHeadroomPlugin({
        isCommandOnPath: () => true,
        isInstalledViaUvTool: () => false,
        isRtkOnPath: () => false,
        runRtkInstallCmd: runRtkMock,
      });

      await plugin.forProvider![provider].teardown(makeCtx("/tmp/companion"));
      expect(runRtkMock).not.toHaveBeenCalled();
    });

    test(`${provider}: teardown skips RTK uninstall when another active provider needs RTK`, async () => {
      const runRtkMock = mock(async () => {});
      const plugin = createHeadroomPlugin({
        isCommandOnPath: () => true,
        isInstalledViaUvTool: () => false,
        isRtkOnPath: () => true,
        runRtkInstallCmd: runRtkMock,
      });

      // Simulate: this provider is being torn down but another active provider
      // still needs RTK, so uninstall must be skipped to avoid breaking it.
      const otherProvider =
        provider === "claude" ? "opencode" : provider === "opencode" ? "claude" : "claude";
      const ctx = { ...makeCtx("/tmp/companion"), activeProviders: [otherProvider] };
      await plugin.forProvider![provider].teardown(ctx);
      expect(runRtkMock).not.toHaveBeenCalled();
    });
  }
});
