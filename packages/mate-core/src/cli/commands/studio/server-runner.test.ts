/** @test-requires sockets */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { rankOf } from "../../../lib/factory/runner/rank";
import { Run } from "../../../lib/factory/runner/run";
import { FactoryRunner } from "../../../lib/factory/runner/scheduler";
import { RunStore } from "../../../lib/factory/runner/state";
import type { StageAgent } from "../../../lib/factory/runner/workflow";
import { advanceWorkset, readWorksets } from "../../../lib/workset/record";
import { factoryOutcomes } from "../../../lib/factory/outcomes";
import type { StudioCompanionPayload, StudioWorkset } from "./payload";
import { companionDigest } from "./selection";
import { createStudioFetch } from "./server";

let root: string;
let companion: string;
let runs: Run;
let prompts: string[];
let stage: StudioWorkset["stage"];

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-studio-runner-")));
  companion = path.join(root, "acme-companion");
  fs.mkdirSync(path.join(companion, "worksets"), { recursive: true });
  fs.mkdirSync(path.join(companion, "openspec", "changes"), { recursive: true });
  fs.writeFileSync(
    path.join(companion, "worksets", "acme-login.yaml"),
    "id: acme-login\ntitle: Login\nrepositories: [acme/web]\nstage: explore\n",
  );
  runs = new Run(new RunStore(path.join(root, "runs")));
  prompts = [];
  stage = "explore";
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function handlerFor(options: { runner?: boolean; writable?: boolean } = {}) {
  // Bound now: a pickup the last test's run left behind must not reach this test's state.
  const home = companion;
  const seen = prompts;
  const stateDir = root;
  const agent: StageAgent = {
    turn: async ({ prompt }) => {
      seen.push(prompt);
      return { kind: "question", questions: [{ question: "Which login provider?" }] };
    },
  };
  const runner = new FactoryRunner({
    runs,
    maxRuns: 2,
    stageMs: 60_000,
    rankFor: async (id) => {
      const record = (await readWorksets(home)).worksets.find((entry) => entry.id === id);
      return record ? rankOf(record) : null;
    },
    recordFor: async (id) => (await readWorksets(home)).worksets.find((entry) => entry.id === id),
    depsFor: () => ({
      companionPath: home,
      stateDir,
      agent,
      run: async () => ({ status: 0, stdout: "", stderr: "" }),
    }),
  });
  const payload = (): StudioCompanionPayload => ({
    companionPath: home,
    changes: [],
    specs: [],
    shipped: [],
    topology: null,
    worksets: [
      {
        id: "acme-login",
        title: "Login",
        intent: "",
        repositories: ["acme/web"],
        changes: [],
        stage,
        stageLabel: stage,
        turn: "human",
        problems: [],
      },
    ],
    linkedRepositories: [],
    worksetProblems: [],
    warnings: [],
  });
  const handler = createStudioFetch(
    {
      collectStudioInventory: async () => ({
        companions: [{ path: home, health: "ready", pairings: [] }],
      }),
      assembleCompanionPayload: async () => payload(),
      worksetStages: async () => ({
        worksets: (await readWorksets(home)).worksets.map((record) => ({
          record,
          derived: { stage, label: stage, turn: "human" as const, problems: [] },
        })),
      }),
      factoryOutcomes: (portsFor) =>
        options.runner === false
          ? null
          : factoryOutcomes({
              ...portsFor(home),
              runner,
              runs,
              companionPath: home,
              client: { list: async () => [], delete: async () => {} },
            }),
    },
    { writable: options.writable ?? true },
  );
  /** One board action on the Outcome, as Studio's factory server function calls it. */
  const act = (action: string, fields: Record<string, string> = {}) =>
    handler.services.worksetAction(
      companionDigest(home),
      "acme-login",
      action,
      (name) => fields[name] ?? "",
    );
  return { handler, runner, act };
}

