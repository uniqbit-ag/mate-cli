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
      runRtkInstallCmd: runInstall,
      readMemberChoices: async () => ({ rtk: "declined" }),
    });

    await plugin.apply(makeCtx());

    expect(confirmMock).not.toHaveBeenCalled();
    expect(runInstall).not.toHaveBeenCalled();
  });

  test("prompts the pinned installer when RTK is missing", async () => {
    const confirmMock = mock(async () => false);
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const plugin = createRtkPlugin({
        confirm: confirmMock,
        isRtkOnPath: () => false,
      });

      await plugin.apply(makeCtx());

      expect(stdoutSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/v1.1.0/install.sh | RTK_VERSION=v1.1.0 sh",
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

    describe(`${provider} teardown`, () => {
      const other = provider === "claude" ? "opencode" : "claude";
      const uninstall =
        provider === "claude" ? "rtk init -g --uninstall" : "rtk init -g --uninstall --opencode";
      const withRtk = { allowedAgents: [], capabilities: [{ name: "rtk" }] };
      const withoutRtk = { allowedAgents: [], capabilities: [] };

      async function teardownCommands(ctx: Partial<SetupContext>): Promise<string[]> {
        const ran: string[] = [];
        const plugin = createRtkPlugin({
          isRtkOnPath: () => true,
          runRtkInstallCmd: async (cmd) => {
            ran.push(cmd);
          },
        });
        await plugin.forProvider![provider].teardown({ ...makeCtx(), ...ctx });
        return ran;
      }

      test("leaves the integration alone without an earlier selection", async () => {
        expect(await teardownCommands({})).toEqual([]);
      });

      test("leaves the integration alone when the provider did not use RTK before", async () => {
        const unselected = { config: withoutRtk, activeProviders: [provider] };
        expect(await teardownCommands({ config: withoutRtk, previousSetup: unselected })).toEqual(
          [],
        );
        const inactive = { config: withRtk, activeProviders: [other] };
        expect(await teardownCommands({ previousSetup: inactive })).toEqual([]);
      });

      test("uninstalls when the provider leaves RTK use", async () => {
        const previousSetup = { config: withRtk, activeProviders: [provider] };
        expect(await teardownCommands({ previousSetup })).toEqual([uninstall]);
      });

      test("keeps the integration while another provider stays active for RTK", async () => {
        const previousSetup = { config: withRtk, activeProviders: [provider, other] };
        expect(await teardownCommands({ previousSetup, activeProviders: [other] })).toEqual([]);
      });

      test("uninstalls when RTK is deselected with both providers active", async () => {
        const activeProviders = [provider, other];
        const previousSetup = { config: withRtk, activeProviders };
        expect(
          await teardownCommands({ config: withoutRtk, activeProviders, previousSetup }),
        ).toEqual([uninstall]);
      });
    });
  }
});

describe("RTK install requirement", () => {
  test("verifies a fresh install in the installer's directory when PATH lacks it", async () => {
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "mate-rtk-"));
    process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), "mate-empty-path-"));
    const [requirement] = createRtkPlugin({
      installDir,
      runRtkInstallCmd: async () => {
        fs.writeFileSync(path.join(installDir, "rtk"), "#!/bin/sh\n", { mode: 0o755 });
      },
    }).getInstallRequirements!({ config: {} });

    expect(await requirement!.detect()).toBe(false);
    await requirement!.install();
    expect(await requirement!.verify!()).toBe(true);
    expect(process.env.PATH!.split(path.delimiter)[0]).toBe(installDir);
  });
});

describe("RTK version check", () => {
  test.each([
    ["1.1.0", false],
    ["1.2.0", true],
    [null, false],
  ])("installed %p: never upgrades, warns: %p", async (installed, warns) => {
    const ran: string[] = [];
    const run = async (cmd: string) => {
      ran.push(cmd);
    };
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const [requirement] = createRtkPlugin({
        runRtkInstallCmd: run,
        runRtkCommandSilently: run,
        rtkBinaryPath: () => "/opt/homebrew/bin/rtk",
        installedRtkVersion: async () => installed,
      }).getInstallRequirements!({ config: makeCtx().config });
      await requirement!.update!();

      expect(ran).toEqual([]);
      const warnings = stderr.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((line) => line.includes("pins 1.1.0"));
      expect(warnings).toHaveLength(warns ? 1 : 0);
      if (warns) {
        expect(warnings[0]).toContain("rtk 1.2.0 is installed");
        expect(warnings[0]).toContain("rtk-ai/rtk/v1.1.0/install.sh | RTK_VERSION=v1.1.0 sh");
      }
    } finally {
      stderr.mockRestore();
    }
  });
});
