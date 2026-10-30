/** @test-requires sockets */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FactoryRunner } from "../../../lib/factory/runner/scheduler";
import { RunStore } from "../../../lib/factory/runner/state";
import type { StageAgent } from "../../../lib/factory/runner/workflow";
import type { StudioCompanionPayload, StudioWorkset } from "./payload";
import { companionDigest } from "./selection";
import { createStudioFetch } from "./server";

let root: string;
let companion: string;
let store: RunStore;
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
  store = new RunStore(path.join(root, "runs"));
  prompts = [];
  stage = "explore";
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function handlerFor(options: { runner?: boolean; writable?: boolean } = {}) {
  const agent: StageAgent = {
    turn: async ({ prompt }) => {
      prompts.push(prompt);
      return { kind: "question", question: "Which login provider?" };
    },
  };
  const runner = new FactoryRunner({
    store,
    maxRuns: 2,
    stageMs: 60_000,
    depsFor: () => ({
      companionPath: companion,
      stateDir: root,
      agent,
      run: async () => ({ status: 0, stdout: "", stderr: "" }),
    }),
  });
  const payload = (): StudioCompanionPayload => ({
    companionPath: companion,
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
        companions: [{ path: companion, health: "ready", pairings: [] }],
      }),
      assembleCompanionPayload: async () => payload(),
      renderDocument: () => "studio",
      factoryRunner: options.runner === false ? null : { runner, store, companionPath: companion },
    },
    { writable: options.writable ?? true },
  );
  return { handler, runner };
}

const post = (action: string, fields: Record<string, string> = {}) =>
  new Request(`http://localhost/api/factory/worksets/acme-login/${action}`, {
    method: "POST",
    headers: { origin: "http://localhost" },
    body: new URLSearchParams({ companion: companionDigest(companion), ...fields }),
  });

describe("the board's runner routes", () => {
  test("advancing to ready starts propose by itself", async () => {
    const { handler, runner } = handlerFor();
    expect((await handler(post("advance")))!.status).toBe(303);
    await runner.idle("acme-login");
    expect(prompts[0]).toStartWith("/mate-propose-change");
    expect(await store.read("acme-login")).toMatchObject({
      state: "waiting",
      question: "Which login provider?",
    });
    handler.close();
  });

  test("an answer starts the next turn with the person's text", async () => {
    const { handler, runner } = handlerFor();
    await store.write("acme-login", {
      state: "waiting",
      stage: "propose",
      question: "?",
      updatedAt: "",
    });
    expect((await handler(post("answer", { answer: "Use the company IdP." })))!.status).toBe(303);
    await runner.idle("acme-login");
    expect(prompts[0]).toBe("Use the company IdP.");
    handler.close();
  });

  test("Start apply is refused outside the Human Reviews, and accepted in them", async () => {
    const { handler, runner } = handlerFor();
    const refused = (await handler(post("start-apply")))!;
    expect(refused.status).toBe(400);
    expect((await refused.json()).reason).toContain("not in the Human Reviews");
    stage = "human-review";
    expect((await handler(post("start-apply")))!.status).toBe(303);
    await runner.idle("acme-login");
    handler.close();
  });

  test("Publish is refused before the merge", async () => {
    const { handler } = handlerFor();
    stage = "merge-wait";
    const response = (await handler(post("publish")))!;
    expect(response.status).toBe(400);
    expect((await response.json()).reason).toContain("not merged");
    handler.close();
  });

  test("retry and cancel need a run in the matching state", async () => {
    const { handler } = handlerFor();
    expect((await handler(post("retry")))!.status).toBe(400);
    expect((await handler(post("cancel")))!.status).toBe(400);
    handler.close();
  });

  test("without the runner every run action is refused, naming factory mode", async () => {
    const { handler } = handlerFor({ runner: false });
    const response = (await handler(post("retry")))!;
    expect((await response.json()).reason).toContain("factory mode");
    handler.close();
  });

  test("read-only Studio refuses run actions", async () => {
    const { handler } = handlerFor({ writable: false });
    expect((await handler(post("start-apply")))!.status).toBe(403);
    handler.close();
  });

  test("the log is served as text", async () => {
    const { handler } = handlerFor();
    await store.log("acme-login", "> /mate-propose-change\nthinking");
    const response = (await handler(
      new Request("http://localhost/api/factory/worksets/acme-login/log"),
    ))!;
    expect(await response.text()).toContain("thinking");
    handler.close();
  });
});
