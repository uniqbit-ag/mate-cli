import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PrintedHandoff } from "../runtime/workflow/turn";
import { HANDOFF_CHECK, registerTurnHook, turnResponse, type TurnHookDeps } from "./turn-hook";

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

const HANDOFF: PrintedHandoff = {
  handoff: "## Next steps\n1. @mate-submit-change acme-fix",
  actions: [{ skill: "mate-submit-change", change: "acme-fix" }],
};

interface Session {
  parentID?: string;
  directory: string;
  messages: unknown[];
}

function fakeApi(directory: string) {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  const hooks = new Map<string, (event: never) => void>();
  const sessions = new Map<string, Session>();
  const sent: { sessionID: string; text: string; description?: string; resume?: boolean }[] = [];
  const api = {
    location: { directory },
    session: {
      hook: async (name: string, handler: (event: never) => void) => void hooks.set(name, handler),
      get: async ({ sessionID }: { sessionID: string }) => {
        const session = sessions.get(sessionID)!;
        return { parentID: session.parentID, location: { directory: session.directory } };
      },
      context: async ({ sessionID }: { sessionID: string }) => sessions.get(sessionID)!.messages,
      synthetic: async (input: (typeof sent)[number]) => void sent.push(input),
    },
    tool: {
      hook: async (name: string, handler: (event: never) => void) => void hooks.set(name, handler),
    },
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        while (!signal.aborted) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            continue;
          }
          yield queue.shift();
        }
      },
    },
  };
  const emit = async (event: unknown) => {
    queue.push(event);
    wake?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const session = (id: string, init: Partial<Session> = {}) =>
    sessions.set(id, { directory, messages: [], ...init });
  const prompt = (sessionID: string, text: string) =>
    (hooks.get("prompt") as (event: unknown) => void)({
      sessionID,
      prompt: { text: `"${text}"`, files: [] },
    });
  const tool = (sessionID: string, name: string, input: unknown, status = "completed") =>
    (hooks.get("execute.after") as (event: unknown) => void)({
      sessionID,
      tool: name,
      input,
      status,
    });
  /** The turn's response, then the turn's end. */
  const finish = async (sessionID: string, response: string, type = "succeeded") => {
    sessions
      .get(sessionID)!
      .messages.push(
        { type: "user", text: "" },
        { type: "assistant", content: [{ type: "text", text: response }] },
      );
    await emit({ type: `session.execution.${type}`, data: { sessionID } });
  };
  return { api: api as never, emit, session, prompt, tool, finish, sent };
}

let root: string;
let companion: string;
let deps: TurnHookDeps;
let asked: string[];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "acme-oc-turn-"));
  companion = path.join(root, "companion");
  await fs.mkdir(path.join(companion, ".mate", "config"), { recursive: true });
  await fs.writeFile(path.join(companion, ".mate", "config", "workflow.yaml"), DECLARED);
  for (const change of ["acme-fix", "acme-login"]) {
    await fs.mkdir(path.join(companion, "openspec", "changes", change), { recursive: true });
  }
  asked = [];
  deps = {
    companionPath: companion,
    env: {},
    nextHandoff: async (change) => {
      asked.push(change);
      return change === "acme-fix" || change === "acme-login" ? HANDOFF : null;
    },
  };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function setup(directory = "/w/acme") {
  const fake = fakeApi(directory);
  const cleanup = await registerTurnHook(fake.api, deps);
  fake.session("ses_1");
  return { ...fake, cleanup };
}

