import { describe, expect, test } from "bun:test";

import {
  OpenSpecCliUnavailableError,
  resolveOpenSpecExecutable,
  runOpenSpecCli,
} from "./openspec-cli-client";

describe("resolveOpenSpecExecutable", () => {
  test("falls back to the bare command name when unset", () => {
    expect(resolveOpenSpecExecutable(undefined)).toBe("openspec");
  });

  test("falls back to the bare command name when blank", () => {
    expect(resolveOpenSpecExecutable("   ")).toBe("openspec");
  });

  test("uses the configured absolute path when set", () => {
    expect(resolveOpenSpecExecutable("/usr/local/bin/openspec")).toBe("/usr/local/bin/openspec");
  });
});

describe("runOpenSpecCli", () => {
  test("captures stdout, stderr, and exit code separately", async () => {
    const result = await runOpenSpecCli(
      ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"],
      { executablePath: "bun" },
    );

    expect(result.code).toBe(3);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  test("rejects with OpenSpecCliUnavailableError when the executable cannot be spawned", async () => {
    await expect(
      runOpenSpecCli(["list", "--json"], {
        executablePath: "/definitely/not/a/real/openspec/binary",
      }),
    ).rejects.toBeInstanceOf(OpenSpecCliUnavailableError);
  });

  test("times out and rejects a hanging process", async () => {
    await expect(
      runOpenSpecCli(["-e", "setTimeout(() => {}, 60000)"], {
        executablePath: "bun",
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out/);
  });
});
