import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

const HOOK_PATH = path.resolve(import.meta.dirname, "./mate-openspec-artifact-finish.sh");
const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function runHook(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync("sh", [HOOK_PATH], {
    env: { ...process.env, ...env },
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function additionalContextOf(stdout: string): string {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
  };
  expect(parsed.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
  return parsed.hookSpecificOutput?.additionalContext ?? "";
}

async function makeFixture() {
  const root = await makeTempDir("mate-openspec-artifact-finish-");
  const companion = path.join(root, "companion");
  const archiveDir = path.join(companion, "openspec", "changes", "archive");
  await fs.mkdir(archiveDir, { recursive: true });
  return { companion, archiveDir };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("mate-openspec-artifact-finish", () => {
  test("nudges when a new archive entry appears and not on repeat invocation", async () => {
    const { companion, archiveDir } = await makeFixture();
    const env = { MATE_ARTIFACT_PATH: companion };

    expect(runHook({ tool_name: "Read" }, env).stdout).toBe("");
    await fs.mkdir(path.join(archiveDir, "2026-07-14-my-change"));
    const detected = runHook({ tool_name: "ApplyPatch" }, env);
    expect(detected.exitCode).toBe(0);
    const context = additionalContextOf(detected.stdout);
    expect(context).toContain("mate-openspec-artifact-finish");
    expect(context).toContain("my-change");
    expect(context).toContain("never through a companion-local wrapper path");
    expect(context).toContain("$MATE_COMPANION_BIN_PATH/mate");
    expect(runHook({ tool_name: "Bash" }, env).stdout).toBe("");
  });

  test("is tool-agnostic and emits one nudge per new archive entry", async () => {
    const { companion, archiveDir } = await makeFixture();
    const env = { MATE_ARTIFACT_PATH: companion };
    runHook({ tool_name: "Read" }, env);
    await fs.mkdir(path.join(archiveDir, "2026-07-14-first-change"));
    await fs.mkdir(path.join(archiveDir, "2026-07-15-second-change"));
    await fs.writeFile(path.join(archiveDir, "README.md"), "ignored");
    await fs.mkdir(path.join(archiveDir, "not-an-archive"));

    const result = runHook({ tool_name: "Write" }, env);
    const context = additionalContextOf(result.stdout);
    expect(context.match(/An openspec change/g)).toHaveLength(2);
    expect(context).toContain("first-change");
    expect(context).toContain("second-change");
    expect(context).not.toContain("README");
  });

  const archiveMoveCommands = [
    'mv -v "my-change" "openspec/changes/archive/2026-07-14-my-change"',
    'mv -t "openspec/changes/archive/2026-07-14-my-change" "my-change"',
    "move my-change openspec\\changes\\archive\\2026-07-14-my-change",
    "cmd /c move my-change openspec\\changes\\archive\\2026-07-14-my-change",
    'powershell -Command "Move-Item my-change openspec/changes/archive/2026-07-14-my-change"',
    "python3 -c \"import shutil; shutil.move('my-change', 'openspec/changes/archive/2026-07-14-my-change')\"",
    "python -c \"import os; os.rename('my-change', 'openspec/changes/archive/2026-07-14-my-change')\"",
  ];

  for (const command of archiveMoveCommands) {
    test(`nudges after archive move form: ${command}`, async () => {
      const { companion } = await makeFixture();
      const result = runHook(
        { tool_name: "Bash", tool_input: { command }, tool_response: { exit_code: 0 } },
        { MATE_ARTIFACT_PATH: companion },
      );
      expect(result.exitCode).toBe(0);
      const context = additionalContextOf(result.stdout);
      expect(context).toContain("mate-openspec-artifact-finish");
      expect(context).toContain("my-change");
    });
  }

  test("nudges after a direct openspec archive command", async () => {
    const { companion } = await makeFixture();
    const result = runHook(
      { tool_name: "Bash", tool_input: { command: "openspec archive my-change --json --yes" } },
      { MATE_ARTIFACT_PATH: companion },
    );
    expect(additionalContextOf(result.stdout)).toContain("my-change");
  });

  test("ignores failed archive commands and unrelated tools", async () => {
    const { companion } = await makeFixture();
    const env = { MATE_ARTIFACT_PATH: companion };
    expect(
      runHook(
        {
          tool_name: "Bash",
          tool_input: { command: "openspec archive my-change --json --yes" },
          tool_response: { exit_code: 1 },
        },
        env,
      ).stdout,
    ).toBe("");
    expect(
      runHook({ tool_name: "Bash", tool_input: { command: "printf hello" } }, env).stdout,
    ).toBe("");
  });

  test("does not nudge entries present in the initial state baseline", async () => {
    const { companion, archiveDir } = await makeFixture();
    await fs.mkdir(path.join(archiveDir, "2026-07-14-existing-change"));
    expect(runHook({ tool_name: "Bash" }, { MATE_ARTIFACT_PATH: companion }).stdout).toBe("");
  });

  test("fails open for a corrupt state file", async () => {
    const { companion, archiveDir } = await makeFixture();
    const stateFile = path.join(
      companion,
      ".claude",
      "state",
      "mate-openspec-artifact-finish.archive-snapshot.json",
    );
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, "not json");
    await fs.mkdir(path.join(archiveDir, "2026-07-14-existing-change"));
    expect(runHook({ tool_name: "Bash" }, { MATE_ARTIFACT_PATH: companion }).stdout).toBe("");
    await fs.mkdir(path.join(archiveDir, "2026-07-15-new-change"));
    expect(
      additionalContextOf(runHook({ tool_name: "Read" }, { MATE_ARTIFACT_PATH: companion }).stdout),
    ).toContain("new-change");
  });

  test("two different session_ids for the same companion do not share a baseline", async () => {
    const { companion, archiveDir } = await makeFixture();
    const env = { MATE_ARTIFACT_PATH: companion };

    expect(runHook({ tool_name: "Bash", session_id: "session-A" }, env).stdout).toBe("");
    expect(runHook({ tool_name: "Bash", session_id: "session-B" }, env).stdout).toBe("");

    await fs.mkdir(path.join(archiveDir, "2026-07-14-shared-change"));

    const nudgedA = runHook({ tool_name: "Bash", session_id: "session-A" }, env);
    expect(additionalContextOf(nudgedA.stdout)).toContain("shared-change");

    const nudgedB = runHook({ tool_name: "Bash", session_id: "session-B" }, env);
    expect(additionalContextOf(nudgedB.stdout)).toContain("shared-change");
  });

  test("a brand-new session silently absorbs archive entries that predate it", async () => {
    const { companion, archiveDir } = await makeFixture();
    await fs.mkdir(path.join(archiveDir, "2026-07-14-existing-change"));
    expect(
      runHook({ tool_name: "Bash", session_id: "fresh-session" }, { MATE_ARTIFACT_PATH: companion })
        .stdout,
    ).toBe("");
  });

  test("nudges once mid-session and not again on a repeat invocation with the same session_id", async () => {
    const { companion, archiveDir } = await makeFixture();
    const env = { MATE_ARTIFACT_PATH: companion };

    expect(runHook({ tool_name: "Bash", session_id: "session-C" }, env).stdout).toBe("");
    await fs.mkdir(path.join(archiveDir, "2026-07-14-mid-session-change"));
    expect(
      additionalContextOf(runHook({ tool_name: "Bash", session_id: "session-C" }, env).stdout),
    ).toContain("mid-session-change");
    expect(runHook({ tool_name: "Bash", session_id: "session-C" }, env).stdout).toBe("");
  });

  test("a payload with no session_id falls back to the prior fixed-path behavior", async () => {
    const { companion, archiveDir } = await makeFixture();
    const env = { MATE_ARTIFACT_PATH: companion };
    const fixedStateFile = path.join(
      companion,
      ".claude",
      "state",
      "mate-openspec-artifact-finish.archive-snapshot.json",
    );

    expect(runHook({ tool_name: "Bash" }, env).stdout).toBe("");
    await fs.access(fixedStateFile);

    await fs.mkdir(path.join(archiveDir, "2026-07-14-no-session-change"));
    expect(additionalContextOf(runHook({ tool_name: "Bash" }, env).stdout)).toContain(
      "no-session-change",
    );
    expect(runHook({ tool_name: "Bash" }, env).stdout).toBe("");
  });
});
