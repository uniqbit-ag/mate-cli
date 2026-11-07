import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WorksetStageId } from "../../workset/stage";
import { readWorksets } from "../../workset/record";
import { FactoryRunner } from "../runner/scheduler";
import { Run } from "../runner/run";
import { NO_CREDENTIAL } from "../credential-store";
import { RunStore } from "../runner/state";
import type { StageAgent } from "../runner/workflow";
import { type FactoryOutcomes, factoryOutcomes, recordOutcomes } from "./index";
import type { OutcomeAction } from "./actions";
import { LiveSessions } from "./sessions";
import { compareUrlFor } from "./runs";

let root: string;
let companion: string;
let runs: Run;
let turns: string[];
let stage: WorksetStageId;
let keptReports: string[];

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-outcomes-")));
  companion = path.join(root, "acme-companion");
  fs.mkdirSync(path.join(companion, "worksets"), { recursive: true });
  fs.mkdirSync(path.join(companion, "openspec", "changes"), { recursive: true });
  fs.writeFileSync(
    path.join(companion, "worksets", "acme-login.yaml"),
    "id: acme-login\ntitle: Login\nrepositories: [acme/web]\nstage: explore\n",
  );
  runs = new Run(new RunStore(path.join(root, "runs")));
  turns = [];
  stage = "explore";
  keptReports = [];
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function outcomes(
  sessions = new LiveSessions(),
  agent: StageAgent = {
    turn: async ({ prompt }) => {
      turns.push(prompt);
      return { kind: "done" };
    },
  },
): {
  outcomes: FactoryOutcomes;
  runner: FactoryRunner;
} {
  const runner = new FactoryRunner({
    runs,
    maxRuns: 1,
    stageMs: 60_000,
    depsFor: () => ({
      companionPath: companion,
      stateDir: root,
      agent,
      run: async () => ({ status: 0, stdout: "", stderr: "" }),
    }),
    sessionLive: (id) => sessions.busy().has(id),
  });
  return {
    runner,
    outcomes: factoryOutcomes({
      runner,
      runs,
      companionPath: companion,
      client: { list: async () => [], delete: async () => {} },
      stages: async () => ({
        worksets: (await readWorksets(companion)).worksets.map((record) => ({
          record,
          derived: { stage, label: `at ${stage}`, turn: "human" as const, problems: [] },
        })),
      }),
      reports: { publish: async () => ({ id: "report-1" }), ids: async () => keptReports },
      sessions,
    }),
  };
}

const none = () => "";

describe("an action on an Outcome", () => {
  test("an unknown action is refused and changes nothing", async () => {
    const { outcomes: o, runner } = outcomes();
    await expect(o.act("acme-login", "advance" as OutcomeAction, none)).rejects.toThrow(
      'unknown factory action "advance"',
    );
    expect(runner.isActive("acme-login")).toBe(false);
    expect((await readWorksets(companion)).worksets[0]?.stage).toBe("explore");
  });

  test("an action outside the accepted set is refused naming the stage, and starts no run", async () => {
    const { outcomes: o, runner } = outcomes();
    stage = "apply";
    await expect(o.act("acme-login", "start-apply", none)).rejects.toThrow(
      "Workset acme-login is not in the Human Reviews; it is at at apply",
    );
    expect(runner.isActive("acme-login")).toBe(false);
    expect(turns).toEqual([]);
  });

  test("an accepted action runs its stage", async () => {
    const { outcomes: o, runner } = outcomes();
    stage = "publish";
    await o.act("acme-login", "publish", none);
    expect(runner.isActive("acme-login")).toBe(true);
    await runner.idle("acme-login");
  });

  test("Return to automation waits while a person's session is live", async () => {
    const sessions = new LiveSessions();
    const { outcomes: o } = outcomes(sessions);
    await runs.control.take("acme-login", false, async () => []);
    sessions.begin("acme-login");
    await expect(o.act("acme-login", "return", none)).rejects.toThrow("exit Claude");
    expect((await runs.facts("acme-login")).control.mode).toBe("manual");
  });

  test("an id that is not a Workset name is refused before anything is read", async () => {
    const { outcomes: o } = outcomes();
    await expect(o.act("../etc", "retry", none)).rejects.toThrow("kebab-case");
  });
});

