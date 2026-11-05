import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Run } from "./run";
import { RunStore } from "./state";

let dir: string;
let runs: Run;
const now = "2026-11-03T12:00:00.000Z";
const session = "2a41e812-a0fa-4908-a871-6df87d4ea2bc";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "acme-run-"));
  runs = new Run(new RunStore(dir, () => new Date(now)));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test("facts distinguish an absent execution from idle and hide opaque resume data", async () => {
  expect(await runs.facts("acme-a")).toMatchObject({
    recorded: false,
    execution: { state: "idle" },
    control: { mode: "automatic" },
    conversation: false,
    claudeSession: null,
    memory: {},
    hasLog: false,
  });
  await runs.saveTurn("acme-a", { data: { claudeSessionId: session }, opaque: "acme" });
  expect(await runs.resume("acme-a")).toHaveProperty("opaque", "acme");
  expect(await runs.facts("acme-a")).toMatchObject({
    recorded: false,
    conversation: true,
    claudeSession: session,
    memory: {},
  });
  expect((await runs.allFacts()).size).toBe(0);
  await runs.settle("acme-a");
  expect((await runs.allFacts()).get("acme-a")).toMatchObject({
    recorded: true,
    execution: { state: "idle", updatedAt: now },
  });
});

describe("execution", () => {
  test("queue, slot waits, start, fresh rounds, failure and retry", async () => {
    await runs.queue("acme-a", "apply", "build-slot");
    expect((await runs.facts("acme-a")).execution).toEqual({
      state: "queued",
      stage: "apply",
      waiting: "build-slot",
      updatedAt: now,
    });
    await runs.start("acme-a", "apply");
    expect((await runs.facts("acme-a")).execution).toEqual({
      state: "running",
      stage: "apply",
      startedAt: now,
      updatedAt: now,
    });
    await runs.wait("acme-a", "archive", [{ question: "A?" }, { question: "B?" }]);
    const first = (await runs.facts("acme-a")).execution;
    if (first.state !== "waiting") throw new Error("expected waiting");
    expect(await runs.prepareAnswer("acme-a", ["", "yes"], first.round)).toEqual({
      stage: "apply",
      text: "1. A?\nAnswer: no answer; take your recommendation\n\n2. B?\nAnswer: yes",
    });
    await expect(runs.prepareAnswer("acme-a", "", first.round)).rejects.toThrow(
      "an answer cannot be empty",
    );
    await runs.wait("acme-a", "propose", [{ question: "C?" }]);
    const second = (await runs.facts("acme-a")).execution;
    expect(second.state === "waiting" && second.round).not.toBe(first.round);
    await expect(runs.prepareAnswer("acme-a", "yes", first.round)).rejects.toThrow(
      "already answered",
    );
    await runs.fail("acme-a", "archive", "acme failure");
    expect(await runs.retryStage("acme-a")).toBe("apply");
    await runs.settle("acme-a");
    await expect(runs.retryStage("acme-a")).rejects.toThrow(
      "has no failed or interrupted run to retry",
    );
  });
});

describe("restart", () => {
  test("interrupts only active execution", async () => {
    await runs.start("acme-a", "apply");
    await runs.queue("acme-b", "propose");
    await runs.wait("acme-c", "explore", [{ question: "Next?" }]);
    const reopened = new Run(new RunStore(dir));
    expect(await reopened.interruptActive()).toEqual(["acme-a", "acme-b"]);
    expect((await reopened.facts("acme-a")).execution).toMatchObject({
      state: "interrupted",
      stage: "apply",
    });
    expect((await reopened.facts("acme-c")).execution.state).toBe("waiting");
    expect((await reopened.facts("acme-absent")).recorded).toBe(false);
  });
});

describe("memory", () => {
  test("overlapping producers preserve each other's fields and omitted turn results", async () => {
    await runs.start("acme-a", "propose");
    const resume = { data: { claudeSessionId: session } };
    await Promise.all([
      runs.saveTurn("acme-a", resume, {
        text: "Acme ready",
        checks: [{ name: "acme test", passed: true }],
      }),
      runs.rememberPush("acme-a", "workset/acme-a"),
      runs.rememberReview("acme-a", "acme-one", "report-1"),
      runs.rememberReview("acme-a", "acme-two", "report-2"),
      runs.recordSituation("acme-a", { text: "Acme kept" }, "publish"),
    ]);
    await runs.saveTurn("acme-a");
    await runs.rememberReview("acme-a", "acme-one", "report-3");
    expect(await runs.resume("acme-a")).toEqual(resume);
    expect((await runs.facts("acme-a")).memory).toEqual({
      pushedBranch: "workset/acme-a",
      reviewReports: { "acme-one": "report-3", "acme-two": "report-2" },
      situations: [
        { text: "Acme kept", stage: "publish", at: now },
        {
          text: "Acme ready",
          stage: "propose",
          at: now,
          checks: [{ name: "acme test", passed: true }],
        },
      ],
    });
  });

  test("keeps ten situations, newest first, and forgets the reclaimed run", async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, n) => runs.recordSituation("acme-a", { text: `Acme ${n}` })),
    );
    const situations = (await runs.facts("acme-a")).memory.situations!;
    expect(situations).toHaveLength(10);
    expect(situations[0]?.text).toBe("Acme 11");
    expect(situations.at(-1)?.text).toBe("Acme 2");
    await runs.settle("acme-a");
    await runs.control.take("acme-a", false, async () => []);
    await runs.log("acme-a", "Acme done\n");
    await runs.forget("acme-a");
    expect(await runs.facts("acme-a")).toMatchObject({
      recorded: false,
      memory: {},
      hasLog: false,
      control: { mode: "automatic" },
    });
  });
});
