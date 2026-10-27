import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { CompanionInstructions } from "../runtime/companion-instructions";
import { writeProjectionPair } from "../runtime/projection";
import { PROJECTED_FLAG } from "../runtime/projected-flag";
import { repoLocalRegistryPath } from "../runtime/repo-local";
import {
  instructionHookPayload,
  type InstructionHookDeps,
  type InstructionHookInput,
} from "./companion-instructions";
import { hookOutcome, type HookOutcome } from "./hook-io";

const tempRoots: string[] = [];
const RULE = "Code comments: JSDoc format only, never `//`.";
const SENTINEL = "ACME-SENTINEL-7f3a";

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  repoRoot: string;
  companionPath: string;
  launchEnv: Record<string, string>;
}

function wrappedRepo(
  options: { agentsMd?: boolean; projectedRepositoryPath?: string } = {},
): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acme-instruction-hook-"));
  tempRoots.push(root);
  const repoRoot = path.join(root, "working");
  const companionPath = path.join(root, "companion");
  fs.mkdirSync(companionPath, { recursive: true });
  if (options.agentsMd !== false) {
    fs.writeFileSync(
      path.join(companionPath, "AGENTS.md"),
      `<!-- MATE:COMPANION:START -->\n\n- ${RULE}\n\n<!-- MATE:COMPANION:END -->\n\n## Notes\n\n${SENTINEL} in $MATE_REPO_PATH\n`,
    );
  }

  const registryPath = repoLocalRegistryPath(repoRoot);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, "companions: []\n", "utf8");
  const wrapperBinPath = path.join(companionPath, ".mate", "wrappers", "bin");
  writeProjectionPair(repoRoot, {
    stamp: "stamp",
    projection: {
      version: "0.0.0",
      companionPath,
      repositoryPath: options.projectedRepositoryPath ?? repoRoot,
      repositoryId: "acme",
      wrapperBinPath,
      reactDoctorBinPath: path.join(companionPath, "react-doctor"),
      graphifyOut: path.join(companionPath, ".graphify", "acme", "graphify-out"),
    },
  });

  return {
    repoRoot,
    companionPath,
    launchEnv: {
      MATE_ARTIFACT_PATH: companionPath,
      MATE_REPO_PATH: repoRoot,
      MATE_REPO_ID: "acme",
      MATE_WRAPPER_BIN_PATH: wrapperBinPath,
    },
  };
}

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

/** `source` is part of Claude Code's payload; the hook reads past it. */
const sessionStart = (source = "startup"): InstructionHookInput & { source: string } => ({
  hook_event_name: "SessionStart",
  source,
});
const subagentStart = (agentType = "general-purpose"): InstructionHookInput => ({
  hook_event_name: "SubagentStart",
  agent_type: agentType,
});

/** The plugin's copies run bare; both copies the wrap carries hold the flag. */
const PLUGIN: readonly string[] = [];
const WRAPPED: readonly string[] = [PROJECTED_FLAG];
const BOTH_COPIES = [PLUGIN, WRAPPED];

function outcome(
  env: Record<string, string | undefined>,
  cwd: string,
  argv: readonly string[],
  input: unknown,
  deps?: InstructionHookDeps,
): HookOutcome {
  return hookOutcome(instructionHookPayload({ env, cwd, argv, input }, deps));
}

function parsed(stdout: string): {
  hookSpecificOutput?: { hookEventName: string; additionalContext: string };
  systemMessage?: string;
} {
  return JSON.parse(stdout);
}

