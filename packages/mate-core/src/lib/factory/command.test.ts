import { describe, expect, test } from "bun:test";

import { runCommand } from "./command";

describe("runCommand", () => {
  test("a command past its timeout is killed and answered as failed", async () => {
    const result = await runCommand("sleep", ["5"], { timeoutMs: 50 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("timed out");
  });

  test("a command killed otherwise is not reported as timed out", async () => {
    const result = await runCommand("sh", ["-c", "kill -TERM $$"], { timeoutMs: 5000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain("timed out");
  });

  test("standard input reaches the command", async () => {
    const result = await runCommand("cat", [], { stdin: new TextEncoder().encode("acme") });
    expect(result).toEqual({ status: 0, stdout: "acme", stderr: "" });
  });
});
