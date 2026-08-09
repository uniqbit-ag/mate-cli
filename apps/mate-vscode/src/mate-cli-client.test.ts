import { describe, expect, test } from "bun:test";

import { MateCliUnavailableError, resolveMateExecutable, runMateCli } from "./mate-cli-client";

describe("resolveMateExecutable", () => {
  test("falls back to the bare command name when unset", () => {
    expect(resolveMateExecutable(undefined)).toBe("mate");
  });

  test("falls back to the bare command name when blank", () => {
    expect(resolveMateExecutable("   ")).toBe("mate");
  });

  test("uses the configured absolute path when set", () => {
    expect(resolveMateExecutable("/usr/local/bin/mate")).toBe("/usr/local/bin/mate");
  });
});

describe("runMateCli", () => {
  test("captures stdout, stderr, and exit code separately", async () => {
    const result = await runMateCli(
      ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"],
      {
        executablePath: "bun",
      },
    );

    expect(result.code).toBe(3);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  test("rejects with MateCliUnavailableError when the executable cannot be spawned", async () => {
    await expect(
      runMateCli(["workspace", "list", "--json"], {
        executablePath: "/definitely/not/a/real/mate/binary",
      }),
    ).rejects.toBeInstanceOf(MateCliUnavailableError);
  });

  test("times out and rejects a hanging process", async () => {
    await expect(
      runMateCli(["-e", "setTimeout(() => {}, 60000)"], { executablePath: "bun", timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/);
  });
});
