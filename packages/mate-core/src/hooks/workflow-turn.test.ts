import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import hooksJson from "../../claude-plugin/hooks/hooks.json";
import { defaultMateBin, parseNextHandoff } from "../runtime/workflow/next-handoff-process";
import type { PrintedHandoff } from "../runtime/workflow/turn";
import { mateHome } from "../runtime/runtime-directory";
import { appendTurnNote } from "../runtime/turn-state.mjs";
import { handleTurnEvent, type TurnDeps } from "./workflow-turn";

const DECLARED = `version: 1
stages:
  - id: security-review
    steps: [{ skill: acme-security-review }]
  - id: apply
    steps: [{ skill: mate-apply-change }]
  - id: submit
    artifact: openspec
    steps: [{ skill: mate-submit-change }]
  - id: publish
    steps: [{ skill: mate-publish-artifact }]
`;

let root: string;
let companion: string;
let deps: TurnDeps;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "acme-turn-"));
  companion = path.join(root, "companion");
  deps = {
    stateDir: path.join(root, "state"),
    resolveCompanion: async () => companion,
    // `mate workflow next`: only acme-fix has a folder.
    nextHandoff: (change) => (change === "acme-fix" ? HANDOFF : null),
  };
});

const HANDOFF: PrintedHandoff = {
  handoff: "## Next steps\n1. /mate-submit-change acme-fix",
  actions: [{ skill: "mate-submit-change", change: "acme-fix" }],
};

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function declare(source: string): Promise<void> {
  await fs.mkdir(path.join(companion, ".mate", "config"), { recursive: true });
  await fs.writeFile(path.join(companion, ".mate", "config", "workflow.yaml"), source);
}

/** A transcript whose last response is `response`. */
async function transcript(response: string): Promise<string> {
  const file = path.join(root, "transcript.jsonl");
  const entries = [
    { type: "user", message: { content: [{ type: "tool_result", content: "next: …" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: response }] } },
  ];
  await fs.writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  return file;
}

const event = (payload: Record<string, unknown>, env: Record<string, string> = {}) =>
  handleTurnEvent({ session_id: "s1", ...payload }, env, root, deps);

const prompt = (text: string) => event({ hook_event_name: "UserPromptSubmit", prompt: text });
const bash = (command: string) =>
  event({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command } });
const stop = async (response: string, again = false) =>
  event({
    hook_event_name: "Stop",
    stop_hook_active: again,
    transcript_path: await transcript(response),
  });
const output = (outcome: { stdout: string }) =>
  outcome.stdout ? (JSON.parse(outcome.stdout) as Record<string, string>) : null;

describe("parsing", () => {
  test("the printed hand-off: its section and its skill actions, a change-less one with an empty change", () => {
    const json = JSON.stringify({
      ok: true,
      handoff: "## Next steps\n1. Merge workset/acme-fix\n2. /mate-publish-artifact",
      actions: [
        { kind: "text", text: "Merge workset/acme-fix" },
        { kind: "skill", skill: "mate-publish-artifact" },
        { kind: "skill", skill: "acme-announce", change: "acme-fix", afterReview: true },
      ],
    });

    expect(parseNextHandoff(`Acme was repaired\n${json}\n`)).toEqual({
      handoff: "## Next steps\n1. Merge workset/acme-fix\n2. /mate-publish-artifact",
      actions: [
        { skill: "mate-publish-artifact", change: "" },
        { skill: "acme-announce", change: "acme-fix" },
      ],
    });
    // An older CLI prints no actions: nothing to check.
    const old = JSON.stringify({ ok: true, handoff: "## Next steps\n1. /acme-x acme-fix" });
    expect(parseNextHandoff(old)).toEqual({
      handoff: "## Next steps\n1. /acme-x acme-fix",
      actions: [],
    });
    expect(parseNextHandoff(JSON.stringify({ ok: true, handoff: "" }))).toBeNull();
    expect(parseNextHandoff("not json")).toBeNull();
  });
});

