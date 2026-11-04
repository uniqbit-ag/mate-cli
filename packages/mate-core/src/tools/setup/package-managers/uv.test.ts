import path from "node:path";

import { describe, expect, mock, spyOn, test } from "bun:test";

import type { SetupContext } from "../plugin";
import { createUvPlugin, uvInstallDirs } from "./uv";

function makeCtx(overrides: Partial<SetupContext> = {}): SetupContext {
  return {
    companionPath: "/tmp/companion",
    activeProviders: [],
    mode: "setup",
    config: {
      allowedAgents: [],
      packageManagers: ["uv"],
      capabilities: [],
    },
    ...overrides,
  };
}

describe("createUvPlugin apply()", () => {
  test("skips prompt when uv is already on PATH", async () => {
    const confirmMock = mock(async (_: string) => false);
    const plugin = createUvPlugin({
      confirm: confirmMock,
      isCommandOnPath: () => true,
    });

    await plugin.apply(makeCtx());

    expect(confirmMock).not.toHaveBeenCalled();
  });

  test("skips prompt in sync mode", async () => {
    const confirmMock = mock(async (_: string) => false);
    const plugin = createUvPlugin({
      confirm: confirmMock,
      isCommandOnPath: () => false,
    });

    await plugin.apply(makeCtx({ mode: "sync" }));

    expect(confirmMock).not.toHaveBeenCalled();
  });

  test("prints brew install command on macOS when brew is available", async () => {
    const confirmMock = mock(async (_: string) => false);
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      const plugin = createUvPlugin({
        confirm: confirmMock,
        isCommandOnPath: (cmd) => cmd === "brew",
        platform: "darwin",
      });

      await plugin.apply(makeCtx());

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("brew install uv"));
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  test("prints curl install command on macOS when brew is unavailable", async () => {
    const confirmMock = mock(async (_: string) => false);
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      const plugin = createUvPlugin({
        confirm: confirmMock,
        isCommandOnPath: () => false,
        platform: "darwin",
      });

      await plugin.apply(makeCtx());

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("astral.sh/uv/install.sh"));
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  test("prints curl install command on linux", async () => {
    const confirmMock = mock(async (_: string) => false);
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      const plugin = createUvPlugin({
        confirm: confirmMock,
        isCommandOnPath: () => false,
        platform: "linux",
      });

      await plugin.apply(makeCtx());

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("astral.sh/uv/install.sh"));
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  test("prints powershell install command on windows", async () => {
    const confirmMock = mock(async (_: string) => false);
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      const plugin = createUvPlugin({
        confirm: confirmMock,
        isCommandOnPath: () => false,
        platform: "win32",
      });

      await plugin.apply(makeCtx());

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("astral.sh/uv/install.ps1"));
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  test("runs brew install when user confirms on macOS", async () => {
    const confirmMock = mock(async (_: string) => true);
    const runCommandMock = mock(async () => {});
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      const plugin = createUvPlugin({
        confirm: confirmMock,
        isCommandOnPath: (cmd) => cmd === "brew",
        platform: "darwin",
        runCommand: runCommandMock,
      });

      await plugin.apply(makeCtx());

      expect(runCommandMock).toHaveBeenCalledWith("brew", ["install", "uv"]);
      expect(runCommandMock).toHaveBeenCalledWith("uv", ["tool", "update-shell"]);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  test("does not fail setup when update-shell cannot be run automatically", async () => {
    const confirmMock = mock(async (_: string) => true);
    const runCommandMock = mock(async (command: string) => {
      if (command === "uv") {
        throw new Error("uv missing from current shell");
      }
    });
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const plugin = createUvPlugin({
        confirm: confirmMock,
        isCommandOnPath: (cmd) => cmd === "brew",
        platform: "darwin",
        runCommand: runCommandMock,
      });

      await expect(plugin.apply(makeCtx())).resolves.toBeUndefined();

      expect(runCommandMock).toHaveBeenCalledWith("brew", ["install", "uv"]);
      expect(runCommandMock).toHaveBeenCalledWith("uv", ["tool", "update-shell"]);
      expect(stderrSpy).toHaveBeenCalledWith(
        "uv installed, but `uv tool update-shell` could not be run automatically\n",
      );
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  test("does not run install when user declines", async () => {
    const confirmMock = mock(async (_: string) => false);
    const runCommandMock = mock(async () => {});
    const runShellCommandMock = mock(async () => {});
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      const plugin = createUvPlugin({
        confirm: confirmMock,
        isCommandOnPath: () => false,
        platform: "linux",
        runCommand: runCommandMock,
        runShellCommand: runShellCommandMock,
      });

      await plugin.apply(makeCtx());

      expect(runCommandMock).not.toHaveBeenCalled();
      expect(runShellCommandMock).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  test("setup does not offer uv when the member declined Graphify, its only reason", async () => {
    const confirmMock = mock(async (_: string) => true);
    const plugin = createUvPlugin({
      confirm: confirmMock,
      isCommandOnPath: () => false,
      installDirs: [],
      platform: "linux",
      readMemberChoices: async () => ({ graphify: "declined" }),
    });

    await plugin.apply(
      makeCtx({
        config: { allowedAgents: [], capabilities: [{ name: "graphify" }] },
      }),
    );

    expect(confirmMock).not.toHaveBeenCalled();
  });

  test("teardown is a no-op", async () => {
    const plugin = createUvPlugin();
    await expect(plugin.teardown(makeCtx())).resolves.toBeUndefined();
  });
});

describe("createUvPlugin enablement", () => {
  const plugin = createUvPlugin({ isCommandOnPath: () => true });

  test("is enabled only when Graphify, which installs through uv, is selected", () => {
    expect(plugin.isEnabled({ packageManagers: ["bun"], capabilities: [] })).toBe(false);
    expect(
      plugin.isEnabled({ packageManagers: ["bun"], capabilities: [{ name: "graphify" }] }),
    ).toBe(true);
  });

  test("ignores a legacy uv entry in packageManagers", () => {
    expect(plugin.isEnabled({ packageManagers: ["bun", "uv"], capabilities: [] })).toBe(false);
  });
});

describe("createUvPlugin install requirement", () => {
  test("finds a freshly installed uv in its install directory when PATH lacks it", async () => {
    let installed = false;
    const plugin = createUvPlugin({
      pathValue: "/usr/bin",
      platform: "linux",
      installDirs: ["/home/user/.local/bin"],
      isCommandOnPath: (command, pathValue) =>
        command === "uv" && installed && pathValue === "/home/user/.local/bin",
      runShellCommand: async () => {
        installed = true;
      },
      runCommand: async () => {},
    });
    const [requirement] = plugin.getInstallRequirements!({ config: {} });

    expect(await requirement.detect()).toBe(false);
    await requirement.install();
    expect(await requirement.verify!()).toBe(true);
  });

  test("probes the uv installer's directories in its precedence order", () => {
    expect(uvInstallDirs({ UV_INSTALL_DIR: "/opt/uv", XDG_BIN_HOME: "/xdg/bin" }, "/h")).toEqual([
      "/opt/uv",
      "/xdg/bin",
      path.join("/h", ".local", "bin"),
      path.join("/h", ".cargo", "bin"),
    ]);
  });
});
