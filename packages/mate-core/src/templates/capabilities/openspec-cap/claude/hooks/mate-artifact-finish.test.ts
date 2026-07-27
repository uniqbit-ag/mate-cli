import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

const HOOK_PATH = path.resolve(import.meta.dirname, "./mate-artifact-finish.sh");
const tempRoots: string[] = [];

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-artifact-finish-"));
  tempRoots.push(root);
  const companion = path.join(root, "companion");
  const archiveDir = path.join(companion, "openspec", "changes", "archive");
  await fs.mkdir(archiveDir, { recursive: true });
  return { companion, archiveDir };
}

function runHook(payload: Record<string, unknown>, companion: string) {
  const result = spawnSync("sh", [HOOK_PATH], {
    env: { ...process.env, MATE_ARTIFACT_PATH: companion },
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function denialReason(stdout: string): string {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput?: {
      hookEventName?: string;
      permissionDecision?: string;
      permissionDecisionReason?: string;
    };
  };
  expect(parsed.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
  expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny");
  return parsed.hookSpecificOutput?.permissionDecisionReason ?? "";
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("mate-artifact-finish", () => {
  test.each([
    "openspec archive acme --json --yes",
    'openspec archive --store local "acme" --yes',
    '"/opt/mate wrappers/openspec" archive acme --yes',
  ])("denies direct archive command: %s", async (command) => {
    const { companion } = await makeFixture();
    const result = runHook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } },
      companion,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const reason = denialReason(result.stdout);
    expect(reason).toContain("acme");
    expect(reason).toContain("mate-artifact-finish");
    expect(reason).toContain('mate artifact finish "acme" --json');
  });

  test.each([
    'mv -v "acme" "openspec/changes/archive/2099-01-01-acme"',
    'mv -t "openspec/changes/archive/2099-01-01-acme" "acme"',
    "move acme openspec\\changes\\archive\\2099-01-01-acme",
    "cmd /c move acme openspec\\changes\\archive\\2099-01-01-acme",
    'powershell -Command "Move-Item acme openspec/changes/archive/2099-01-01-acme"',
    "python3 -c \"import shutil; shutil.move('acme', 'openspec/changes/archive/2099-01-01-acme')\"",
    "python -c \"import os; os.rename('acme', 'openspec/changes/archive/2099-01-01-acme')\"",
  ])("denies archive move command: %s", async (command) => {
    const { companion } = await makeFixture();
    const result = runHook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } },
      companion,
    );
    expect(denialReason(result.stdout)).toContain('mate artifact finish "acme" --json');
  });

  test.each(['mate artifact finish "acme" --json', "printf hello", "mv acme somewhere-else"])(
    "allows command: %s",
    async (command) => {
      const { companion } = await makeFixture();
      expect(
        runHook(
          { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } },
          companion,
        ).stdout,
      ).toBe("");
    },
  );

  test("ignores non-Bash and Stop events", async () => {
    const { companion } = await makeFixture();
    expect(runHook({ hook_event_name: "Stop" }, companion).stdout).toBe("");
    expect(
      runHook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: { command: "openspec archive acme" },
        },
        companion,
      ).stdout,
    ).toBe("");
  });

  test("external archive changes do not affect Bash or Stop and create no state", async () => {
    const { companion, archiveDir } = await makeFixture();
    await fs.mkdir(path.join(archiveDir, "2099-01-01-external"));

    expect(
      runHook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "printf hello" },
        },
        companion,
      ).stdout,
    ).toBe("");
    expect(runHook({ hook_event_name: "Stop" }, companion).stdout).toBe("");
    await expect(fs.access(path.join(companion, ".claude", "state"))).rejects.toThrow();
  });
});
