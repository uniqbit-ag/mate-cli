import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FactoryError } from "../ids";
import { compareRanked, rankOf } from "./rank";
import { Run } from "./run";
import { FactoryRunner, SLOT_RETRY_MS } from "./scheduler";
import { RunStore } from "./state";
import { RETURN_NOTE, type StageAgent } from "./workflow";

let root: string;
let runs: Run;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-scheduler-")));
  runs = new Run(new RunStore(path.join(root, "runs")));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("rank", () => {
  test("started Outcomes rank by when they were started", () => {
    const early = rankOf({ queuedAt: "2026-11-02T09:00:00.000Z" })!;
    const late = rankOf({ queuedAt: "2026-11-02T10:00:00.000Z" })!;
    expect(early).toBeLessThan(late);
  });

  test("a Later Outcome has no rank and sorts after every started entry", () => {
    expect(rankOf({})).toBeNull();
    const sorted = [
      { id: "acme-later", rank: null },
      { id: "acme-b", rank: 5 },
      { id: "acme-a", rank: 5 },
    ].toSorted(compareRanked);
    expect(sorted.map((entry) => entry.id)).toEqual(["acme-a", "acme-b", "acme-later"]);
  });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** An agent whose turns end only when the test releases them, in start order. */
function heldAgent() {
  const started: string[] = [];
  const releases: (() => void)[] = [];
  const agent: StageAgent = {
    turn: ({ worksetId, signal }) =>
      new Promise((resolve, reject) => {
        started.push(worksetId);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        releases.push(() => resolve({ kind: "question", questions: [{ question: "next?" }] }));
      }),
  };
  /** Ends the oldest open turn, waiting for it to start first. */
  const release = async () => {
    while (releases.length === 0) await tick();
    releases.shift()!();
  };
  return { agent, started, release };
}

function runner(
  agent: StageAgent,
  ranks: Record<string, number | null>,
  maxRuns = 1,
  timers: Pick<
    ConstructorParameters<typeof FactoryRunner>[0],
    "setTimer" | "clearTimer" | "maxBuilds" | "sessionLive"
  > = {},
) {
  fs.mkdirSync(path.join(root, "worksets"), { recursive: true });
  fs.mkdirSync(path.join(root, "openspec", "changes"), { recursive: true });
  for (const id of ["acme-busy", "acme-a", "acme-b", "acme-c"]) {
    fs.writeFileSync(
      path.join(root, "worksets", `${id}.yaml`),
      `id: ${id}\nrepositories: [acme/web]\nstage: ready\n`,
    );
  }
  const settled: string[] = [];
  const r = new FactoryRunner({
    runs,
    maxRuns,
    stageMs: 60_000,
    depsFor: () => ({
      companionPath: root,
      stateDir: root,
      agent,
      run: async (_command, args) => ({
        status: 0,
        stdout: args.includes("symbolic-ref") ? `workset/${path.basename(args[1]!)}\n` : "",
        stderr: "",
      }),
    }),
    rankFor: async (id) => ranks[id] ?? null,
    onSettled: (id) => settled.push(id),
    ...timers,
  });
  return { r, settled };
}

describe("the build cap", () => {
  test("a build starts only after its pending build-wait write", async () => {
    const { agent, started, release } = heldAgent();
    const { r } = runner(agent, {}, 2, { maxBuilds: 1 });
    const queue = runs.queue.bind(runs);
    let unblock!: () => void;
    let blocked = false;
    const barrier = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    runs.queue = async (id, stage, waiting) => {
      if (waiting === "build-slot") {
        blocked = true;
        await barrier;
      }
      await queue(id, stage, waiting);
    };
    await r.request("acme-a", "apply", "go on");
    while (started.length === 0) await tick();
    await r.request("acme-b", "apply", "go on");
    while (!blocked) await tick();
    await release();
    await r.idle("acme-a");
    expect(started).toEqual(["acme-a"]);
    unblock();
    while (started.length < 2) await tick();
    expect((await runs.facts("acme-b")).execution.state).toBe("running");
    await release();
    await r.idle("acme-b");
  });

  test("a build waits for a build slot while another builds, shown as such", async () => {
    const { agent, started, release } = heldAgent();
    const { r } = runner(agent, { "acme-a": 100, "acme-b": 200 }, 4, { maxBuilds: 1 });
    await r.request("acme-a", "apply", "go on");
    while (started.length === 0) await tick();
    await r.request("acme-b", "apply", "go on");
    await tick();
    expect(started).toEqual(["acme-a"]);
    expect((await runs.facts("acme-b")).execution).toMatchObject({
      state: "queued",
      stage: "apply",
      waiting: "build-slot",
    });
    await release();
    await r.idle("acme-a");
    while (started.length < 2) await tick();
    expect(started).toEqual(["acme-a", "acme-b"]);
    expect((await runs.facts("acme-b")).execution.state).toBe("running");
    await release();
    await r.idle("acme-b");
  });

  test("an agent stage behind a waiting build starts when a run slot is free", async () => {
    const { agent, started, release } = heldAgent();
    const ranks = { "acme-a": 100, "acme-b": 200, "acme-c": 300 };
    const { r } = runner(agent, ranks, 4, { maxBuilds: 1 });
    await r.request("acme-a", "apply", "go on");
    while (started.length === 0) await tick();
    await r.request("acme-b", "apply", "go on");
    await r.request("acme-c", "propose", "go on");
    while (started.length < 2) await tick();
    expect(started).toEqual(["acme-a", "acme-c"]);
    expect(r.isActive("acme-b")).toBe(true);
    await release();
    await r.idle("acme-a");
    while (started.length < 3) await tick();
    expect(started).toEqual(["acme-a", "acme-c", "acme-b"]);
    await release();
    await release();
    await r.idle("acme-b");
    await r.idle("acme-c");
  });

  test("the best-ranked waiting build starts first when a build settles", async () => {
    const { agent, started, release } = heldAgent();
    const ranks = { "acme-busy": 0, "acme-a": 100, "acme-b": 200, "acme-c": 300 };
    const { r } = runner(agent, ranks, 2, { maxBuilds: 1 });
    await r.request("acme-busy", "apply", "go on");
    while (started.length === 0) await tick();
    await r.request("acme-c", "apply", "go on");
    await r.request("acme-b", "apply", "go on");
    await r.request("acme-a", "propose", "go on");
    while (started.length < 2) await tick();
    expect(started).toEqual(["acme-busy", "acme-a"]);
    await release();
    await r.idle("acme-busy");
    while (started.length < 3) await tick();
    expect(started[2]).toBe("acme-b");
    for (let open = 0; open < 2; open += 1) await release();
    await r.idle("acme-a");
    await r.idle("acme-b");
    await release();
    await r.idle("acme-c");
  });

  test("without a build cap, builds fill every run slot", async () => {
    const { agent, started, release } = heldAgent();
    const { r } = runner(agent, { "acme-a": 100, "acme-b": 200 }, 2);
    await r.request("acme-a", "apply", "go on");
    await r.request("acme-b", "apply", "go on");
    while (started.length < 2) await tick();
    // Both start at once; which reaches its turn first is not ordered.
    expect(started.toSorted()).toEqual(["acme-a", "acme-b"]);
    await release();
    await release();
    await r.idle("acme-a");
    await r.idle("acme-b");
  });
});

describe("ranked queue", () => {
  test("the cap holds and the lowest rank runs next, not the oldest request", async () => {
    const { agent, started, release } = heldAgent();
    const { r, settled } = runner(agent, { "acme-busy": 0, "acme-b": 200, "acme-a": 100 });
    await r.request("acme-busy", "propose", "go on");
    await r.request("acme-b", "propose", "go on");
    await r.request("acme-a", "propose", "go on");
    while (started.length === 0) await tick();
    expect(started).toEqual(["acme-busy"]);
    await release();
    await r.idle("acme-busy");
    while (started.length < 2) await tick();
    expect(started).toEqual(["acme-busy", "acme-a"]);
    expect(settled).toEqual(["acme-busy"]);
    await release();
    await r.idle("acme-a");
    await release();
    await r.idle("acme-b");
  });

  test("rerank reorders a queued request after its Outcome was started", async () => {
    const { agent, started, release } = heldAgent();
    const ranks: Record<string, number | null> = { "acme-busy": 0, "acme-a": 100, "acme-b": 200 };
    const { r } = runner(agent, ranks);
    await r.request("acme-busy", "propose", "go on");
    await r.request("acme-a", "propose", "go on");
    await r.request("acme-b", "propose", "go on");
    ranks["acme-b"] = 50;
    await r.rerank("acme-b");
    await release();
    await r.idle("acme-busy");
    while (started.length < 2) await tick();
    expect(started[1]).toBe("acme-b");
    await release();
    await r.idle("acme-b");
    await release();
    await r.idle("acme-a");
  });

  test("dequeue drops a queued request and leaves the Workset idle", async () => {
    const { agent, release } = heldAgent();
    const { r } = runner(agent, {});
    await r.request("acme-busy", "propose", "go on");
    await r.request("acme-a", "propose", "go on");
    expect(await r.dequeue("acme-a")).toBe(true);
    expect((await runs.facts("acme-a")).execution.state).toBe("idle");
    expect(r.isActive("acme-a")).toBe(false);
    expect(await r.dequeue("acme-busy")).toBe(false);
    await release();
    await r.idle("acme-busy");
  });
});

describe("question rounds", () => {
  test("a run that asks gets a new round each time", async () => {
    const { agent, release } = heldAgent();
    const { r } = runner(agent, {});
    await r.request("acme-a", "propose", "go on");
    await release();
    await r.idle("acme-a");
    const first = (await runs.facts("acme-a")).execution;
    expect(first.state === "waiting" && first.round).toBeTruthy();
    await r.answer("acme-a", "yes", first.state === "waiting" ? first.round : "");
    await release();
    await r.idle("acme-a");
    const second = (await runs.facts("acme-a")).execution;
    expect(second.state).toBe("waiting");
    expect(second.state === "waiting" && second.round).not.toBe(
      first.state === "waiting" && first.round,
    );
  });

  test("of two answers to one round, exactly one continues the run", async () => {
    const { agent, started, release } = heldAgent();
    const { r } = runner(agent, {});
    await runs.wait("acme-a", "propose", [{ question: "Launch languages?" }]);
    const waiting = (await runs.facts("acme-a")).execution;
    const round = waiting.state === "waiting" ? waiting.round : "";
    const results = await Promise.allSettled([
      r.answer("acme-a", "English only", round),
      r.answer("acme-a", "English and German", round),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason.message).toBe(
      "this question was already answered",
    );
    while (started.length === 0) await tick();
    await release();
    await r.idle("acme-a");
    expect(started).toEqual(["acme-a"]);
  });

  test("an answer to an earlier round is refused and the follow-up stays waiting", async () => {
    const { agent } = heldAgent();
    const { r } = runner(agent, {});
    await runs.wait("acme-a", "propose", [{ question: "Follow-up?" }]);
    const waiting = (await runs.facts("acme-a")).execution;
    await expect(r.answer("acme-a", "yes", "acme-first")).rejects.toThrow("already answered");
    expect((await runs.facts("acme-a")).execution).toEqual(waiting);
    expect(r.isActive("acme-a")).toBe(false);
  });
});

describe("taking control", () => {
  test("direct takeover and return are idempotent; answer validation precedes control", async () => {
    const { agent } = heldAgent();
    const { r } = runner(agent, {});
    await r.returnToAutomation("acme-a");
    await r.takeControl("acme-a");
    const control = (await runs.facts("acme-a")).control;
    await r.takeControl("acme-a");
    expect((await runs.facts("acme-a")).control).toEqual(control);
    await runs.wait("acme-a", "propose", [{ question: "Provider?" }]);
    const waiting = (await runs.facts("acme-a")).execution;
    const round = waiting.state === "waiting" ? waiting.round : "";
    await expect(r.answer("acme-a", "", "acme-stale")).rejects.toThrow(
      "this question was already answered",
    );
    await expect(r.answer("acme-a", "", round)).rejects.toThrow("an answer cannot be empty");
    await expect(r.answer("acme-a", "OIDC", round)).rejects.toThrow(
      "a person has control of this Outcome; return it to automation first",
    );
    await expect(r.retry("acme-a")).rejects.toThrow(
      "Workset acme-a has no failed or interrupted run to retry",
    );
  });

  test("a takeover during a stage waits for it, then no further stage starts", async () => {
    const { agent, started, release } = heldAgent();
    const { r, settled } = runner(agent, {});
    await r.request("acme-a", "propose", "go on");
    while (started.length === 0) await tick();
    await r.takeControl("acme-a");
    expect((await runs.facts("acme-a")).control.mode).toBe("takeover-requested");
    await release();
    await r.idle("acme-a");
    expect(settled).toContain("acme-a");
    expect((await runs.facts("acme-a")).control.mode).toBe("manual");
    // The stage ended on its own terms: its question waits for the person.
    expect((await runs.facts("acme-a")).execution.state).toBe("waiting");
    await expect(r.request("acme-a", "propose")).rejects.toThrow("a person has control");
  });

  test("a takeover of a queued run drops it: the stage never starts", async () => {
    const { agent, started, release } = heldAgent();
    const { r } = runner(agent, {});
    await r.request("acme-busy", "propose", "go on");
    await r.request("acme-a", "propose", "go on");
    while (started.length === 0) await tick();
    await r.takeControl("acme-a");
    expect((await runs.facts("acme-a")).control.mode).toBe("manual");
    expect((await runs.facts("acme-a")).execution.state).toBe("idle");
    expect(r.isActive("acme-a")).toBe(false);
    await release();
    await r.idle("acme-busy");
    await tick();
    expect(started).toEqual(["acme-busy"]);
  });

  test("a takeover with nothing running is immediate; a waiting question stays waiting", async () => {
    const { agent } = heldAgent();
    const { r } = runner(agent, {});
    await runs.wait("acme-a", "propose", [{ question: "Provider?" }]);
    const waiting = (await runs.facts("acme-a")).execution;
    const round = waiting.state === "waiting" ? waiting.round : "";
    await r.takeControl("acme-a");
    expect((await runs.facts("acme-a")).control.mode).toBe("manual");
    await expect(r.answer("acme-a", "OIDC", round)).rejects.toThrow(
      "return it to automation first",
    );
    expect((await runs.facts("acme-a")).execution).toEqual(waiting);
    expect(r.isActive("acme-a")).toBe(false);
  });

  test("a restart completes a requested takeover; control is never released by itself", async () => {
    await runs.start("acme-a", "apply");
    await runs.control.take("acme-a", true, async () => []);
    await runs.control.take("acme-b", false, async () => []);
    await runs.interruptActive();
    await runs.control.recover(async () => ["acme-old"]);
    expect((await runs.facts("acme-a")).control).toMatchObject({
      mode: "manual",
      changesBefore: ["acme-old"],
    });
    expect((await runs.facts("acme-b")).control.mode).toBe("manual");
    expect((await runs.facts("acme-new")).control.mode).toBe("automatic");
    expect([...(await runs.allFacts()).keys()]).toEqual(["acme-a"]);
  });
});

describe("returning to automation", () => {
  /** An agent that records each turn's prompt and ends it at once. */
  function promptAgent() {
    const prompts: string[] = [];
    const agent: StageAgent = {
      turn: async ({ prompt }) => {
        prompts.push(prompt);
        return { kind: "done" };
      },
    };
    return { agent, prompts };
  }

  function started(id: string): void {
    fs.writeFileSync(
      path.join(root, "worksets", `${id}.yaml`),
      `id: ${id}\nrepositories: [acme/web]\nstage: explore\nqueuedAt: 2026-11-02T09:00:00.000Z\n`,
    );
  }

  test("hands control back and starts the pickable stage, told a person worked", async () => {
    const { agent, prompts } = promptAgent();
    const { r } = runner(agent, {});
    started("acme-a");
    await runs.control.take("acme-a", false, async () => []);
    await r.returnToAutomation("acme-a");
    await r.idle("acme-a");
    expect((await runs.facts("acme-a")).control.mode).toBe("automatic");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toStartWith(RETURN_NOTE);
  });

  test("a waiting question stays waiting and starts nothing", async () => {
    const { agent, prompts } = promptAgent();
    const { r } = runner(agent, {});
    started("acme-a");
    await runs.wait("acme-a", "explore", [{ question: "Provider?" }]);
    await runs.control.take("acme-a", false, async () => []);
    await r.returnToAutomation("acme-a");
    expect((await runs.facts("acme-a")).execution.state).toBe("waiting");
    expect(r.isActive("acme-a")).toBe(false);
    expect(prompts).toEqual([]);
  });

  test("is refused while the person's session is live", async () => {
    const { agent } = promptAgent();
    const { r } = runner(agent, {}, 1, { sessionLive: (id) => id === "acme-a" });
    await runs.control.take("acme-a", false, async () => []);
    await expect(r.returnToAutomation("acme-a")).rejects.toThrow("exit Claude");
    expect((await runs.facts("acme-a")).control.mode).toBe("manual");
  });

  test("racing a pickup, exactly one run starts, with the return note", async () => {
    const { agent, prompts } = promptAgent();
    const { r } = runner(agent, {});
    started("acme-a");
    await runs.control.take("acme-a", false, async () => []);
    const [, picked] = await Promise.all([
      r.returnToAutomation("acme-a"),
      r.pickUp("acme-a", "explore"),
    ]);
    await r.idle("acme-a");
    expect(picked).toBe(false);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toStartWith(RETURN_NOTE);
  });

  test("a failed reconciliation leaves control with the person, with the reason", async () => {
    const { agent } = heldAgent();
    const { r } = runner(agent, {});
    await runs.control.take("acme-gone", false, async () => []);
    await expect(r.returnToAutomation("acme-gone")).rejects.toThrow(
      "returning to automation failed",
    );
    const control = (await runs.facts("acme-gone")).control;
    expect(control.mode).toBe("manual");
    expect(control.reason).toContain("returning to automation failed");
  });

  test("a takeover still waiting on its stage cannot be returned yet", async () => {
    const { agent, started, release } = heldAgent();
    const { r } = runner(agent, {});
    await r.request("acme-a", "propose", "go on");
    while (started.length === 0) await tick();
    await r.takeControl("acme-a");
    await expect(r.returnToAutomation("acme-a")).rejects.toThrow("still finishing its stage");
    await release();
    await r.idle("acme-a");
    expect((await runs.facts("acme-a")).control.changesBefore).toEqual([]);
  });
});

describe("pickup", () => {
  test("starts an idle Outcome the factory drives, and leaves the rest", async () => {
    const { agent, release } = heldAgent();
    const { r } = runner(agent, {}, 3);
    await runs.fail("acme-a", "propose", "boom");
    await runs.control.take("acme-b", false, async () => []);
    expect(await r.pickUp("acme-a", "propose")).toBe(false);
    expect(await r.pickUp("acme-b", "propose")).toBe(false);
    expect(await r.pickUp("acme-c", "propose")).toBe(true);
    expect(await r.pickUp("acme-c", "propose")).toBe(false);
    await release();
    await r.idle("acme-c");
  });
});

describe("waiting for a Workset container slot", () => {
  /** Refuses each listed Workset's turns as busy until it is freed; others ask a question. */
  function slotAgent(busy: Set<string>) {
    const turns: string[] = [];
    const agent: StageAgent = {
      turn: async ({ worksetId }) => {
        turns.push(worksetId);
        if (busy.has(worksetId)) {
          throw new FactoryError("all 4 running Workset containers are busy", "busy");
        }
        return { kind: "question", questions: [{ question: "next?" }] };
      },
    };
    return { agent, turns };
  }

  /** Captures the slot-retry timer instead of waiting thirty seconds. */
  function manualTimers() {
    const pending: { callback: () => void; ms: number }[] = [];
    return {
      pending,
      timers: {
        setTimer: (callback: () => void, ms: number) => {
          const entry = { callback, ms };
          if (ms === SLOT_RETRY_MS) pending.push(entry);
          return entry;
        },
        clearTimer: () => {},
      },
    };
  }

  test("a refused run stays queued in its place, shown as waiting for a slot, and does not fail", async () => {
    const busy = new Set(["acme-a"]);
    const { agent, turns } = slotAgent(busy);
    const { pending, timers } = manualTimers();
    const { r } = runner(agent, {}, 2, timers);
    await r.request("acme-a", "propose", "go on");
    while ((await runs.facts("acme-a")).execution.state !== "queued" || turns.length === 0)
      await tick();
    await tick();
    expect((await runs.facts("acme-a")).execution).toMatchObject({
      state: "queued",
      stage: "propose",
      waiting: "workset-slot",
    });
    expect(r.isActive("acme-a")).toBe(true);
    expect(turns).toEqual(["acme-a"]);
    expect(pending).toHaveLength(1);

    busy.clear();
    pending.shift()!.callback();
    await r.idle("acme-a");
    expect(turns).toEqual(["acme-a", "acme-a"]);
    expect((await runs.facts("acme-a")).execution.state).toBe("waiting");
  });

  test("another run settling or a session ending retries a waiting run", async () => {
    const busy = new Set(["acme-a"]);
    const { agent, turns } = slotAgent(busy);
    const { timers } = manualTimers();
    const { r } = runner(agent, {}, 2, timers);
    await r.request("acme-a", "propose", "go on");
    while ((await runs.facts("acme-a")).execution.state !== "queued" || turns.length === 0)
      await tick();
    await tick();
    // Still refused: a settle elsewhere tries again and it keeps waiting.
    await r.request("acme-b", "propose", "go on");
    await r.idle("acme-b");
    while (
      turns.filter((id) => id === "acme-a").length < 2 ||
      (await runs.facts("acme-a")).execution.state !== "queued"
    )
      await tick();
    expect(turns.filter((id) => id === "acme-a").length).toBeGreaterThanOrEqual(2);
    expect((await runs.facts("acme-a")).execution.state).toBe("queued");

    busy.clear();
    r.retrySlots();
    await r.idle("acme-a");
    expect((await runs.facts("acme-a")).execution.state).toBe("waiting");
  });

  test("a waiting run can still be cancelled", async () => {
    const { agent, turns } = slotAgent(new Set(["acme-a"]));
    const { timers } = manualTimers();
    const { r } = runner(agent, {}, 2, timers);
    await r.request("acme-a", "propose", "go on");
    while ((await runs.facts("acme-a")).execution.state !== "queued" || turns.length === 0)
      await tick();
    await tick();
    await r.cancel("acme-a");
    expect((await runs.facts("acme-a")).execution).toMatchObject({
      state: "failed",
      reason: "cancelled",
    });
    expect(r.isActive("acme-a")).toBe(false);
  });
});
