import { describe, expect, mock, spyOn, test } from "bun:test";

import type { SetupContext } from "../plugin";
import { createUvPlugin } from "./uv";

function makeCtx(overrides: Partial<SetupContext> = {}): SetupContext {
  return {
    companionPath: "/tmp/companion",
    activeProviders: [],
    mode: "setup",
    config: {
      profiles: { default: { name: "default", allowedAgents: [] } },
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

  test("teardown is a no-op", async () => {
    const plugin = createUvPlugin();
    await expect(plugin.teardown(makeCtx())).resolves.toBeUndefined();
  });
});