describe("companion-instructions hook in a Claude-wrapped plain session", () => {
  test.each(["startup", "compact", "resume", "clear"])(
    "the wrap's SessionStart copy emits the instructions as their own output on %s",
    (source) => {
      const { repoRoot } = wrappedRepo();

      const result = outcome({}, repoRoot, WRAPPED, sessionStart(source));

      expect(result.exitCode).toBe(0);
      const output = parsed(result.stdout).hookSpecificOutput!;
      expect(output.hookEventName).toBe("SessionStart");
      expect(output.additionalContext.startsWith("<companion-instructions ")).toBe(true);
      expect(output.additionalContext).toContain(RULE);
      expect(output.additionalContext).toContain(`${SENTINEL} in ${repoRoot}`);
      expect(output.additionalContext).not.toContain("<companion-policy");
      expect(parsed(result.stdout).systemMessage).toBeUndefined();
    },
  );

  /** A plain session that loads the plugin through `--plugin-dir` runs both copies. */
  test("a plugin SessionStart copy without a launch stays silent: the wrap's copy owns it", () => {
    const { repoRoot } = wrappedRepo();

    expect(outcome({}, repoRoot, PLUGIN, sessionStart()).stdout).toBe("");
  });

  test("the wrap's SubagentStart copy emits for a general-purpose subagent", () => {
    const { repoRoot } = wrappedRepo();

    const result = outcome({}, repoRoot, WRAPPED, subagentStart());

    const output = parsed(result.stdout).hookSpecificOutput!;
    expect(output.hookEventName).toBe("SubagentStart");
    expect(output.additionalContext).toContain(SENTINEL);
  });

  test("a plugin SubagentStart copy without a launch stays silent: the wrap's owns it", () => {
    const { repoRoot } = wrappedRepo();

    expect(outcome({}, repoRoot, PLUGIN, subagentStart()).stdout).toBe("");
  });

  test.each(["Explore", "Plan", "fork"])("a %s subagent gets no copy", (agentType) => {
    const { repoRoot } = wrappedRepo();

    const result = outcome({}, repoRoot, WRAPPED, subagentStart(agentType));

    expect(result.stdout).toBe("");
  });

  test("prefers the hook input's cwd, so a subagent in another checkout reads its own", () => {
    const { repoRoot } = wrappedRepo();
    const elsewhere = tempDir("acme-unwrapped-");

    const fromInput = outcome({}, elsewhere, WRAPPED, {
      ...sessionStart(),
      cwd: repoRoot,
    });

    expect(fromInput.stdout).toContain(SENTINEL);
  });

  test("names the directory whose projection resolved as the repository, so a worktree names itself", () => {
    const mainCheckout = tempDir("acme-main-checkout-");
    const { repoRoot } = wrappedRepo({ projectedRepositoryPath: mainCheckout });

    const result = outcome({}, repoRoot, WRAPPED, sessionStart());

    const context = parsed(result.stdout).hookSpecificOutput!.additionalContext;
    expect(context).toContain(`${SENTINEL} in ${repoRoot}`);
    expect(context).not.toContain(mainCheckout);
  });

  test("a missing AGENTS.md gives one factual context line and a system message", () => {
    const { repoRoot, companionPath } = wrappedRepo({ agentsMd: false });

    const result = outcome({}, repoRoot, WRAPPED, sessionStart());

    const line = `Companion instructions unavailable: ${path.join(companionPath, "AGENTS.md")} not found`;
    const output = parsed(result.stdout);
    expect(output.hookSpecificOutput!.additionalContext).toBe(line);
    expect(output.systemMessage).toBe(line);
    expect(result.exitCode).toBe(0);
  });

  test("an oversized managed block is still delivered, with a system message naming the file", () => {
    const { repoRoot, companionPath } = wrappedRepo();
    const source = path.join(companionPath, "AGENTS.md");
    const text = `<companion-instructions source="${source}">\n${RULE}\n</companion-instructions>`;
    const oversized = (): CompanionInstructions => ({
      kind: "available",
      source,
      text,
      omitted: [],
      oversized: true,
    });

    const result = outcome({}, repoRoot, WRAPPED, sessionStart(), {
      read: oversized,
    });

    const output = parsed(result.stdout);
    expect(output.hookSpecificOutput!.additionalContext).toBe(text);
    expect(output.systemMessage).toBe(
      `mate: the MATE:COMPANION block in ${source} leaves no room within the 9,000-character budget, so the instructions exceed it; Claude Code may deliver them as a file preview. Shorten the block.`,
    );
    expect(result.exitCode).toBe(0);
  });
});

