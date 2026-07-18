import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { runUpdateCommand, updateCommandDeps } from "./update";

function captureStderr(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(chunk.toString());
    return true;
  }) as typeof process.stderr.write;

  return {
    chunks,
    restore: () => {
      process.stderr.write = originalWrite;
    },
  };
}

function captureLogs(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const originalLog = console.log;
  console.log = ((...args: unknown[]) => {
    chunks.push(args.join(" "));
  }) as typeof console.log;

  return {
    chunks,
    restore: () => {
      console.log = originalLog;
    },
  };
}

beforeEach(() => {
  process.exitCode = 0;
  updateCommandDeps.fetchLatestVersion = mock(async () => "9.9.9");
  updateCommandDeps.getCurrentVersion = mock(() => "1.0.0");
  updateCommandDeps.isNewer = mock((latest: string, current: string) => latest !== current);
  updateCommandDeps.confirmPrompt = mock(async () => true);
  updateCommandDeps.isNpmManagedInstall = mock(() => true);
  updateCommandDeps.installLatest = mock(() => ({ status: 0, error: undefined }) as never);
  updateCommandDeps.saveUpdateState = mock(async () => {});
  updateCommandDeps.runPostInstall = mock(() => ({ status: 0, error: undefined }) as never);
});

afterEach(() => {
  mock.restore();
  process.exitCode = 0;
});

describe("runUpdateCommand", () => {
  test("allows --check outside npm-managed installs and exits 1 when an update is available", async () => {
    const logs = captureLogs();

    try {
      await runUpdateCommand(["--check"]);
    } finally {
      logs.restore();
    }

    expect(updateCommandDeps.isNpmManagedInstall).not.toHaveBeenCalled();
    expect(updateCommandDeps.installLatest).not.toHaveBeenCalled();
    expect(logs.chunks.join("\n")).toContain("mate: update available (1.0.0 → 9.9.9)");
    expect(process.exitCode).toBe(1);
  });

  test("prints Up to date. for --check when no update is available", async () => {
    updateCommandDeps.isNewer = mock(() => false);
    const logs = captureLogs();

    try {
      await runUpdateCommand(["--check"]);
    } finally {
      logs.restore();
    }

    expect(logs.chunks.join("\n")).toContain("Up to date.");
    expect(process.exitCode).toBe(0);
  });

  test("installs through npm when the running Mate matches the npm global install", async () => {
    const logs = captureLogs();

    try {
      await runUpdateCommand(["--yes"]);
    } finally {
      logs.restore();
    }

    const output = logs.chunks.join("\n");
    expect(updateCommandDeps.confirmPrompt).not.toHaveBeenCalled();
    expect(updateCommandDeps.isNpmManagedInstall).toHaveBeenCalledTimes(1);
    expect(updateCommandDeps.installLatest).toHaveBeenCalledWith("9.9.9");
    expect(updateCommandDeps.saveUpdateState).toHaveBeenCalledWith("9.9.9");
    expect(updateCommandDeps.runPostInstall).toHaveBeenCalledWith(true);
    expect(output).toContain("Current version: 1.0.0");
    expect(output).toContain("Latest version: 9.9.9");
    expect(output).toContain("Upgraded to 9.9.9.");
  });

  test("rejects self-update when the running Mate is not npm-managed", async () => {
    updateCommandDeps.isNpmManagedInstall = mock(() => false);
    const stderr = captureStderr();

    try {
      await runUpdateCommand(["--yes"]);
    } finally {
      stderr.restore();
    }

    const output = stderr.chunks.join("");
    expect(updateCommandDeps.installLatest).not.toHaveBeenCalled();
    expect(output).toContain("self-update is only supported for npm-installed Mate");
    expect(output).toContain("npm config delete @uniqbit:registry --global");
    expect(output).toContain("npm install -g @uniqbit/mate");
    expect(process.exitCode).toBe(1);
  });

  test("reports a missing npm binary while leaving the install untouched", async () => {
    const missingNpmError = new Error("missing npm") as NodeJS.ErrnoException;
    missingNpmError.code = "ENOENT";
    updateCommandDeps.isNpmManagedInstall = mock(() => {
      throw missingNpmError;
    });
    const stderr = captureStderr();

    try {
      await runUpdateCommand(["--yes"]);
    } finally {
      stderr.restore();
    }

    const output = stderr.chunks.join("");
    expect(updateCommandDeps.installLatest).not.toHaveBeenCalled();
    expect(output).toContain("npm is required for self-update but was not found on PATH");
    expect(output).toContain("npm install -g @uniqbit/mate");
    expect(process.exitCode).toBe(1);
  });

  test("reports an incomplete installation when post-update install fails", async () => {
    updateCommandDeps.runPostInstall = mock(() => ({ status: 1, error: undefined }) as never);
    const stderr = captureStderr();

    try {
      await runUpdateCommand(["--yes"]);
    } finally {
      stderr.restore();
    }

    expect(updateCommandDeps.saveUpdateState).toHaveBeenCalledWith("9.9.9");
    expect(stderr.chunks.join(" ")).toContain("installation is incomplete");
    expect(process.exitCode).toBe(1);
  });
});
