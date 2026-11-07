import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  test("setup does not offer the installer to a member who declined RTK", async () => {
    const confirmMock = mock(async () => true);
    const runInstall = mock(async (_cmd: string) => {});
    const plugin = createRtkPlugin({
      confirm: confirmMock,
      isRtkOnPath: () => false,
      isBrewAvailable: () => true,
      runRtkInstallCmd: runInstall,
      readMemberChoices: async () => ({ rtk: "declined" }),
    });

    await plugin.apply(makeCtx());

    expect(confirmMock).not.toHaveBeenCalled();
    expect(runInstall).not.toHaveBeenCalled();
  });

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

describe("RTK upgrade", () => {
  const home = "/home/acme";

  async function upgrade(deps: Parameters<typeof createRtkPlugin>[0]): Promise<string[]> {
    const ran: string[] = [];
    const [requirement] = createRtkPlugin({
      isBrewAvailable: () => false,
      homeDir: () => home,
      runRtkCommandSilently: async (cmd) => {
        ran.push(cmd);
      },
      ...deps,
    }).getInstallRequirements!(makeCtx().config);
    await requirement!.update!();
    return ran;
  }

  const local = `${home}/.local/bin/rtk`;

  test("upgrades the Homebrew formula the rtk on PATH comes from", async () => {
    expect(
      await upgrade({ rtkBinaryPath: () => "/opt/homebrew/bin/rtk", brewFormulaOf: () => "rtk" }),
    ).toEqual(["brew upgrade rtk"]);
    expect(
      await upgrade({
        rtkBinaryPath: () => "/opt/homebrew/bin/rtk",
        brewFormulaOf: () => "rtk-ai/tap/rtk",
      }),
    ).toEqual(["brew upgrade rtk-ai/tap/rtk"]);
  });

  test("reads the formula from the keg's install receipt", async () => {
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "acme-brew-"));
    try {
      const keg = path.join(prefix, "Cellar", "rtk", "1.1.0");
      fs.mkdirSync(path.join(keg, "bin"), { recursive: true });
      fs.writeFileSync(path.join(keg, "bin", "rtk"), "");
      fs.mkdirSync(path.join(prefix, "bin"));
      fs.symlinkSync(path.join(keg, "bin", "rtk"), path.join(prefix, "bin", "rtk"));
      const binary = () => path.join(prefix, "bin", "rtk");
      expect(await upgrade({ rtkBinaryPath: binary })).toEqual(["brew upgrade rtk"]);
      const receipt = { source: { tap: "rtk-ai/tap" } };
      fs.writeFileSync(path.join(keg, "INSTALL_RECEIPT.json"), JSON.stringify(receipt));
      expect(await upgrade({ rtkBinaryPath: binary })).toEqual(["brew upgrade rtk-ai/tap/rtk"]);
    } finally {
      fs.rmSync(prefix, { recursive: true, force: true });
    }
  });

  test("runs the installer of a newer release, pinned to its tag, for ~/.local/bin/rtk", async () => {
    expect(
      await upgrade({
        rtkBinaryPath: () => local,
        brewFormulaOf: () => null,
        latestRtkTag: async () => "v1.2.0",
        installedRtkVersion: () => "1.1.0",
      }),
    ).toEqual([
      "curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/v1.2.0/install.sh | RTK_VERSION=v1.2.0 sh",
    ]);
  });

  test("runs nothing when ~/.local/bin/rtk is current or the latest release is unknown", async () => {
    const current = {
      rtkBinaryPath: () => local,
      brewFormulaOf: () => null,
      installedRtkVersion: () => "1.1.0",
    };
    expect(await upgrade({ ...current, latestRtkTag: async () => "v1.1.0" })).toEqual([]);
    expect(await upgrade({ ...current, latestRtkTag: async () => null })).toEqual([]);
  });

  test("leaves any other installation alone", async () => {
    const latestRtkTag = async () => "v9.9.9";
    expect(
      await upgrade({
        rtkBinaryPath: () => `${home}/.cargo/bin/rtk`,
        brewFormulaOf: () => null,
        latestRtkTag,
      }),
    ).toEqual([]);
    expect(await upgrade({ rtkBinaryPath: () => null, latestRtkTag })).toEqual([]);
  });

  test("a failed upgrade warns and never throws", async () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await upgrade({
        rtkBinaryPath: () => "/opt/homebrew/bin/rtk",
        brewFormulaOf: () => "rtk",
        runRtkCommandSilently: async () => {
          throw new Error("Command failed: brew upgrade rtk (exit 1)");
        },
      });
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining("rtk: automatic upgrade failed: Command failed: brew upgrade rtk"),
      );
    } finally {
      stderr.mockRestore();
    }
  });
});