describe("a reported turn", () => {
  test("a response without the section is sent back once with the actions", async () => {
    await prompt("/mate-apply-change acme-fix");
    await bash('mate workflow done mate-apply-change "acme-fix"');

    const first = output(await stop("The next step is /mate-submit-change acme-fix."));
    expect(first?.decision).toBe("block");
    expect(first?.reason).toContain("## Next steps");
    expect(first?.reason).toContain("1. /mate-submit-change acme-fix");

    const second = output(await stop("Still prose.", true));
    expect(second?.decision).toBeUndefined();
    expect(second?.systemMessage).toContain("/mate-submit-change acme-fix");
  });

  test("a response with the section passes and ends the turn", async () => {
    await prompt("/mate-apply-change acme-fix");
    await bash('mate workflow done mate-apply-change "acme-fix"');

    expect(
      output(await stop("Done.\n\n## Next steps\n1. /mate-submit-change acme-fix")),
    ).toBeNull();
    // The state is gone: a later stop in the same session says nothing.
    expect(output(await stop("Prose."))).toBeNull();
  });

  test("the reports of parallel Bash calls are all kept", async () => {
    const asked: string[] = [];
    deps.nextHandoff = (change) => {
      asked.push(change);
      return null;
    };
    await prompt("/mate-apply-change acme-fix");
    await Promise.all(
      ["acme-fix", "acme-queue", "acme-slice-2"].map((change) =>
        bash(`mate workflow done mate-apply-change ${change}`),
      ),
    );

    await stop("Prose.");
    expect(asked.toSorted()).toEqual(["acme-fix", "acme-queue", "acme-slice-2"]);
  });

  test("the section is held to the hand-off after the change's last report", async () => {
    const asked: unknown[] = [];
    deps.nextHandoff = async (change, _folder, after) => {
      asked.push({ change, after });
      return after === "mate-submit-change"
        ? {
            handoff: "## Next steps\n1. /acme-announce acme-fix",
            actions: [{ skill: "acme-announce", change: "acme-fix" }],
          }
        : null;
    };
    await bash("mate workflow done acme-pr-check acme-fix");
    await bash("mate workflow done mate-submit-change acme-fix");

    expect(output(await stop("## Next steps\n1. /acme-announce acme-fix"))).toBeNull();
    expect(asked).toEqual([{ change: "acme-fix", after: "mate-submit-change" }]);
  });

  test("a shell loop's reports, as mate workflow done recorded them, win over the text", async () => {
    const asked: unknown[] = [];
    deps.nextHandoff = async (change, _folder, after) => {
      asked.push({ change, after });
      return change === "acme-fix" ? HANDOFF : null;
    };
    // A plain prompt: the state file only exists once the CLI notes a step.
    await prompt("Publish them.");
    await bash("mate workflow done mate-apply-change acme-fix");
    await bash(
      'for c in acme-fix acme-gone; do mate workflow done mate-publish-artifact "$c"; done',
    );
    const file = path.join(deps.stateDir!, "s1.json");
    for (const change of ["acme-fix", "acme-gone"]) {
      await appendTurnNote(file, { recorded: [{ skill: "mate-publish-artifact", change }] });
    }

    expect(output(await stop("## Next steps\n1. /mate-submit-change acme-fix"))).toBeNull();
    expect(asked).toEqual([
      { change: "acme-fix", after: "mate-publish-artifact" },
      { change: "acme-gone", after: "mate-publish-artifact" },
    ]);
    // Cleared at Stop, as the turn's own notes are.
    expect(await fs.readdir(deps.stateDir!)).toEqual([]);
  });

  test("a prompt clears what mate workflow done recorded in an earlier turn", async () => {
    const asked: string[] = [];
    deps.nextHandoff = (change) => {
      asked.push(change);
      return HANDOFF;
    };
    const file = path.join(deps.stateDir!, "s1.json");
    await appendTurnNote(file, { recorded: [{ skill: "mate-apply-change", change: "acme-fix" }] });
    await prompt("What does apply do?");
    expect(output(await stop("Prose."))).toBeNull();
    await appendTurnNote(file, { recorded: [{ skill: "mate-apply-change", change: "acme-fix" }] });
    await prompt("/mate-apply-change acme-fix");
    expect(output(await stop("It implements tasks."))).toBeNull();
    expect(asked).toEqual([]);
  });

  test("a state file that is not a turn's reads as no turn", async () => {
    await fs.mkdir(deps.stateDir!, { recursive: true });
    await fs.writeFile(
      path.join(deps.stateDir!, "s1.json"),
      '{"step":"x","reports":[1,{"skill":2}]}',
    );
    expect(output(await stop("Prose."))).toBeNull();
  });
});

