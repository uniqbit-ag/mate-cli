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

function runHook(
  payload: Record<string, unknown>,
  companion: string,
  env: Record<string, string> = {},
) {
  // Pin MATE_COMMAND: the surrounding session may be mate-managed and export
  // it, and the default-distribution assertions rely on the `mate` fallback.
  const spawnEnv = { ...process.env, MATE_ARTIFACT_PATH: companion, ...env };
  if (!("MATE_COMMAND" in env)) delete spawnEnv.MATE_COMMAND;
  const result = spawnSync("sh", [HOOK_PATH], {
    env: spawnEnv,
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function postToolUsePayload(
  command: string,
  toolResponse: Record<string, unknown> = { stdout: "ok", stderr: "", interrupted: false },
): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_response: toolResponse,
  };
}

function nudgeContext(stdout: string): string {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput?: {
      hookEventName?: string;
      additionalContext?: string;
      permissionDecision?: string;
    };
  };
  expect(parsed.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
  expect(parsed.hookSpecificOutput?.permissionDecision).toBeUndefined();
  return parsed.hookSpecificOutput?.additionalContext ?? "";
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("mate-artifact-finish", () => {
  test.each([
    "openspec archive acme --json --yes",
    'openspec archive --store local "acme" --yes',
    '"/opt/mate wrappers/openspec" archive acme --yes',
  ])("nudges after archive command: %s", async (command) => {
    const { companion } = await makeFixture();
    const result = runHook(postToolUsePayload(command), companion);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const context = nudgeContext(result.stdout);
    expect(context).toContain("acme");
    expect(context).toContain("mate-artifact-finish");
    expect(context).toContain('mate artifact finish "acme" --json');
  });

  test.each([
    'mv -v "acme" "openspec/changes/archive/2099-01-01-acme"',
    'mv -t "openspec/changes/archive/2099-01-01-acme" "acme"',
    "move acme openspec\\changes\\archive\\2099-01-01-acme",
    "cmd /c move acme openspec\\changes\\archive\\2099-01-01-acme",
    'powershell -Command "Move-Item acme openspec/changes/archive/2099-01-01-acme"',
    "python3 -c \"import shutil; shutil.move('acme', 'openspec/changes/archive/2099-01-01-acme')\"",
    "python -c \"import os; os.rename('acme', 'openspec/changes/archive/2099-01-01-acme')\"",
  ])("nudges after archive move command: %s", async (command) => {
    const { companion } = await makeFixture();
    const result = runHook(postToolUsePayload(command), companion);
    expect(nudgeContext(result.stdout)).toContain('mate artifact finish "acme" --json');
  });

  test("builds the finish instruction from MATE_COMMAND when set", async () => {
    const { companion } = await makeFixture();
    const result = runHook(postToolUsePayload("openspec archive sample-change --yes"), companion, {
      MATE_COMMAND: "acme",
    });
    expect(nudgeContext(result.stdout)).toContain('acme artifact finish "sample-change" --json');
  });

  test("falls back to mate when MATE_COMMAND is unset", async () => {
    const { companion } = await makeFixture();
    const result = runHook(postToolUsePayload("openspec archive sample-change --yes"), companion);
    expect(nudgeContext(result.stdout)).toContain('mate artifact finish "sample-change" --json');
  });

  test.each(['mate artifact finish "acme" --json', "printf hello", "mv acme somewhere-else"])(
    "stays silent for unrelated command: %s",
    async (command) => {
      const { companion } = await makeFixture();
      expect(runHook(postToolUsePayload(command), companion).stdout).toBe("");
    },
  );

  test.each([
    "openspec archive --help",
    "openspec archive --help 2>&1",
    "openspec archive --json > out.txt",
    "openspec archive 2> errors.log",
  ])("stays silent for archive invocation without a change name: %s", async (command) => {
    const { companion } = await makeFixture();
    expect(runHook(postToolUsePayload(command), companion).stdout).toBe("");
  });

  test.each([
    ["openspec archive acme --json 2>&1", "acme"],
    ["openspec archive acme --yes | tail -n 5", "acme"],
    ["openspec archive acme > archive.log 2>&1 && echo done", "acme"],
    ["openspec archive acme&&printf done", "acme"],
    ["openspec archive acme||printf failed", "acme"],
    ["openspec archive acme;printf done", "acme"],
    ["openspec archive acme|tail -n 5", "acme"],
    ['mv "acme" "openspec/changes/archive/2099-01-01-acme" 2>&1 | cat', "acme"],
    ['mv "acme" "openspec/changes/archive/2099-01-01-acme" >> moves.log', "acme"],
  ])("extracts the change name past shell syntax tokens: %s", async (command, expectedChange) => {
    const { companion } = await makeFixture();
    const context = nudgeContext(runHook(postToolUsePayload(command), companion).stdout);
    expect(context).toContain(`mate artifact finish "${expectedChange}" --json`);
  });

  test("does not treat a token after a pipe as the change name", async () => {
    const { companion } = await makeFixture();
    expect(
      runHook(postToolUsePayload("openspec archive --help | head -n 20"), companion).stdout,
    ).toBe("");
  });

  test.each([
    { exit_code: 1 },
    { exitCode: 2, stdout: "", stderr: "boom" },
    { success: false },
    { is_error: true },
    { error: "Change not found" },
    { interrupted: true },
  ])("suppresses the nudge when the tool response indicates failure: %o", async (toolResponse) => {
    const { companion } = await makeFixture();
    expect(
      runHook(postToolUsePayload("openspec archive acme --yes", toolResponse), companion).stdout,
    ).toBe("");
  });

  test.each([
    { stdout: "archived", stderr: "", interrupted: false },
    { exit_code: 0 },
    {},
    undefined,
  ])(
    "nudges when the tool response indicates success or is indeterminate: %o",
    async (toolResponse) => {
      const { companion } = await makeFixture();
      const payload = postToolUsePayload("openspec archive acme --yes");
      if (toolResponse === undefined) {
        delete payload.tool_response;
      } else {
        payload.tool_response = toolResponse;
      }
      expect(nudgeContext(runHook(payload, companion).stdout)).toContain("acme");
    },
  );

  test("repeated invocations across archival and non-archival commands create no state", async () => {
    const { companion } = await makeFixture();
    for (const command of [
      "openspec archive acme --yes",
      "printf hello",
      'mv "acme" "openspec/changes/archive/2099-01-01-acme"',
      "openspec archive acme --yes",
    ]) {
      runHook(postToolUsePayload(command), companion);
    }
    await expect(fs.access(path.join(companion, ".claude", "state"))).rejects.toThrow();
  });

  test("does not deny archival commands before execution", async () => {
    const { companion } = await makeFixture();
    for (const command of [
      "openspec archive acme --yes",
      'mv "acme" "openspec/changes/archive/2099-01-01-acme"',
    ]) {
      const result = runHook(
        { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } },
        companion,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    }
  });

  test("ignores non-Bash and Stop events", async () => {
    const { companion } = await makeFixture();
    expect(runHook({ hook_event_name: "Stop" }, companion).stdout).toBe("");
    expect(
      runHook(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Read",
          tool_input: { command: "openspec archive acme" },
          tool_response: { stdout: "ok" },
        },
        companion,
      ).stdout,
    ).toBe("");
  });

  test("external archive changes do not affect Bash or Stop and create no state", async () => {
    const { companion, archiveDir } = await makeFixture();
    await fs.mkdir(path.join(archiveDir, "2099-01-01-external"));

    expect(runHook(postToolUsePayload("printf hello"), companion).stdout).toBe("");
    expect(runHook({ hook_event_name: "Stop" }, companion).stdout).toBe("");
    await expect(fs.access(path.join(companion, ".claude", "state"))).rejects.toThrow();
  });
});