describe("companion-instructions hook under a launch environment", () => {
  /** The channel a plain session uses, so a conversation resumed through the other launcher holds one copy. */
  test("the wrap's SessionStart copy delivers the main thread's instructions, as in a plain session", () => {
    const { repoRoot, launchEnv } = wrappedRepo();

    const result = outcome(launchEnv, repoRoot, WRAPPED, sessionStart());

    const output = parsed(result.stdout).hookSpecificOutput!;
    expect(output.hookEventName).toBe("SessionStart");
    expect(output.additionalContext).toContain(RULE);
    expect(output.additionalContext).toContain(`${SENTINEL} in ${repoRoot}`);
  });

  test("the plugin's SessionStart copy is silent, so a launch gets one copy", () => {
    const { repoRoot, launchEnv } = wrappedRepo();

    expect(outcome(launchEnv, repoRoot, PLUGIN, sessionStart()).stdout).toBe("");
  });

  test("the plugin's SubagentStart copy emits in a launch with a Working Repository", () => {
    const { repoRoot, launchEnv } = wrappedRepo();

    const result = outcome(launchEnv, repoRoot, PLUGIN, subagentStart());

    const output = parsed(result.stdout).hookSpecificOutput!;
    expect(output.hookEventName).toBe("SubagentStart");
    expect(output.additionalContext).toContain(RULE);
    expect(output.additionalContext).toContain(`${SENTINEL} in ${repoRoot}`);
  });

  test("a partial launch environment is not completed from a projection that names another companion", () => {
    const { repoRoot, launchEnv } = wrappedRepo();
    const { MATE_ARTIFACT_PATH: _companion, ...partial } = launchEnv;

    for (const input of [sessionStart(), subagentStart()]) {
      const argv = input.hook_event_name === "SessionStart" ? WRAPPED : PLUGIN;
      expect(outcome(partial, repoRoot, argv, input).stdout).toBe("");
    }
  });

  test("a managed subagent outside any projection reads the launch environment", () => {
    const { repoRoot, launchEnv } = wrappedRepo();
    const elsewhere = tempDir("acme-no-projection-");

    const result = outcome(launchEnv, elsewhere, PLUGIN, subagentStart());

    expect(parsed(result.stdout).hookSpecificOutput!.additionalContext).toContain(
      `${SENTINEL} in ${repoRoot}`,
    );
  });

  test("the wrap's SubagentStart copy is silent, so a managed subagent gets one copy", () => {
    const { repoRoot, launchEnv } = wrappedRepo();

    expect(outcome(launchEnv, repoRoot, WRAPPED, subagentStart()).stdout).toBe("");
  });

  /** Run where a projection resolves, so silence can only come from the owners being native memory. */
  test("a companion-scoped launch leaves both events to native memory, even where a projection resolves", () => {
    const { repoRoot, launchEnv } = wrappedRepo();
    const { MATE_REPO_PATH: _path, MATE_REPO_ID: _id, ...companionEnv } = launchEnv;

    for (const argv of BOTH_COPIES) {
      for (const input of [sessionStart(), subagentStart()]) {
        expect(outcome(companionEnv, repoRoot, argv, input).stdout).toBe("");
      }
    }
  });

  test("a missing AGENTS.md in a managed subagent is still reported", () => {
    const { repoRoot, launchEnv } = wrappedRepo({ agentsMd: false });

    const output = parsed(outcome(launchEnv, repoRoot, PLUGIN, subagentStart()).stdout);

    expect(output.hookSpecificOutput!.additionalContext).toStartWith(
      "Companion instructions unavailable:",
    );
    expect(output.systemMessage).toStartWith("Companion instructions unavailable:");
  });
});

describe("companion-instructions hook where nothing resolves", () => {
  test("no projection: silent", () => {
    const dir = tempDir("acme-no-projection-");

    expect(outcome({}, dir, WRAPPED, sessionStart()).stdout).toBe("");
    expect(outcome({}, dir, WRAPPED, subagentStart()).stdout).toBe("");
  });

  test("a session in the companion itself resolves no projection, so both copies are silent", () => {
    const { companionPath } = wrappedRepo();

    for (const argv of BOTH_COPIES) {
      expect(outcome({}, companionPath, argv, sessionStart()).stdout).toBe("");
      expect(outcome({}, companionPath, argv, subagentStart()).stdout).toBe("");
    }
  });

  test("an event it does not handle: silent", () => {
    const { repoRoot } = wrappedRepo();

    expect(outcome({}, repoRoot, WRAPPED, { hook_event_name: "Stop" }).stdout).toBe("");
    expect(outcome({}, repoRoot, WRAPPED, {}).stdout).toBe("");
  });
});

describe("companion-instructions hook on a malformed payload or a failing reader", () => {
  test("a non-string cwd reads as absent: exit zero and the process cwd's instructions", () => {
    const { repoRoot } = wrappedRepo();

    const result = outcome({}, repoRoot, WRAPPED, {
      hook_event_name: "SessionStart",
      cwd: 42,
    });

    expect(result.exitCode).toBe(0);
    expect(parsed(result.stdout).hookSpecificOutput!.additionalContext).toContain(SENTINEL);
  });

  test("other non-string fields and non-object payloads read as absent", () => {
    const { repoRoot } = wrappedRepo();

    const noEvent = outcome({}, repoRoot, WRAPPED, { hook_event_name: 7 });
    expect(noEvent).toEqual({ exitCode: 0, stdout: "" });

    const noAgent = outcome({}, repoRoot, WRAPPED, {
      hook_event_name: "SubagentStart",
      agent_type: ["Explore"],
    });
    expect(parsed(noAgent.stdout).hookSpecificOutput!.additionalContext).toContain(SENTINEL);

    for (const payload of [null, "SessionStart", 42]) {
      expect(outcome({}, repoRoot, WRAPPED, payload)).toEqual({
        exitCode: 0,
        stdout: "",
      });
    }
  });

  test("a throwing reader exits zero and reports the failure as a system message only", () => {
    const { repoRoot } = wrappedRepo();
    const throwing = (): CompanionInstructions => {
      throw new Error("disk on fire");
    };

    const result = outcome({}, repoRoot, WRAPPED, sessionStart(), {
      read: throwing,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      systemMessage: "mate: companion instructions hook failed: disk on fire",
    });
  });
});