describe("a turn without a report", () => {
  test("a step started through the Skill tool counts too", async () => {
    await declare(DECLARED);
    await prompt("review it please");
    await event({
      hook_event_name: "PostToolUse",
      tool_name: "Skill",
      tool_input: { skill: "acme-security-review", args: "acme-fix" },
    });

    expect(output(await stop("Reviewed."))?.decision).toBe("block");
  });

  test("Skill tool arguments that name no change start no step", async () => {
    await declare(DECLARED);
    const asked: string[] = [];
    deps.nextHandoff = (change) => {
      asked.push(change);
      return HANDOFF;
    };
    await prompt("review it please");
    for (const args of ["--after mate-submit-change", "$(id)"]) {
      await event({
        hook_event_name: "PostToolUse",
        tool_name: "Skill",
        tool_input: { skill: "acme-security-review", args },
      });
    }

    expect(output(await stop("Reviewed."))).toBeNull();
    expect(asked).toEqual([]);
  });

  test("a turn that starts no step leaves no state behind", async () => {
    await prompt("/mate-apply-change acme-fix");
    await prompt("What does apply do?");
    expect(await fs.readdir(deps.stateDir!)).toEqual([]);
    await prompt("/mate-apply-change acme-fix");
    expect(output(await stop("It implements tasks."))).toBeNull();
    expect(await fs.readdir(deps.stateDir!)).toEqual([]);
  });
});

describe("the switch and the plugin", () => {
  test("MATE_TURN_HOOKS=off turns the hook off", async () => {
    const off = { MATE_TURN_HOOKS: "off" };
    await event(
      { hook_event_name: "UserPromptSubmit", prompt: "/mate-apply-change acme-fix" },
      off,
    );
    await event(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "mate workflow done mate-apply-change acme-fix" },
      },
      off,
    );
    const outcome = await event(
      { hook_event_name: "Stop", transcript_path: await transcript("Prose.") },
      off,
    );
    expect(outcome.stdout).toBe("");
    expect(await fs.readdir(deps.stateDir!).catch(() => [])).toEqual([]);
  });

  test("the shim runs under node's type stripping, as Claude Code starts it", async () => {
    const shim = path.join(import.meta.dirname, "../../claude-plugin/hooks/workflow-turn.mjs");
    const session = `acme-shim-${process.pid}`;
    // A `mate` that answers `workflow next --json` as the CLI does after repairing its runtime:
    // with lines of its own before the JSON.
    const bin = path.join(root, "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(
      path.join(bin, "mate"),
      `#!/bin/sh\necho 'Acme was not installed'\necho '  Checked: acme'\nprintf '%s\\n' '${JSON.stringify({ ok: true, handoff: HANDOFF.handoff, actions: HANDOFF.actions.map((action) => ({ kind: "skill", ...action })) })}'\n`,
      { mode: 0o755 },
    );
    const send = (payload: Record<string, unknown>, args: string[] = []) =>
      spawnSync("node", [shim, ...args], {
        input: JSON.stringify({ session_id: session, ...payload }),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          MATE_ARTIFACT_PATH: companion,
          MATE_TURN_HOOKS: "",
        },
      });

    send({ hook_event_name: "UserPromptSubmit", prompt: "/mate-apply-change acme-fix" });
    // A command that reports no step is answered before the module loads.
    const other = send({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    expect(other).toMatchObject({ status: 0, stdout: "", stderr: "" });
    send({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "mate workflow done mate-apply-change acme-fix" },
    });
    const stopPayload = { hook_event_name: "Stop", transcript_path: await transcript("Prose.") };
    // A wrap's copy yields under a launch, where the plugin's copy runs.
    expect(send(stopPayload, ["--projected"]).stdout).toBe("");
    const result = send(stopPayload);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).decision).toBe("block");
    const state = path.join(mateHome(), "turn-hooks", `${session}.json`);
    expect(await fs.stat(state).then(() => true)).toBe(true);

    // A prompt that starts no skill clears the turn before the module loads; the stop then has
    // nothing to check.
    expect(send({ hook_event_name: "UserPromptSubmit", prompt: "What next?" })).toMatchObject({
      status: 0,
      stdout: "",
      stderr: "",
    });
    expect(await fs.stat(state).catch(() => null)).toBeNull();
    expect(send(stopPayload)).toMatchObject({ status: 0, stdout: "", stderr: "" });
    await fs.rm(state, { force: true });
  });

  test("a relative PATH entry is never the mate the hook runs", async () => {
    const bin = path.join(root, "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "mate"), "#!/bin/sh\n", { mode: 0o755 });
    const relative = path.relative(process.cwd(), bin);

    expect(defaultMateBin({ PATH: relative })).not.toBe(path.join(relative, "mate"));
    expect(defaultMateBin({ PATH: `${relative}${path.delimiter}${bin}` })).toBe(
      path.join(bin, "mate"),
    );
  });

  test("hooks.json carries the turn hook on its three events", () => {
    const hooks = (hooksJson as { hooks: Record<string, unknown[]> }).hooks;
    const group = (matcher?: string) => ({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/workflow-turn.mjs"' }],
    });
    expect(hooks.UserPromptSubmit).toContainEqual(group());
    expect(hooks.PostToolUse).toContainEqual(group("Skill|Bash"));
    expect(hooks.Stop).toContainEqual(group());
  });
});