describe("OpenCode turn hook", () => {
  test("sends a prose hand-off back once, marked and resumed", async () => {
    const { prompt, tool, finish, sent, cleanup } = await setup();
    prompt("ses_1", "@mate-apply-change acme-fix");
    tool("ses_1", "shell", { command: 'mate workflow done mate-apply-change "acme-fix"' });
    await finish("ses_1", "Done. The next step is @mate-submit-change acme-fix");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ sessionID: "ses_1", description: HANDOFF_CHECK, resume: true });
    expect(sent[0]!.text).toContain("## Next steps");
    expect(sent[0]!.text).toContain("@mate-submit-change acme-fix");

    // The resumed turn still lacks the section: nothing more.
    await finish("ses_1", "Still prose.");
    expect(sent).toHaveLength(1);
    cleanup();
  });

  test("sends nothing when the section is there", async () => {
    const { prompt, tool, finish, sent, cleanup } = await setup();
    prompt("ses_1", "@mate-apply-change acme-fix");
    tool("ses_1", "shell", { command: "mate workflow done mate-apply-change acme-fix" });
    await finish("ses_1", "Done.\n\n## Next steps\n1. @mate-submit-change acme-fix");
    expect(sent).toHaveLength(0);
    cleanup();
  });

  test("a section matching the printed actions passes, whatever the printed wording", async () => {
    deps.nextHandoff = async () => ({
      handoff: "## Next steps\n1. @acme-renamed acme-fix",
      actions: [{ skill: "mate-submit-change", change: "acme-fix" }],
    });
    const { prompt, tool, finish, sent, cleanup } = await setup();
    prompt("ses_1", "@mate-apply-change acme-fix");
    tool("ses_1", "shell", { command: "mate workflow done mate-apply-change acme-fix" });
    await finish("ses_1", "Done.\n\n## Next steps\n1. @mate-submit-change acme-fix");
    expect(sent).toHaveLength(0);
    cleanup();
  });

  test("an unreported companion step from the skill tool is sent back with its report", async () => {
    const { prompt, tool, finish, sent, cleanup } = await setup();
    prompt("ses_1", "run the security review for acme-login please");
    tool("ses_1", "skill", { id: "acme-security-review" });
    await finish("ses_1", "Review done.");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("@acme-security-review is a step");
    expect(sent[0]!.text).toContain('mate workflow done acme-security-review "acme-login"');
    cleanup();
  });

  test("a Mate stage skill without a report waits for the user, without asking mate", async () => {
    const { prompt, finish, sent, cleanup } = await setup();
    prompt("ses_1", "@mate-apply-change acme-fix");
    await finish("ses_1", "Which branch should I use?");
    expect(sent).toHaveLength(0);
    expect(asked).toEqual([]);
    cleanup();
  });

  test("a failed or interrupted turn sends nothing", async () => {
    for (const outcome of ["failed", "interrupted"]) {
      // oxlint-disable-next-line no-await-in-loop -- one fake session per outcome
      const { prompt, tool, finish, sent, cleanup } = await setup();
      prompt("ses_1", "@mate-apply-change acme-fix");
      tool("ses_1", "shell", { command: "mate workflow done mate-apply-change acme-fix" });
      // oxlint-disable-next-line no-await-in-loop -- sequential events
      await finish("ses_1", "Stopped.", outcome);
      expect(sent).toHaveLength(0);
      cleanup();
    }
  });

  test("a queued user prompt wins over the send-back", async () => {
    const { prompt, tool, finish, emit, sent, cleanup } = await setup();
    prompt("ses_1", "@mate-apply-change acme-fix");
    tool("ses_1", "shell", { command: "mate workflow done mate-apply-change acme-fix" });
    await emit({
      type: "session.inbox.enqueued",
      data: { sessionID: "ses_1", inboxID: "msg_q", item: { type: "user" } },
    });
    await finish("ses_1", "Done, prose only.");
    expect(sent).toHaveLength(0);
    cleanup();
  });

  test("a prompt queued while mate runs still wins over the send-back", async () => {
    let answer: (handoff: PrintedHandoff) => void = () => {};
    deps.nextHandoff = () => new Promise((resolve) => (answer = resolve));
    const { prompt, tool, finish, emit, sent, cleanup } = await setup();
    prompt("ses_1", "@mate-apply-change acme-fix");
    tool("ses_1", "shell", { command: "mate workflow done mate-apply-change acme-fix" });
    await finish("ses_1", "Done, prose only.");
    await emit({
      type: "session.inbox.enqueued",
      data: { sessionID: "ses_1", inboxID: "msg_q", item: { type: "user" } },
    });
    answer(HANDOFF);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent).toHaveLength(0);
    cleanup();
  });

  test("the skill tool finds a change of the declared type submit handles", async () => {
    await fs.writeFile(
      path.join(companion, ".mate", "config", "workflow.yaml"),
      `version: 1
artifacts:
  acme-notes:
    change: notes/{name}/
    published: [notes/index.md]
    publish:
      apply: { run: "acme-notes merge {change}" }
stages:
  - id: security-review
    steps: [{ skill: acme-security-review }]
  - id: submit
    artifact: acme-notes
    steps: [{ skill: mate-submit-change }]
  - id: publish
    steps: [{ skill: mate-publish-artifact }]
`,
    );
    await fs.mkdir(path.join(companion, "notes", "acme-glossary"), { recursive: true });
    // `archive` is no change, even where the built-in type keeps its archive.
    await fs.mkdir(path.join(companion, "openspec", "changes", "archive"), { recursive: true });
    deps.nextHandoff = async () => ({
      handoff: "## Next steps\n1. @mate-submit-change acme-glossary",
      actions: [{ skill: "mate-submit-change", change: "acme-glossary" }],
    });
    const { prompt, tool, finish, sent, cleanup } = await setup();
    prompt("ses_1", "review archive acme-fix acme-glossary");
    tool("ses_1", "skill", { id: "acme-security-review" });
    await finish("ses_1", "Reviewed.");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('mate workflow done acme-security-review "acme-glossary"');
    cleanup();
  });

  test("subagent sessions and sessions of another location are left alone", async () => {
    const { prompt, tool, finish, session, sent, cleanup } = await setup();
    session("ses_sub", { parentID: "ses_1" });
    session("ses_far", { directory: "/w/acme-api" });
    for (const id of ["ses_sub", "ses_far"]) {
      prompt(id, "@mate-apply-change acme-fix");
      tool(id, "shell", { command: "mate workflow done mate-apply-change acme-fix" });
      // oxlint-disable-next-line no-await-in-loop -- sequential events
      await finish(id, "Prose.");
    }
    expect(sent).toHaveLength(0);
    cleanup();
  });

  test("a new prompt starts a fresh turn that can be sent back again", async () => {
    const { prompt, tool, finish, sent, cleanup } = await setup();
    for (const _ of [1, 2]) {
      prompt("ses_1", "@mate-apply-change acme-fix");
      tool("ses_1", "shell", { command: "mate workflow done mate-apply-change acme-fix" });
      // oxlint-disable-next-line no-await-in-loop -- sequential events
      await finish("ses_1", "Prose.");
    }
    expect(sent).toHaveLength(2);
    cleanup();
  });

  test("MATE_TURN_HOOKS=off registers nothing", async () => {
    deps.env = { MATE_TURN_HOOKS: "off" };
    const { prompt, finish, sent, cleanup } = await setup();
    // No prompt hook was registered.
    expect(() => prompt("ses_1", "@mate-apply-change acme-fix")).toThrow();
    await finish("ses_1", "Prose.");
    expect(sent).toHaveLength(0);
    cleanup();
  });
});

describe("turnResponse", () => {
  test("is the assistant text after the last user or synthetic message", () => {
    const text = (value: string) => ({
      type: "assistant",
      content: [{ type: "text", text: value }],
    });
    expect(
      turnResponse([
        { type: "user" },
        text("old"),
        { type: "idle" },
        { type: "synthetic" },
        text("one"),
        { type: "assistant", content: [{ type: "reasoning", text: "hidden" }] },
        text("two"),
      ]),
    ).toBe("one\ntwo");
  });
});