describe("moving an Outcome to Later", () => {
  const STARTED = "2026-11-02T09:00:00.000Z";
  const started = (id: string) =>
    fs.writeFileSync(
      path.join(companion, "worksets", `${id}.yaml`),
      `id: ${id}\ntitle: ${id}\nrepositories: [acme/web]\nstage: explore\nqueuedAt: ${STARTED}\n`,
    );
  const queuedAt = async (id: string) =>
    (await readWorksets(companion)).worksets.find((w) => w.id === id)?.queuedAt;

  beforeEach(() => {
    stage = "clarify-intent";
    started("acme-login");
  });

  test("is refused once its run is running, keeping its start time", async () => {
    const { outcomes: o } = outcomes();
    await runs.start("acme-login", "clarify");
    await expect(o.act("acme-login", "later", none)).rejects.toThrow(
      "it can no longer move to Later",
    );
    expect(await queuedAt("acme-login")).toBe(STARTED);
    expect((await runs.facts("acme-login")).execution.state).toBe("running");
  });

  test("is refused past Clarify intent, keeping its start time", async () => {
    const { outcomes: o } = outcomes();
    stage = "explore";
    await expect(o.act("acme-login", "later", none)).rejects.toThrow(
      "it can no longer move to Later",
    );
    expect(await queuedAt("acme-login")).toBe(STARTED);
  });

  test("while queued clears its start time and removes the queued run", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { outcomes: o, runner } = outcomes(undefined, {
      turn: async () => {
        await held;
        return { kind: "done" };
      },
    });
    started("acme-busy");
    await runner.request("acme-busy", "propose", "go on");
    await runner.request("acme-login", "propose", "go on");
    expect((await runs.facts("acme-login")).execution.state).toBe("queued");
    await o.act("acme-login", "later", none);
    expect(await queuedAt("acme-login")).toBeUndefined();
    expect((await runs.facts("acme-login")).execution.state).toBe("idle");
    expect(runner.isActive("acme-login")).toBe(false);
    release();
    await runner.idle("acme-busy");
  });

  test("is refused, keeping its start time, when the run started during the move", async () => {
    const { outcomes: o } = outcomes();
    const facts = runs.facts.bind(runs);
    let first = true;
    // The policy reads a queued run, which the runner starts right after.
    runs.facts = async (id) => {
      const read = await facts(id);
      if (id === "acme-login" && first) {
        first = false;
        await runs.start(id, "clarify");
      }
      return read;
    };
    await runs.queue("acme-login", "clarify");
    await expect(o.act("acme-login", "later", none)).rejects.toThrow(
      "it can no longer move to Later",
    );
    expect(await queuedAt("acme-login")).toBe(STARTED);
  });

  test("is refused, keeping its start time, when its stage moved on during the move", async () => {
    const { outcomes: o } = outcomes();
    const facts = runs.facts.bind(runs);
    let first = true;
    // The clarify run ends between the policy check and the dequeue.
    runs.facts = async (id) => {
      if (id === "acme-login" && first) {
        first = false;
        const read = await facts(id);
        stage = "explore";
        return read;
      }
      return facts(id);
    };
    await expect(o.act("acme-login", "later", none)).rejects.toThrow(
      "it can no longer move to Later",
    );
    expect(await queuedAt("acme-login")).toBe(STARTED);
  });

  test("after a cancelled clarify clears its start time", async () => {
    const { outcomes: o } = outcomes();
    await runs.fail("acme-login", "clarify", "cancelled");
    await o.act("acme-login", "later", none);
    expect(await queuedAt("acme-login")).toBeUndefined();
  });
});

describe("Outcomes without the AFK runner", () => {
  const recorded = () =>
    recordOutcomes(companion, async () => ({
      worksets: (await readWorksets(companion)).worksets.map((record) => ({
        record,
        derived: { stage, label: `at ${stage}`, turn: "human" as const, problems: [] },
      })),
    }));
  const record = async () => (await readWorksets(companion)).worksets[0];

  test("Start and Later change only the record's start time", async () => {
    stage = "clarify-intent";
    const o = recorded();
    await o.act("acme-login", "start", none);
    expect((await record())?.queuedAt).toBeString();
    await o.act("acme-login", "later", none);
    expect((await record())?.queuedAt).toBeUndefined();
    expect(await o.runs()).toBeNull();
  });

  test("create writes the record only", async () => {
    const working = path.join(root, "acme-web");
    execFileSync("git", ["init", "-q", working]);
    execFileSync("git", [
      "-C",
      working,
      "remote",
      "add",
      "origin",
      "https://github.com/acme/web.git",
    ]);
    fs.mkdirSync(path.join(companion, ".mate", "config"), { recursive: true });
    fs.writeFileSync(
      path.join(companion, ".mate", "config", "registry.yaml"),
      `repos:\n  - id: acme-web\n    path: ${working}\n`,
    );
    const fields: Record<string, string> = { text: "Faster acme checkout" };
    await recorded().create((name) => fields[name] ?? "");
    const created = (await readWorksets(companion)).worksets.find((w) => w.id !== "acme-login");
    expect(created?.queuedAt).toBeString();
  });

  test("an action that needs the runner is refused because it needs the factory mode", async () => {
    stage = "human-review";
    await expect(recorded().act("acme-login", "start-apply", none)).rejects.toThrow(
      "the AFK runner needs the appliance's factory mode for this companion",
    );
    expect((await record())?.stage).toBe("explore");
  });

  test("Later past Clarify intent is refused and keeps the start time", async () => {
    const o = recorded();
    await o.act("acme-login", "start", none);
    const startedAt = (await record())?.queuedAt;
    await expect(o.act("acme-login", "later", none)).rejects.toThrow(
      "it can no longer move to Later",
    );
    expect((await record())?.queuedAt).toBe(startedAt);
  });

  test("Done refuses Start", async () => {
    stage = "done";
    await expect(recorded().act("acme-login", "start", none)).rejects.toThrow(
      "Workset acme-login is done",
    );
    expect((await record())?.queuedAt).toBeUndefined();
  });

  test("an unknown action is refused", async () => {
    await expect(recorded().act("acme-login", "advance" as OutcomeAction, none)).rejects.toThrow(
      'unknown factory action "advance"',
    );
  });
});

