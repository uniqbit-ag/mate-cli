import { beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RunStore } from "./state";
import { Run } from "./run";

/** What the turn handed the harness, captured by the mocked `HarnessAgent`. */
let constructed: Record<string, unknown>[] = [];
let sessions: Record<string, unknown>[] = [];
let duringTurn: (() => Promise<void>) | undefined;
/** The stream parts the mocked agent yields, after running the tool calls it is given. */
let script: { calls: [string, unknown][]; parts: { type: string }[] } = { calls: [], parts: [] };

mock.module("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    constructor(private readonly options: Record<string, unknown>) {
      constructed.push(options);
    }
    async createSession(options: Record<string, unknown>) {
      sessions.push(options);
      return { stop: async () => ({ claudeSessionId: "acme-session" }) };
    }
    async stream() {
      await duringTurn?.();
      const tools = this.options.tools as Record<string, { execute: (input: unknown) => unknown }>;
      for (const [name, input] of script.calls) {
        // oxlint-disable-next-line no-await-in-loop -- tool calls run in order
        await tools[name]!.execute(input);
      }
      const parts = script.parts;
      return {
        fullStream: (async function* () {
          yield* parts;
        })(),
      };
    }
  },
}));
mock.module("@ai-sdk/harness-claude-code", () => ({ createClaudeCode: () => ({}) }));

const { createHarnessStageAgent, factoryRunInstructions } = await import("./harness-agent");

let dir: string;

beforeEach(async () => {
  constructed = [];
  sessions = [];
  duringTurn = undefined;
  script = { calls: [], parts: [{ type: "finish", finishReason: "stop" } as { type: string }] };
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "acme-harness-turn-"));
  await fs.writeFile(path.join(dir, "AGENTS.md"), "Acme companion rules.\n");
});

function stageAgent(runs: Run) {
  return createHarnessStageAgent({
    client: {} as never,
    attachSocket: "/run/acme.sock",
    runs,
    // An empty companion: no Workset records.
    companionPath: dir,
    worktreeOf: (id) => `/worktrees/${id}`,
    home: "/home/mate",
  });
}

function turn(runs: Run, prompt = "/mate-clarify-intent Acme greeting") {
  return stageAgent(runs).turn({
    worksetId: "acme-ws",
    prompt,
    signal: new AbortController().signal,
    onText: () => {},
  });
}

describe("a factory turn's harness settings", () => {
  test("register ask_human, deactivate Claude's own question tool and carry the whole policy", async () => {
    const runs = new Run(new RunStore(dir));
    expect(await turn(runs)).toEqual({ kind: "done" });
    const [options] = constructed;
    expect(Object.keys(options!.tools as object).toSorted()).toEqual([
      "ask_human",
      "report_situation",
    ]);
    expect(options!.inactiveTools).toEqual(["askUserQuestions"]);
    expect(options!.instructions).toContain("Acme companion rules.");
    expect(options!.instructions).toEndWith(`\n\n${factoryRunInstructions()}`);
    expect(sessions[0]).not.toHaveProperty("resumeFrom");
  });

  test("an unmodified custom skill runs with the policy and ask_human", async () => {
    const skill = path.join(dir, ".claude", "skills", "acme-review");
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(
      path.join(skill, "SKILL.md"),
      "---\ndescription: Review acme changes with a person.\n---\nAsk the person which risks matter.\n",
    );
    await turn(new Run(new RunStore(dir)));
    const [options] = constructed;
    expect(options!.skills as { name: string; content: string }[]).toEqual([
      expect.objectContaining({
        name: "acme-review",
        content: "Ask the person which risks matter.\n",
      }),
    ]);
    expect(options!.instructions).toEndWith(factoryRunInstructions());
    expect(options!.tools).toHaveProperty("ask_human");
  });

  test("a resumed turn resumes the saved session with the same policy", async () => {
    const runs = new Run(new RunStore(dir));
    await turn(runs);
    expect(await runs.resume("acme-ws")).toEqual({ claudeSessionId: "acme-session" });
    await turn(runs, "Answers: English only");
    expect(sessions[1]).toMatchObject({ resumeFrom: { claudeSessionId: "acme-session" } });
    expect(constructed[1]!.instructions).toBe(constructed[0]!.instructions);
    expect(constructed[1]!.inactiveTools).toEqual(["askUserQuestions"]);
  });

  test("turn completion preserves a report stored during the turn and records its stage", async () => {
    const runs = new Run(new RunStore(dir));
    await runs.start("acme-ws", "propose");
    duringTurn = () => runs.rememberReview("acme-ws", "acme-change", "report-1");
    script.calls = [
      [
        "report_situation",
        { situation: "Acme is ready.", checks: [{ name: "acme tests", passed: true }] },
      ],
    ];
    await turn(runs);
    expect((await runs.facts("acme-ws")).memory).toMatchObject({
      reviewReports: { "acme-change": "report-1" },
      situations: [
        {
          text: "Acme is ready.",
          stage: "propose",
          at: expect.any(String),
          checks: [{ name: "acme tests", passed: true }],
        },
      ],
    });
    expect(await runs.resume("acme-ws")).toEqual({ claudeSessionId: "acme-session" });
  });

  test("a question asked in prose creates no waiting state", async () => {
    const runs = new Run(new RunStore(dir));
    script.parts = [
      { type: "text-delta", text: "Which launch languages do you want?" },
      { type: "finish", finishReason: "stop" },
    ] as { type: string }[];
    expect(await turn(runs)).toEqual({ kind: "done" });
  });

  test("only an ask_human call ends the turn on questions", async () => {
    const runs = new Run(new RunStore(dir));
    script.calls = [
      [
        "ask_human",
        {
          questions: [
            { question: "Launch languages?", options: ["English only", "English and German"] },
          ],
        },
      ],
    ];
    expect(await turn(runs)).toEqual({
      kind: "question",
      questions: [
        { question: "Launch languages?", options: ["English only", "English and German"] },
      ],
    });
  });
});

describe("the factory asking policy", () => {
  test("needs no skill reference and covers asking, assumptions and situations", () => {
    const policy = factoryRunInstructions();
    expect(policy).not.toContain("reference");
    expect(policy).toContain("Never use the runtime's own question tool");
    expect(policy).toContain("only through ask_human");
    expect(policy).toContain("every question you can already ask in one call");
    expect(policy).toContain("2-4 short options and the one you recommend");
    expect(policy).toContain("Ask only for authorization, missing facts");
    expect(policy).toContain("Assumed: <choice> (<why>)");
    expect(policy).toContain("report_situation");
    expect(policy).toContain("waits for a person's Approve");
  });
});
