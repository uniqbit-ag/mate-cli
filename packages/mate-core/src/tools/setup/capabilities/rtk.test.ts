import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import type { SetupContext } from "../plugin";
import { createRtkPlugin } from "./rtk";

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

function makeCtx(mode: "setup" | "sync" = "setup"): SetupContext {
  return {
    companionPath: "/tmp/companion",
    activeProviders: [],
    mode,
    config: {
      allowedAgents: [],
      capabilities: [{ name: "rtk" }],
    },
  };
}

describe("createRtkPlugin", () => {
  test("prompts the Homebrew installer when RTK is missing", async () => {
    const confirmMock = mock(async () => false);
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const plugin = createRtkPlugin({
        confirm: confirmMock,
        isRtkOnPath: () => false,
        isBrewAvailable: () => true,
      });

      await plugin.apply(makeCtx());

      expect(stdoutSpy).toHaveBeenCalledWith(
        expect.stringContaining("brew install rtk-ai/tap/rtk"),
      );
      expect(confirmMock).toHaveBeenCalledTimes(1);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  test("uses the fallback installer without Homebrew", async () => {
    const confirmMock = mock(async () => false);
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const plugin = createRtkPlugin({
        confirm: confirmMock,
        isRtkOnPath: () => false,
        isBrewAvailable: () => false,
      });

      await plugin.apply(makeCtx());

      expect(stdoutSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh",
        ),
      );
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  test("does not prompt during sync when RTK is missing", async () => {
    const confirmMock = mock(async () => false);
    const plugin = createRtkPlugin({ confirm: confirmMock, isRtkOnPath: () => false });

    await plugin.apply(makeCtx("sync"));

    expect(confirmMock).not.toHaveBeenCalled();
  });

  const providers = ["claude", "opencode"] as const;
  for (const provider of providers) {
    test(`${provider} setup initializes RTK`, async () => {
      const runRtkMock = mock(async () => {});
      const plugin = createRtkPlugin({ isRtkOnPath: () => true, runRtkInstallCmd: runRtkMock });

      await plugin.forProvider![provider].apply({ ...makeCtx(), activeProviders: [provider] });

      expect(runRtkMock).toHaveBeenCalledWith(
        provider === "claude" ? "rtk init -g --auto-patch" : "rtk init -g --opencode --auto-patch",
      );
    });

    test(`${provider} sync initializes RTK silently`, async () => {
      const runInstallMock = mock(async () => {});
      const runSilentMock = mock(async () => {});
      const plugin = createRtkPlugin({
        isRtkOnPath: () => true,
        runRtkInstallCmd: runInstallMock,
        runRtkCommandSilently: runSilentMock,
      });

      await plugin.forProvider![provider].apply({
        ...makeCtx("sync"),
        activeProviders: [provider],
      });

      expect(runSilentMock).toHaveBeenCalledWith(
        provider === "claude" ? "rtk init -g --auto-patch" : "rtk init -g --opencode --auto-patch",
      );
      expect(runInstallMock).not.toHaveBeenCalled();
    });

    test(`${provider} teardown uninstalls only when no other provider is active`, async () => {
      const runRtkMock = mock(async () => {});
      const plugin = createRtkPlugin({ isRtkOnPath: () => true, runRtkInstallCmd: runRtkMock });

      await plugin.forProvider![provider].teardown({
        ...makeCtx(),
        activeProviders: [],
      });
      expect(runRtkMock).toHaveBeenCalledWith(
        provider === "claude" ? "rtk init -g --uninstall" : "rtk init -g --uninstall --opencode",
      );

      runRtkMock.mockClear();
      await plugin.forProvider![provider].teardown({
        ...makeCtx(),
        activeProviders: [provider === "claude" ? "opencode" : "claude"],
      });
      expect(runRtkMock).not.toHaveBeenCalled();
    });
  }
});