describe("the runs view", () => {
  test("never-run and conversation-only records add no synthetic view", async () => {
    const { outcomes: o } = outcomes();
    expect(await o.runs()).toEqual({});
    await runs.saveTurn("acme-login", {
      data: { claudeSessionId: "2a41e812-a0fa-4908-a871-6df87d4ea2bc" },
    });
    await runs.control.take("acme-login", false, async () => []);
    await runs.log("acme-login", "Acme log\n");
    expect(await o.runs()).toEqual({});
    expect(await o.takenOver("acme-login")).toEqual({
      claudeSession: "2a41e812-a0fa-4908-a871-6df87d4ea2bc",
    });
  });

  test("memory-only views retain idle defaults; execution views expose no resume", async () => {
    const { outcomes: o } = outcomes();
    await runs.rememberPush("acme-login", "workset/acme-login");
    expect((await o.runs())["acme-login"]).toEqual({
      state: "idle",
      updatedAt: "",
      pushedBranch: "workset/acme-login",
    });
    await runs.saveTurn("acme-login", {
      data: { claudeSessionId: "2a41e812-a0fa-4908-a871-6df87d4ea2bc" },
      opaque: "acme",
    });
    await runs.fail("acme-login", "apply", NO_CREDENTIAL);
    await runs.control.take("acme-login", false, async () => ["acme-old"]);
    await runs.log("acme-login", "Acme log\n");
    await runs.recordSituation("acme-login", { text: "Acme ready" }, "apply");
    const view = (await o.runs())["acme-login"]!;
    expect(view).toEqual({
      ...(await runs.facts("acme-login")).execution,
      pushedBranch: "workset/acme-login",
      control: (await runs.facts("acme-login")).control,
      situations: (await runs.facts("acme-login")).memory.situations,
      conversation: true,
      hasLog: true,
      needsCredential: true,
    });
    expect(view).not.toHaveProperty("resume");
    expect(await o.takenOver("acme-login")).toEqual({
      claudeSession: "2a41e812-a0fa-4908-a871-6df87d4ea2bc",
    });
    await runs.control.giveBack("acme-login", async () => {});
    expect(await o.takenOver("acme-login")).toBeNull();
  });

  test("compare links keep GitHub branches and omit unsupported forges", () => {
    expect(compareUrlFor("https://github.com/acme/web.git", "workset/acme-login")).toBe(
      "https://github.com/acme/web/compare/workset/acme-login?expand=1",
    );
    expect(compareUrlFor("https://gitlab.com/acme/web.git", "workset/acme-login")).toBeUndefined();
  });

  test("drops review reports the store no longer keeps", async () => {
    const { outcomes: o } = outcomes();
    await runs.rememberReview("acme-login", "acme-a", "report-1");
    await runs.rememberReview("acme-login", "acme-b", "report-2");
    keptReports = ["report-1"];
    expect((await o.runs())["acme-login"]?.reviewReports).toEqual({ "acme-a": "report-1" });
  });

  test("a settled run tells listeners", async () => {
    const { outcomes: o, runner } = outcomes();
    let changed = 0;
    o.onChanged(() => changed++);
    stage = "publish";
    await o.act("acme-login", "publish", none);
    await runner.idle("acme-login");
    expect(changed).toBeGreaterThan(0);
  });
});

test("a session's end retries runs waiting for a container slot", async () => {
  const sessions = new LiveSessions();
  const { runner } = outcomes(sessions);
  let retried = 0;
  runner.retrySlots = () => {
    retried++;
  };
  sessions.begin("acme-login");
  sessions.end("acme-login");
  await Promise.resolve();
  expect(retried).toBe(1);
});
