import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WorksetStageId } from "../../workset/stage";
import type { FactoryClient } from "../client";
import { FactoryError } from "../ids";
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
  client: Pick<FactoryClient, "list" | "delete"> = { list: async () => [], delete: async () => {} },
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
    endSession: (id) => sessions.close(companion, id, "returned"),
  });
  return {
    runner,
    outcomes: factoryOutcomes({
      runner,
      runs,
      companionPath: companion,
      client,
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

  test("Return to automation ends the person's live session, then returns", async () => {
    const sessions = new LiveSessions();
    const closed: string[] = [];
    sessions.closeWith(async (companionPath, id, reason) => {
      closed.push(`${path.basename(companionPath)} ${id} ${reason}`);
      sessions.end(id);
    });
    const { outcomes: o, runner } = outcomes(sessions);
    await runs.control.take("acme-login", false, async () => []);
    sessions.begin("acme-login");
    await o.act("acme-login", "return", none);
    await runner.idle("acme-login");
    expect(closed).toEqual(["acme-companion acme-login returned"]);
    expect((await runs.facts("acme-login")).control.mode).toBe("automatic");
  });

  test("Return to automation waits while a person's session cannot be ended", async () => {
    const sessions = new LiveSessions();
    const { outcomes: o } = outcomes(sessions);
    await runs.control.take("acme-login", false, async () => []);
    sessions.begin("acme-login");
    await expect(o.act("acme-login", "return", none)).rejects.toThrow("exit Claude");
    expect((await runs.facts("acme-login")).control.mode).toBe("manual");
  });

  describe("after Claude exits in a person's session", () => {
    test("the Outcome returns to automation and no longer belongs to the person", async () => {
      const { outcomes: o } = outcomes();
      await runs.control.take("acme-login", false, async () => []);
      await o.returnAfterExit("acme-login");
      expect((await runs.facts("acme-login")).control.mode).toBe("automatic");
      expect(await o.takenOver("acme-login")).toBeNull();
    });

    test("an Outcome the factory drives is left alone", async () => {
      const { outcomes: o, runner } = outcomes();
      await o.returnAfterExit("acme-login");
      expect((await runs.facts("acme-login")).control.mode).toBe("automatic");
      expect(runner.isActive("acme-login")).toBe(false);
    });

    test("a refused return keeps control without raising", async () => {
      const sessions = new LiveSessions();
      const { outcomes: o } = outcomes(sessions);
      await runs.control.take("acme-login", false, async () => []);
      // The person's session has not ended yet, so the return is refused.
      sessions.begin("acme-login");
      await o.returnAfterExit("acme-login");
      expect((await runs.facts("acme-login")).control.mode).toBe("manual");
    });
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

describe("deleting an Outcome", () => {
  const info = { id: "acme-login" } as Awaited<ReturnType<FactoryClient["list"]>>[number];
  let calls: string[];
  const brokered = (refusal?: string): Pick<FactoryClient, "list" | "delete"> => ({
    list: async () => [info],
    delete: async (id) => {
      calls.push(`delete ${id}`);
      if (refusal) throw new FactoryError(refusal);
    },
  });
  const records = async () => (await readWorksets(companion)).worksets.map((w) => w.id);

  beforeEach(() => {
    calls = [];
    stage = "clarify-intent";
  });

  test("removes the container, the run state and, last, the record", async () => {
    const { outcomes: o } = outcomes(undefined, undefined, brokered());
    await runs.fail("acme-login", "clarify", "boom");
    await o.act("acme-login", "delete", none);
    expect(calls).toEqual(["delete acme-login"]);
    expect((await runs.facts("acme-login")).execution.state).toBe("idle");
    expect(await records()).toEqual([]);
  });

  test("ends the person's open session before the container goes", async () => {
    const sessions = new LiveSessions();
    sessions.closeWith(
      async (_companionPath, id, reason) => void calls.push(`close ${id} ${reason}`),
    );
    const { outcomes: o } = outcomes(sessions, undefined, brokered());
    await o.act("acme-login", "delete", none);
    expect(calls).toEqual(["close acme-login deleted", "delete acme-login"]);
  });

  test("a missing container is no error", async () => {
    const { outcomes: o } = outcomes();
    await o.act("acme-login", "delete", none);
    expect(await records()).toEqual([]);
  });

  test("stops a running run before anything is removed", async () => {
    let started!: () => void;
    const begun = new Promise<void>((resolve) => (started = resolve));
    const { outcomes: o, runner } = outcomes(
      undefined,
      {
        turn: ({ signal }) => {
          started();
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason));
          });
        },
      },
      {
        list: async () => [info],
        delete: async () => {
          calls.push(`delete; active ${runner.isActive("acme-login")}`);
        },
      },
    );
    await runner.request("acme-login", "propose", "go on");
    await begun;
    await o.act("acme-login", "delete", none);
    expect(calls).toEqual(["delete; active false"]);
    expect(await records()).toEqual([]);
  });

  test("a queued run is dropped and the Outcome removed", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const busy = outcomes(undefined, {
      turn: async () => {
        await held;
        return { kind: "done" };
      },
    });
    fs.writeFileSync(
      path.join(companion, "worksets", "acme-busy.yaml"),
      "id: acme-busy\ntitle: Busy\nrepositories: [acme/web]\nstage: explore\n",
    );
    await busy.runner.request("acme-busy", "propose", "go on");
    await busy.runner.request("acme-login", "propose", "go on");
    expect(busy.runner.isActive("acme-login")).toBe(true);
    await busy.outcomes.act("acme-login", "delete", none);
    expect(busy.runner.isActive("acme-login")).toBe(false);
    expect(await records()).toEqual(["acme-busy"]);
    release();
    await busy.runner.idle("acme-busy");
  });

  test("a refused removal keeps the run state and the record", async () => {
    const { outcomes: o } = outcomes(undefined, undefined, brokered("work is not pushed"));
    await runs.fail("acme-login", "clarify", "boom");
    await expect(o.act("acme-login", "delete", none)).rejects.toThrow("work is not pushed");
    expect((await runs.facts("acme-login")).execution.state).toBe("failed");
    expect(await records()).toEqual(["acme-login"]);
  });

  test("an Outcome with a change is refused and changes nothing", async () => {
    fs.writeFileSync(
      path.join(companion, "worksets", "acme-login.yaml"),
      "id: acme-login\ntitle: Login\nrepositories: [acme/web]\nchanges: [acme-login-plan]\n",
    );
    const { outcomes: o } = outcomes(undefined, undefined, brokered());
    await expect(o.act("acme-login", "delete", none)).rejects.toThrow("has a change");
    expect(calls).toEqual([]);
    expect(await records()).toEqual(["acme-login"]);
  });

  test("a taken-over Outcome is refused until it returns to automation", async () => {
    const { outcomes: o } = outcomes(undefined, undefined, brokered());
    await runs.control.take("acme-login", false, async () => []);
    await expect(o.act("acme-login", "delete", none)).rejects.toThrow(
      "return it to automation first",
    );
    expect(calls).toEqual([]);
    expect(await records()).toEqual(["acme-login"]);
  });

  test("a run that starts again before removal refuses and keeps the record", async () => {
    const { outcomes: o, runner } = outcomes(undefined, undefined, brokered());
    const stop = runner.stop.bind(runner);
    runner.stop = async (id) => {
      await stop(id);
      await runner.request(id, "clarify");
    };
    await expect(o.act("acme-login", "delete", none)).rejects.toThrow("started a run again");
    await runner.idle("acme-login");
    expect(calls).toEqual([]);
    expect(await records()).toEqual(["acme-login"]);
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
