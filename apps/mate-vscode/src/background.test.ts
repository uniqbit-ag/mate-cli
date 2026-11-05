import { describe, expect, test } from "bun:test";

import {
  backgroundedId,
  claudeAgents,
  claudeSupportsBackground,
  startClaudeBackground,
  stopClaude,
  stopOpenCode,
  type ShellRunner,
} from "./mate";

/** Answers each command line by its first matching prefix; records every call. */
function shell(routes: Array<[string, { code?: number; stdout?: string; stderr?: string }]>) {
  const calls: string[] = [];
  const envs = new Map<string, Record<string, string> | undefined>();
  const run: ShellRunner = async (command, _cwd, env) => {
    calls.push(command);
    envs.set(command, env);
    const route = routes.find(([prefix]) => command.startsWith(prefix))?.[1] ?? {};
    return { code: route.code ?? 0, stdout: route.stdout ?? "", stderr: route.stderr ?? "" };
  };
  return { run, calls, envs };
}

const agents = (entries: unknown[]) => JSON.stringify(entries);

describe("Claude background sessions", () => {
  test("reads the short id Claude prints", () => {
    expect(backgroundedId("Starting background service…\nbackgrounded · c25175db (idle)")).toBe(
      "c25175db",
    );
    expect(backgroundedId("nothing here")).toBeNull();
  });

  test("starts through mate and resolves the full session id", async () => {
    const { run, calls, envs } = shell([
      ["mate 'claude' '--' '--bg'", { stdout: "backgrounded · c25175db (idle)\n{}" }],
      [
        "claude agents",
        {
          stdout: agents([
            {
              id: "c25175db",
              sessionId: "c25175db-b143-438a",
              kind: "background",
              state: "blocked",
            },
          ]),
        },
      ],
    ]);
    expect(await startClaudeBackground("/w/acme", undefined, run)).toEqual({
      shortId: "c25175db",
      sessionId: "c25175db-b143-438a",
    });
    expect(calls).toContain("mate 'claude' '--' '--bg'");
    // Only the launch is marked: a daemon `claude agents` cold-starts must not inherit it.
    expect(envs.get("mate 'claude' '--' '--bg'")).toEqual({ MATE_SESSION_ORIGIN: "editor" });
    expect(envs.get("claude agents --json --all")).toBeUndefined();
  });

  test("resumes with --resume and falls back to the new agent in the directory", async () => {
    let listed = 0;
    const run: ShellRunner = async (command) => {
      if (command.startsWith("claude agents")) {
        listed += 1;
        const entries =
          listed === 1
            ? []
            : [{ id: "aa11bb22", sessionId: "aa11bb22-0000", kind: "background", cwd: "/w/acme" }];
        return { code: 0, stdout: agents(entries), stderr: "" };
      }
      expect(command).toBe("mate 'claude' '--' '--bg' '--resume' 'old-id'");
      return { code: 0, stdout: "{}", stderr: "" };
    };
    expect((await startClaudeBackground("/w/acme", "old-id", run)).sessionId).toBe("aa11bb22-0000");
  });

  test("a failing launch reports its last error line", async () => {
    const { run } = shell([
      ["claude agents", { stdout: "[]" }],
      ["mate", { code: 1, stderr: "mate: acme is not linked\nRun `mate companion link` first." }],
    ]);
    await expect(startClaudeBackground("/w/acme", undefined, run)).rejects.toThrow(
      "Run `mate companion link` first.",
    );
  });

  test("detects --bg support and tolerates a missing claude", async () => {
    expect(
      await claudeSupportsBackground(
        "/w",
        shell([["claude --help", { stdout: "  --bg, --background  Start" }]]).run,
      ),
    ).toBe(true);
    expect(
      await claudeSupportsBackground("/w", shell([["claude --help", { stdout: "  --print" }]]).run),
    ).toBe(false);
    expect(await claudeAgents("/w", shell([["claude", { code: 127 }]]).run)).toEqual([]);
    expect(
      await claudeAgents("/w", shell([["claude", { stdout: "profile noise\n[{}]" }]]).run),
    ).toEqual([]);
  });

  test("stop names the daemon id", async () => {
    const { run, calls } = shell([["claude stop", {}]]);
    await stopClaude("c25175db", "/w/acme", run);
    expect(calls).toEqual(["claude stop 'c25175db'"]);
  });
});

describe("OpenCode background sessions", () => {
  test("stop runs mate session stop and reports its error", async () => {
    const { run, calls } = shell([["mate 'session' 'stop'", { stdout: "{}" }]]);
    await stopOpenCode("ses_1", "/w/acme", run);
    expect(calls).toEqual(["mate 'session' 'stop' 'ses_1' '--json'"]);

    const failing = shell([
      ["mate", { code: 1, stderr: "mate: no Mate OpenCode server runs for session ses_1" }],
    ]);
    await expect(stopOpenCode("ses_1", "/w/acme", failing.run)).rejects.toThrow(
      "no Mate OpenCode server",
    );
  });
});
