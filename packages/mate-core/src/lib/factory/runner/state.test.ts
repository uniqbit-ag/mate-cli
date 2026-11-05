import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Run } from "./run";

import {
  answerText,
  claudeSessionOf,
  LOG_LIMIT_BYTES,
  questionsOf,
  RunStore,
  SITUATION_HISTORY,
  withSituation,
} from "./state";

let dir: string;
let store: RunStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mate-runs-"));
  store = new RunStore(path.join(dir, "runs"), () => new Date("2026-10-29T12:00:00.000Z"));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("run state", () => {
  test("a Workset without a run is idle", async () => {
    expect((await store.read("acme-login")).state).toBe("idle");
  });

  test("a waiting state written before rounds reads with one stable round", async () => {
    await store.write("acme-login", {
      state: "waiting",
      stage: "propose",
      questions: [{ question: "Provider?" }],
      updatedAt: "2026-10-29T11:00:00.000Z",
    });
    const first = await store.read("acme-login");
    const second = await store.read("acme-login");
    expect(first).toMatchObject({ round: "legacy-2026-10-29T11:00:00.000Z" });
    expect(second).toEqual(first);
    const reopened = new Run(new RunStore(path.join(dir, "runs")));
    expect((await reopened.facts("acme-login")).execution).toEqual(first);
    expect(
      await reopened.prepareAnswer(
        "acme-login",
        "OIDC",
        first.state === "waiting" ? first.round : "",
      ),
    ).toEqual({ stage: "propose", text: "OIDC" });
  });

  test("a waiting question survives a reread", async () => {
    await store.write("acme-login", {
      state: "waiting",
      stage: "propose",
      questions: [{ question: "Which login provider?" }],
      updatedAt: store.stamp(),
    });
    expect(await new RunStore(path.join(dir, "runs")).read("acme-login")).toMatchObject({
      state: "waiting",
      questions: [{ question: "Which login provider?" }],
    });
  });

  test("a waiting state from before grouped questions reads as one question", async () => {
    const older = {
      state: "waiting",
      stage: "propose",
      question: "Which login provider?",
      options: ["SAML", "OIDC"],
      updatedAt: "",
    } as unknown as Parameters<typeof questionsOf>[0];
    expect(questionsOf(older)).toMatchObject([
      { question: "Which login provider?", options: ["SAML", "OIDC"] },
    ]);
    await store.write("acme-login", older);
    expect(await new Run(store).prepareAnswer("acme-login", "OIDC", "legacy-")).toEqual({
      stage: "propose",
      text: "OIDC",
    });
  });

  test("one answer is sent as written, several as each question with its answer", () => {
    expect(answerText([{ question: "Provider?" }], ["OIDC"])).toBe("OIDC");
    expect(answerText([{ question: "Provider?" }], ["  "])).toBeNull();
    expect(answerText([{ question: "A?" }, { question: "B?" }], ["", "yes"])).toBe(
      "1. A?\nAnswer: no answer; take your recommendation\n\n2. B?\nAnswer: yes",
    );
  });

  test("the log keeps only its newest bytes", async () => {
    await store.log("acme-login", "a".repeat(LOG_LIMIT_BYTES));
    await store.log("acme-login", "newest");
    const log = await store.readLog("acme-login");
    expect(log.length).toBe(LOG_LIMIT_BYTES);
    expect(log.endsWith("newest")).toBe(true);
  });

  test("memory is kept apart from the state", async () => {
    await store.writeMemory("acme-login", { pushedBranch: "workset/acme-login" });
    expect(await store.readMemory("acme-login")).toEqual({ pushedBranch: "workset/acme-login" });
    expect([...(await store.all()).keys()]).toEqual([]);
  });
});

describe("situations", () => {
  test("the newest comes first and only the last ten are kept", () => {
    let memory = {};
    for (let n = 1; n <= 12; n += 1) {
      memory = withSituation(memory, { text: `step ${n}`, at: `2026-11-02T09:${n}:00.000Z` });
    }
    const { situations } = memory as { situations: { text: string }[] };
    expect(situations).toHaveLength(SITUATION_HISTORY);
    expect(situations[0]?.text).toBe("step 12");
    expect(situations.at(-1)?.text).toBe("step 3");
  });

  test("checks and stage are kept with the situation", () => {
    const memory = withSituation(
      { reviewReports: { "acme-login": "r1" } },
      {
        text: "The three-step signup is built.",
        at: "2026-11-02T09:00:00.000Z",
        stage: "apply",
        checks: [{ name: "unit tests", passed: true }],
      },
    );
    expect(memory.reviewReports).toEqual({ "acme-login": "r1" });
    expect(memory.situations?.[0]).toMatchObject({
      stage: "apply",
      checks: [{ name: "unit tests", passed: true }],
    });
  });
});

describe("the factory's Claude session", () => {
  test("is read from the harness's resume data, and only as a session id", () => {
    const id = "2a41e812-a0fa-4908-a871-6df87d4ea2bc";
    expect(
      claudeSessionOf({ resume: { type: "claude-code", data: { claudeSessionId: id } } }),
    ).toBe(id);
    expect(claudeSessionOf({ resume: { data: { claudeSessionId: "--continue" } } })).toBeNull();
    const misshapen = "2a41e812a0fa-4908-a871-6df87d4ea2bc-";
    expect(claudeSessionOf({ resume: { data: { claudeSessionId: misshapen } } })).toBeNull();
    expect(claudeSessionOf({})).toBeNull();
  });
});