describe("the board's runner actions", () => {
  test("no stage is set by hand: advance is an unknown action", async () => {
    const { handler, runner, act } = handlerFor();
    await expect(act("advance")).rejects.toThrow();
    expect((await readWorksets(companion)).worksets[0]?.stage).toBe("explore");
    expect(runner.isActive("acme-login")).toBe(false);
    expect(prompts).toEqual([]);
    handler.close();
  });

  test("starting a ready Later Outcome runs propose by itself", async () => {
    const { handler, runner, act } = handlerFor();
    await advanceWorkset(companion, "acme-login");
    await act("start");
    await runner.idle("acme-login");
    expect(prompts[0]).toStartWith("/mate-propose-change");
    expect((await runs.facts("acme-login")).execution).toMatchObject({
      state: "waiting",
      questions: [{ question: "Which login provider?" }],
    });
    handler.close();
  });

  test("an answer starts the next turn with the person's text", async () => {
    const { handler, runner, act } = handlerFor();
    await runs.wait("acme-login", "propose", [{ question: "?" }]);
    const waiting = (await runs.facts("acme-login")).execution;
    const round = waiting.state === "waiting" ? waiting.round! : "";
    await act("answer", { answer: "Use the company IdP.", round });
    await runner.idle("acme-login");
    expect(prompts[0]).toBe("Use the company IdP.");
    handler.close();
  });

  test("grouped answers are read from the per-question fields", async () => {
    const { handler, runner, act } = handlerFor();
    await runs.wait("acme-login", "propose", [
      { question: "Provider?", options: ["SAML", "OIDC"] },
      { question: "Old page?" },
    ]);
    const waiting = (await runs.facts("acme-login")).execution;
    const round = waiting.state === "waiting" ? waiting.round! : "";
    await act("answer", {
      round,
      "choice-0": "OIDC",
      "answer-0": "",
      "choice-1": "Keep it",
      // Own words override the choice.
      "answer-1": "Remove it.",
    });
    await runner.idle("acme-login");
    expect(prompts[0]).toBe("1. Provider?\nAnswer: OIDC\n\n2. Old page?\nAnswer: Remove it.");
    handler.close();
  });

  test("an answer without its round, or to an answered round, starts nothing", async () => {
    const { handler, runner, act } = handlerFor();
    await runs.wait("acme-login", "propose", [{ question: "?" }]);
    await expect(act("answer", { answer: "OIDC" })).rejects.toThrow("names no question round");
    await expect(act("answer", { answer: "OIDC", round: "acme-old" })).rejects.toThrow(
      "already answered",
    );
    expect(runner.isActive("acme-login")).toBe(false);
    expect(prompts).toEqual([]);
    handler.close();
  });

  test("pickup leaves an Outcome a person has control of", async () => {
    const { handler, runner, act } = handlerFor();
    await runs.control.take("acme-login", false, async () => []);
    await advanceWorkset(companion, "acme-login");
    await act("start");
    expect(runner.isActive("acme-login")).toBe(false);
    expect(prompts).toEqual([]);
    handler.close();
  });

  test("Take control needs a saved conversation, then fences the Outcome", async () => {
    const { handler, runner, act } = handlerFor();
    await expect(act("take-control")).rejects.toThrow("no factory conversation to take over");
    await runs.saveTurn("acme-login", {
      type: "claude-code",
      data: { claudeSessionId: "2a41e812-a0fa-4908-a871-6df87d4ea2bc" },
    });
    await act("take-control");
    expect((await runs.facts("acme-login")).control.mode).toBe("manual");
    // Start picks up started Outcomes; a fenced one stays idle.
    await act("start");
    expect(runner.isActive("acme-login")).toBe(false);
    handler.close();
  });

  test("Return to automation links what the person proposed and continues with the note", async () => {
    const { handler, runner, act } = handlerFor();
    fs.writeFileSync(
      path.join(companion, "worksets", "acme-login.yaml"),
      "id: acme-login\ntitle: Login\nrepositories: [acme/web]\nstage: explore\nqueuedAt: 2026-11-02T09:00:00.000Z\n",
    );
    await runs.saveTurn("acme-login", {
      type: "claude-code",
      data: { claudeSessionId: "2a41e812-a0fa-4908-a871-6df87d4ea2bc" },
    });
    await act("take-control");
    // The person explored by hand; nothing was proposed.
    await act("return");
    await runner.idle("acme-login");
    expect((await runs.facts("acme-login")).control.mode).toBe("automatic");
    expect(prompts[0]).toStartWith(
      "A person worked in this conversation directly; check the current state before continuing.\n\n/mate-explore-change",
    );
    handler.close();
  });

  test("Return to automation links a change the person proposed, once, and starts nothing", async () => {
    const { handler, runner, act } = handlerFor();
    await runs.saveTurn("acme-login", {
      type: "claude-code",
      data: { claudeSessionId: "2a41e812-a0fa-4908-a871-6df87d4ea2bc" },
    });
    await act("take-control");
    const change = path.join(companion, "openspec", "changes", "acme-settings");
    fs.mkdirSync(change, { recursive: true });
    fs.writeFileSync(
      path.join(change, "proposal.md"),
      "---\nscopes:\n  - repository: acme/web\n    area: .\n---\n# Acme settings\n",
    );
    fs.writeFileSync(path.join(change, "tasks.md"), "- [x] 1.1 Model\n- [ ] 1.2 View\n");
    await act("return");
    await runner.idle("acme-login");
    const record = (await readWorksets(companion)).worksets.find(
      (entry) => entry.id === "acme-login",
    );
    expect(record!.changes).toEqual(["acme-settings"]);
    expect(await runs.readLog("acme-login")).toContain("acme-settings: 1 of 2 tasks done");
    expect(prompts).toEqual([]);
    handler.close();
  });

  test("Return to automation keeps a waiting question waiting", async () => {
    const { handler, runner, act } = handlerFor();
    await runs.wait("acme-login", "explore", [{ question: "Provider?" }]);
    const waiting = (await runs.facts("acme-login")).execution;
    await runs.control.take("acme-login", false, async () => []);
    await act("return");
    expect(runner.isActive("acme-login")).toBe(false);
    expect((await runs.facts("acme-login")).execution).toEqual(waiting);
    expect((await runs.facts("acme-login")).control.mode).toBe("automatic");
    handler.close();
  });

  test("Start apply is refused outside the Human Reviews, and accepted in them", async () => {
    const { handler, runner, act } = handlerFor();
    await expect(act("start-apply")).rejects.toThrow("not in the Human Reviews");
    stage = "human-review";
    await act("start-apply");
    await runner.idle("acme-login");
    handler.close();
  });

  test("feedback revises at review and while building, follows up before merge, and is refused after", async () => {
    const { handler, runner, act } = handlerFor();
    await expect(act("feedback", { feedback: "Split it." })).rejects.toThrow("takes no feedback");
    stage = "human-review";
    await expect(act("feedback", { feedback: " " })).rejects.toThrow("cannot be empty");
    stage = "merge-wait";
    await act("feedback", { feedback: "Simpler first step." });
    await runner.idle("acme-login");
    expect(prompts[0]).toStartWith("/mate-propose-change Propose one follow-up change");
    stage = "done";
    await expect(act("feedback", { feedback: "More." })).rejects.toThrow();
    handler.close();
  });

  test("Regenerate is allowed only in the Human Reviews and runs a revise without a comment", async () => {
    const { handler, runner, act } = handlerFor();
    await expect(act("regenerate")).rejects.toThrow();
    stage = "human-review";
    await act("regenerate");
    await runner.idle("acme-login");
    expect(prompts).toEqual([]);
    handler.close();
  });

  test("Publish is refused before the merge", async () => {
    const { handler, act } = handlerFor();
    stage = "merge-wait";
    await expect(act("publish")).rejects.toThrow("not merged");
    handler.close();
  });

  test("retry and cancel need a run in the matching state", async () => {
    const { handler, act } = handlerFor();
    await expect(act("retry")).rejects.toThrow();
    await expect(act("cancel")).rejects.toThrow();
    handler.close();
  });

  test("without the runner every run action is refused, naming factory mode", async () => {
    const { handler, act } = handlerFor({ runner: false });
    await expect(act("retry")).rejects.toThrow("factory mode");
    handler.close();
  });

  test("read-only Studio refuses run actions", async () => {
    const { handler, act } = handlerFor({ writable: false });
    await expect(act("start-apply")).rejects.toThrow("--writable");
    handler.close();
  });

  test("the log is served as text", async () => {
    const { handler, act } = handlerFor();
    await runs.log("acme-login", "> /mate-propose-change\nthinking");
    const response = (await handler(
      new Request("http://localhost/api/factory/worksets/acme-login/log"),
    ))!;
    expect(await response.text()).toContain("thinking");
    handler.close();
  });

  test("the log streams as server-sent events: the stored log, then the run live", async () => {
    const { handler, runner, act } = handlerFor();
    await runs.log("acme-login", "Explored.\n");
    const response = (await handler(
      new Request("http://localhost/api/factory/worksets/acme-login/log/stream"),
    ))!;
    expect(response.headers.get("content-type")).toStartWith("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (needle: string) => {
      while (!text.includes(needle)) {
        // oxlint-disable-next-line no-await-in-loop -- reads the stream until the event arrives
        text += decoder.decode((await reader.read()).value);
      }
    };
    await until('"type":"replay"');
    expect(text).toContain('"log":"Explored.\\n"');
    runner.live.publish("acme-login", { type: "text", id: "a", delta: "Reading" });
    await until('"delta":"Reading"');
    await reader.cancel();
    handler.close();
  });
});
