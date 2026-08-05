import { describe, expect, test } from "bun:test";

import { evaluate, isGateEnabled } from "./artifact-finish-nudge";

const GATE_ON = { MATE_OPENSPEC_ENABLED: "1", MATE_GIT_AUTO_MODE: "1" };

function postToolUsePayload(
  command: string,
  toolResponse: Record<string, unknown> | undefined = {
    stdout: "ok",
    stderr: "",
    interrupted: false,
  },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command },
  };
  if (toolResponse !== undefined) payload.tool_response = toolResponse;
  return payload;
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

describe("artifact-finish-nudge gate", () => {
  test("gate requires openspec enabled and git auto mode", () => {
    expect(isGateEnabled(GATE_ON)).toBe(true);
    expect(isGateEnabled({ MATE_OPENSPEC_ENABLED: "1", MATE_GIT_AUTO_MODE: "0" })).toBe(false);
    expect(isGateEnabled({ MATE_OPENSPEC_ENABLED: "0", MATE_GIT_AUTO_MODE: "1" })).toBe(false);
    expect(isGateEnabled({})).toBe(false);
  });

  test("gate-off evaluation is silent even for a visible archive", () => {
    const result = evaluate(postToolUsePayload("openspec archive acme --yes"), {
      MATE_GIT_AUTO_MODE: "0",
      MATE_OPENSPEC_ENABLED: "1",
    });
    expect(result).toEqual({ exitCode: 0, stdout: "" });
  });
});

describe("artifact-finish-nudge", () => {
  test.each([
    "openspec archive acme --json --yes",
    'openspec archive --store local "acme" --yes',
    '"/opt/mate wrappers/openspec" archive acme --yes',
  ])("nudges after archive command: %s", (command) => {
    const result = evaluate(postToolUsePayload(command), GATE_ON);
    expect(result.exitCode).toBe(0);
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
  ])("nudges after archive move command: %s", (command) => {
    const result = evaluate(postToolUsePayload(command), GATE_ON);
    expect(nudgeContext(result.stdout)).toContain('mate artifact finish "acme" --json');
  });

  test.each(['mate artifact finish "acme" --json', "printf hello", "mv acme somewhere-else"])(
    "stays silent for unrelated command: %s",
    (command) => {
      expect(evaluate(postToolUsePayload(command), GATE_ON).stdout).toBe("");
    },
  );

  test.each([
    "openspec archive --help",
    "openspec archive --help 2>&1",
    "openspec archive --json > out.txt",
    "openspec archive 2> errors.log",
  ])("stays silent for archive invocation without a change name: %s", (command) => {
    expect(evaluate(postToolUsePayload(command), GATE_ON).stdout).toBe("");
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
  ])("extracts the change name past shell syntax tokens: %s", (command, expectedChange) => {
    const context = nudgeContext(evaluate(postToolUsePayload(command), GATE_ON).stdout);
    expect(context).toContain(`mate artifact finish "${expectedChange}" --json`);
  });

  test.each([
    ['DEST="openspec/changes/archive/2099-01-01-acme"\nmv "acme" "$DEST"', "acme"],
    ['DEST=openspec/changes/archive/2099-01-01-acme; mv acme "${DEST}"', "acme"],
    ['TARGET=2099-01-01-acme\nDEST="openspec/changes/archive/$TARGET"\nmv "acme" "$DEST"', "acme"],
    ['CHANGE=acme\nopenspec archive "$CHANGE" --yes', "acme"],
    ['CHANGE=acme; openspec archive "${CHANGE}" --yes', "acme"],
  ])(
    "resolves a destination or change name built through shell variables: %s",
    (command, expectedChange) => {
      const result = evaluate(postToolUsePayload(command), GATE_ON);
      expect(nudgeContext(result.stdout)).toContain(
        `mate artifact finish "${expectedChange}" --json`,
      );
    },
  );

  test("stays silent when a variable reference cannot be resolved", () => {
    expect(evaluate(postToolUsePayload('mv acme "$UNKNOWN_DEST"'), GATE_ON).stdout).toBe("");
  });

  test("does not treat a token after a pipe as the change name", () => {
    expect(
      evaluate(postToolUsePayload("openspec archive --help | head -n 20"), GATE_ON).stdout,
    ).toBe("");
  });

  test.each([
    { exit_code: 1 },
    { exitCode: 2, stdout: "", stderr: "boom" },
    { success: false },
    { is_error: true },
    { error: "Change not found" },
    { interrupted: true },
  ])("suppresses the nudge when the tool response indicates failure: %o", (toolResponse) => {
    expect(
      evaluate(postToolUsePayload("openspec archive acme --yes", toolResponse), GATE_ON).stdout,
    ).toBe("");
  });

  test.each([
    { stdout: "archived", stderr: "", interrupted: false },
    { exit_code: 0 },
    {},
    undefined,
  ])("nudges when the tool response indicates success or is indeterminate: %o", (toolResponse) => {
    const result = evaluate(
      postToolUsePayload("openspec archive acme --yes", toolResponse),
      GATE_ON,
    );
    expect(nudgeContext(result.stdout)).toContain("acme");
  });

  test("does not deny archival commands before execution", () => {
    for (const command of [
      "openspec archive acme --yes",
      'mv "acme" "openspec/changes/archive/2099-01-01-acme"',
    ]) {
      const result = evaluate(
        { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } },
        GATE_ON,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    }
  });

  test("ignores non-Bash and Stop events", () => {
    expect(evaluate({ hook_event_name: "Stop" }, GATE_ON).stdout).toBe("");
    expect(
      evaluate(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Read",
          tool_input: { command: "openspec archive acme" },
          tool_response: { stdout: "ok" },
        },
        GATE_ON,
      ).stdout,
    ).toBe("");
  });

  test("tolerates malformed payloads", () => {
    expect(evaluate(null, GATE_ON).exitCode).toBe(0);
    expect(evaluate("garbage", GATE_ON).exitCode).toBe(0);
    expect(evaluate({ hook_event_name: "PostToolUse", tool_name: "Bash" }, GATE_ON).stdout).toBe(
      "",
    );
  });
});
