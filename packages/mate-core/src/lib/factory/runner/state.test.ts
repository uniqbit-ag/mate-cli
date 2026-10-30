import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LOG_LIMIT_BYTES, RunStore } from "./state";

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

  test("a waiting question survives a reread", async () => {
    await store.write("acme-login", {
      state: "waiting",
      stage: "propose",
      question: "Which login provider?",
      updatedAt: store.stamp(),
    });
    expect(await new RunStore(path.join(dir, "runs")).read("acme-login")).toMatchObject({
      state: "waiting",
      question: "Which login provider?",
    });
  });

  test("on startup an active run reads as interrupted and nothing else changes", async () => {
    await store.write("acme-a", { state: "running", stage: "apply", startedAt: "", updatedAt: "" });
    await store.write("acme-b", { state: "queued", stage: "propose", updatedAt: "" });
    await store.write("acme-c", {
      state: "waiting",
      stage: "propose",
      question: "?",
      updatedAt: "",
    });
    expect(await store.interruptActive()).toEqual(["acme-a", "acme-b"]);
    expect(await store.read("acme-a")).toEqual({
      state: "interrupted",
      stage: "apply",
      updatedAt: "2026-10-29T12:00:00.000Z",
    });
    expect((await store.read("acme-c")).state).toBe("waiting");
  });

  test("the log keeps only its newest bytes", async () => {
    await store.log("acme-login", "a".repeat(LOG_LIMIT_BYTES));
    await store.log("acme-login", "newest");
    const log = await store.readLog("acme-login");
    expect(log.length).toBe(LOG_LIMIT_BYTES);
    expect(log.endsWith("newest")).toBe(true);
  });

  test("memory is kept apart from the state", async () => {
    await store.writeMemory("acme-login", { pushedBranch: "change/acme-login" });
    expect(await store.readMemory("acme-login")).toEqual({ pushedBranch: "change/acme-login" });
    expect([...(await store.all()).keys()]).toEqual([]);
  });
});
