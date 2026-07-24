import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { CLAUDE_HOOK_SRC, createReactDoctorPlugin } from "./react-doctor";

const reactDoctorPlugin = createReactDoctorPlugin();

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function runHook(
  repo: string,
  tempDir: string,
  input: Record<string, unknown>,
  env: Record<string, string> = {},
) {
  return spawnSync("sh", [CLAUDE_HOOK_SRC], {
    encoding: "utf8",
    input: JSON.stringify(input),
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: repo,
      TMPDIR: tempDir,
      MATE_REACT_DOCTOR_BIN_PATH: path.join(repo, "node_modules", ".bin", "react-doctor"),
      ...env,
    },
  });
}

async function setupHookFixture() {
  const root = await makeTempDir("mate-react-doctor-hook-");
  const repo = path.join(root, "repo");
  const tempDir = path.join(root, "tmp");
  const binDir = path.join(repo, "node_modules", ".bin");
  const logPath = path.join(root, "react-doctor.log");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(tempDir, { recursive: true });
  const fakeDoctor = path.join(binDir, "react-doctor");
  await fs.writeFile(
    fakeDoctor,
    '#!/bin/sh\nprintf \'cwd=%s args=%s\\n\' "$PWD" "$*" >> "$REACT_DOCTOR_TEST_LOG"\nprintf \'%s\\n\' "${REACT_DOCTOR_TEST_OUTPUT:-}"\nexit "${REACT_DOCTOR_TEST_EXIT:-0}"\n',
    "utf8",
  );
  await fs.chmod(fakeDoctor, 0o755);
  return { repo, tempDir, logPath, fakeDoctor };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("reactDoctorPlugin", () => {
  test("coalesces edits into one bounded scan and skips repeated stops", async () => {
    const { repo, tempDir, logPath } = await setupHookFixture();
    const env = { REACT_DOCTOR_TEST_LOG: logPath };

    runHook(repo, tempDir, {
      hook_event_name: "PostToolUse",
      session_id: "one",
      tool_name: "Edit",
    });
    runHook(repo, tempDir, {
      hook_event_name: "PostToolUse",
      session_id: "one",
      tool_name: "Write",
    });
    expect(runHook(repo, tempDir, { hook_event_name: "Stop", session_id: "two" }, env).status).toBe(
      0,
    );
    expect(runHook(repo, tempDir, { hook_event_name: "Stop", session_id: "one" }, env).status).toBe(
      0,
    );
    expect(runHook(repo, tempDir, { hook_event_name: "Stop", session_id: "one" }, env).status).toBe(
      0,
    );

    const invocations = (await fs.readFile(logPath, "utf8")).trim().split("\n");
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toContain("--yes --verbose --scope changed --base HEAD");
    expect(invocations[0]).toContain("--blocking warning --no-score --max-duration 30");
    expect(invocations[0]).not.toContain("--no-dead-code");
    expect(invocations[0]).not.toContain("--no-supply-chain");
  });

  test("returns findings once and scans a correction only after another edit", async () => {
    const { repo, tempDir, logPath } = await setupHookFixture();
    const env = {
      REACT_DOCTOR_TEST_LOG: logPath,
      REACT_DOCTOR_TEST_EXIT: "1",
      REACT_DOCTOR_TEST_OUTPUT: "src/App.tsx:1 warning",
    };

    runHook(repo, tempDir, {
      hook_event_name: "PostToolUse",
      session_id: "one",
      tool_name: "Edit",
    });
    const findings = runHook(repo, tempDir, { hook_event_name: "Stop", session_id: "one" }, env);
    const noEditFollowUp = runHook(
      repo,
      tempDir,
      { hook_event_name: "Stop", session_id: "one", stop_hook_active: true },
      env,
    );
    runHook(repo, tempDir, {
      hook_event_name: "PostToolUse",
      session_id: "one",
      tool_name: "Edit",
    });
    const correction = runHook(
      repo,
      tempDir,
      { hook_event_name: "Stop", session_id: "one", stop_hook_active: true },
      env,
    );

    expect(JSON.parse(findings.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: expect.stringContaining("src/App.tsx:1 warning"),
      },
    });
    expect(noEditFollowUp.stdout).toBe("");
    expect(correction.stdout).toContain("src/App.tsx:1 warning");
    expect((await fs.readFile(logPath, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  test("skips the stop scan when the edit was reverted", async () => {
    const { repo, tempDir, logPath } = await setupHookFixture();
    expect(spawnSync("git", ["init", "--quiet", repo]).status).toBe(0);
    expect(spawnSync("git", ["-C", repo, "add", "."]).status).toBe(0);
    expect(
      spawnSync("git", [
        "-C",
        repo,
        "-c",
        "user.name=React Doctor Test",
        "-c",
        "user.email=react-doctor-test@example.com",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ]).status,
    ).toBe(0);

    runHook(repo, tempDir, {
      hook_event_name: "PostToolUse",
      session_id: "one",
      tool_name: "Edit",
    });
    const result = runHook(
      repo,
      tempDir,
      { hook_event_name: "Stop", session_id: "one" },
      {
        REACT_DOCTOR_TEST_LOG: logPath,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    await expect(fs.access(logPath)).rejects.toThrow();
  });

  test("uses Claude's hook cwd when CLAUDE_PROJECT_DIR is unset", async () => {
    const { repo, tempDir, logPath } = await setupHookFixture();
    const env = { CLAUDE_PROJECT_DIR: "", REACT_DOCTOR_TEST_LOG: logPath };
    const input = {
      hook_event_name: "PostToolUse",
      session_id: "one",
      tool_name: "Edit",
      cwd: repo,
    };

    runHook(repo, tempDir, input, env);
    const result = runHook(repo, tempDir, { ...input, hook_event_name: "Stop" }, env);

    expect(result.status).toBe(0);
    expect(await fs.readFile(logPath, "utf8")).toContain(`cwd=${repo}`);
  });

  test("uses the Mate-owned React Doctor executable when provided", async () => {
    const { repo, tempDir, logPath, fakeDoctor } = await setupHookFixture();
    const mateBinDir = await makeTempDir("mate-react-doctor-runtime-");
    const mateBin = path.join(mateBinDir, "react-doctor");
    await fs.copyFile(fakeDoctor, mateBin);
    await fs.chmod(mateBin, 0o755);
    await fs.unlink(fakeDoctor);

    const env = {
      MATE_REACT_DOCTOR_BIN_PATH: mateBin,
      REACT_DOCTOR_TEST_LOG: logPath,
    };
    runHook(repo, tempDir, {
      hook_event_name: "PostToolUse",
      session_id: "one",
      tool_name: "Edit",
    });
    const result = runHook(repo, tempDir, { hook_event_name: "Stop", session_id: "one" }, env);

    expect(result.status).toBe(0);
    expect(await fs.readFile(logPath, "utf8")).toContain("--max-duration 30");
  });

  test("suppresses known non-lint failures", async () => {
    const { repo, tempDir, logPath } = await setupHookFixture();
    runHook(repo, tempDir, {
      hook_event_name: "PostToolUse",
      session_id: "one",
      tool_name: "Edit",
    });
    const result = runHook(
      repo,
      tempDir,
      { hook_event_name: "Stop", session_id: "one" },
      {
        REACT_DOCTOR_TEST_LOG: logPath,
        REACT_DOCTOR_TEST_EXIT: "1",
        REACT_DOCTOR_TEST_OUTPUT: "No React dependency found",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("teardown leaves companion Claude settings untouched", async () => {
    const companionPath = await makeTempDir("mate-react-doctor-claude-teardown-");
    const settingsPath = path.join(companionPath, ".claude", "settings.local.json");
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: 'sh "/tmp/react-doctor.sh"' }] }],
            PreToolUse: [{ matcher: "Write", hooks: [] }],
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    await reactDoctorPlugin.forProvider?.claude?.teardown?.({
      companionPath,
      config: {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        capabilities: [{ name: "react-doctor" }],
      },
      stage: "setup",
      activeProviders: [],
    } as never);

    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    expect(settings.hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: 'sh "/tmp/react-doctor.sh"' }] },
    ]);
    expect(settings.hooks.PreToolUse).toEqual([{ matcher: "Write", hooks: [] }]);
  });
});
