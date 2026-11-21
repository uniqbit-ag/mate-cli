import { describe, expect, test } from "bun:test";

import {
  agentRuntime,
  formatInvocation,
  invokedSkill,
  namesInvocation,
  parseInvocations,
} from "./skill-prefix";

describe("agentRuntime", () => {
  test("reads each runtime's own marker, Mate's plugin marker first", () => {
    expect(agentRuntime({ CLAUDECODE: "1" })).toBe("claude");
    expect(agentRuntime({ OPENCODE_SESSION_ID: "ses_acme" })).toBe("opencode");
    expect(agentRuntime({ OPENCODE: "1" })).toBe("opencode");
    expect(agentRuntime({ CODEX_THREAD_ID: "acme-thread" })).toBe("codex");
    expect(agentRuntime({ CODEX_SESSION_ID: "acme-session" })).toBe("codex");
    expect(agentRuntime({ PI_CODING_AGENT: "true" })).toBe("pi");
    expect(agentRuntime({ PI_SESSION_ID: "acme-session" })).toBe("pi");
    expect(agentRuntime({ MATE_AGENT_RUNTIME: "opencode", CLAUDECODE: "1" })).toBe("opencode");
    expect(agentRuntime({ MATE_AGENT_RUNTIME: "pi" })).toBe("pi");
    expect(agentRuntime({ MATE_AGENT_RUNTIME: "acme" })).toBe("claude");
    // An inherited property is no runtime.
    expect(agentRuntime({ MATE_AGENT_RUNTIME: "constructor" })).toBe("claude");
    expect(agentRuntime({ MATE_AGENT_RUNTIME: "toString" })).toBe("claude");
    expect(agentRuntime({})).toBe("claude");
  });
});

describe("formatInvocation", () => {
  test("uses each runtime's prefix, with the change when given", () => {
    expect(formatInvocation("claude", "acme-verify", "acme-fix")).toBe("/acme-verify acme-fix");
    expect(formatInvocation("opencode", "acme-verify", "acme-fix")).toBe("@acme-verify acme-fix");
    expect(formatInvocation("codex", "acme-verify", "acme-fix")).toBe("$acme-verify acme-fix");
    expect(formatInvocation("pi", "acme-verify", "acme-fix")).toBe("/skill:acme-verify acme-fix");
    expect(formatInvocation("claude", "mate-publish-artifact")).toBe("/mate-publish-artifact");
  });
});

describe("parseInvocations", () => {
  test("reads numbered actions in any prefix, quotes dropped", () => {
    const section = [
      "## Next steps",
      "1. Review specs: openspec/changes/acme-fix/specs/",
      "2. After your review: /mate-apply-change acme-fix",
      "3. /acme-verify acme-fix",
      "4. @acme-lint `acme-fix`",
      '5. $acme-audit "acme-fix"',
      "6. /skill:acme-demo acme-fix",
      "7. /mate-publish-artifact",
    ].join("\n");

    expect(parseInvocations(section)).toEqual([
      { skill: "acme-verify", change: "acme-fix" },
      { skill: "acme-lint", change: "acme-fix" },
      { skill: "acme-audit", change: "acme-fix" },
      { skill: "acme-demo", change: "acme-fix" },
    ]);
  });

  test("a path is no invocation", () => {
    expect(parseInvocations("1. /openspec/changes acme-fix")).toEqual([]);
  });
});

describe("invokedSkill", () => {
  test("reads the invocation a prompt starts with, in any prefix", () => {
    expect(invokedSkill("/acme-verify acme-fix")).toEqual({
      skill: "acme-verify",
      change: "acme-fix",
    });
    expect(invokedSkill("  @acme-verify 'acme-fix' please")).toEqual({
      skill: "acme-verify",
      change: "acme-fix",
    });
    for (const prompt of ["$acme-verify acme-fix", "/skill:acme-verify acme-fix"]) {
      expect(invokedSkill(prompt)).toEqual({ skill: "acme-verify", change: "acme-fix" });
    }
    expect(invokedSkill("/acme-verify")).toBeUndefined();
    expect(invokedSkill("run /acme-verify acme-fix")).toBeUndefined();
  });
});

describe("namesInvocation", () => {
  const action = { skill: "acme-verify", change: "acme-fix" };

  test("finds the action after any prefix", () => {
    expect(namesInvocation("1. @acme-verify acme-fix", action)).toBe(true);
    expect(namesInvocation("1. /skill:acme-verify acme-fix", action)).toBe(true);
  });

  test("a longer change name or a bare skill name is no match", () => {
    expect(namesInvocation("1. /acme-verify acme-fix-2", action)).toBe(false);
    expect(namesInvocation("1. acme-verify acme-fix", action)).toBe(false);
  });
});
