import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, test } from "bun:test";
import { version } from "../../../../package.json";

const HOOK_PATH = path.resolve(import.meta.dirname, "./.claude/hooks/mate-session-banner");

function runHook(env: NodeJS.ProcessEnv): { exitCode: number; stdout: string } {
  const result = spawnSync("python3", [HOOK_PATH], {
    env: { ...process.env, ...env },
    input: "{}",
    encoding: "utf8",
  });

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout,
  };
}

describe("mate-session-banner", () => {
  test("emits a systemMessage banner with the active repo and artifact paths", () => {
    const result = runHook({
      MATE_REPO_PATH: "/repo/path",
      MATE_ARTIFACT_PATH: "/artifact/path",
      MATE_VERSION: version,
    });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as { systemMessage?: string };
    expect(output.systemMessage).toContain(`mate v${version}`);
    expect(output.systemMessage).not.toContain("managed session");
    expect(output.systemMessage).toContain("/repo/path");
    expect(output.systemMessage).toContain("/artifact/path");
  });

  test("exits cleanly without a banner when MATE_REPO_PATH is missing", () => {
    const result = runHook({ MATE_REPO_PATH: "", MATE_ARTIFACT_PATH: "/artifact/path" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  test("exits cleanly without a banner when MATE_ARTIFACT_PATH is missing", () => {
    const result = runHook({ MATE_REPO_PATH: "/repo/path", MATE_ARTIFACT_PATH: "" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });
});
