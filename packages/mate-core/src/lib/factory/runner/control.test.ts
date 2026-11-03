import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { OutcomeControl } from "./control";
import { RunStore } from "./state";

let dir: string;
let store: RunStore;
let control: OutcomeControl;
const now = "2026-11-03T12:00:00.000Z";
const baseline = (changes: string[]) => async () => changes;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "acme-control-"));
  store = new RunStore(dir, () => new Date(now));
  control = new OutcomeControl(store);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("taking control", () => {
  test("is immediate with nothing running, and records the baseline", async () => {
    await control.take("acme-a", false, baseline(["acme-old"]));
    expect(await store.readControl("acme-a")).toEqual({
      mode: "manual",
      changesBefore: ["acme-old"],
      updatedAt: now,
    });
    await expect(control.requireAutomatic("acme-a")).rejects.toThrow(
      "return it to automation first",
    );
  });

  test("while a stage runs is requested, and the stage's end completes it", async () => {
    await control.take("acme-a", true, async () => {
      throw new Error("not read while requested");
    });
    expect((await store.readControl("acme-a")).mode).toBe("takeover-requested");
    expect(await control.withPerson("acme-a")).toBe(true);
    await control.stageEnded("acme-a", baseline(["acme-old"]));
    expect(await store.readControl("acme-a")).toMatchObject({
      mode: "manual",
      changesBefore: ["acme-old"],
    });
  });

  test("changes nothing when a person already has it", async () => {
    await control.take("acme-a", false, baseline(["acme-old"]));
    const before = await store.readControl("acme-a");
    await control.take("acme-a", true, baseline(["acme-new"]));
    expect(await store.readControl("acme-a")).toEqual(before);
  });

  test("a stage's end leaves the factory in control when no one asked", async () => {
    await control.stageEnded("acme-a", baseline([]));
    expect(await control.withPerson("acme-a")).toBe(false);
  });
});

describe("restart", () => {
  test("completes requested takeovers with one lazy baseline read, and leaves the rest", async () => {
    await store.write("acme-a", { state: "running", stage: "apply", updatedAt: now });
    await store.write("acme-b", { state: "queued", stage: "propose", updatedAt: now });
    await store.write("acme-c", { state: "idle", updatedAt: now });
    await control.take("acme-a", true, baseline([]));
    await control.take("acme-b", true, baseline([]));
    await control.take("acme-c", false, baseline(["acme-kept"]));
    let reads = 0;
    await control.recover(async () => {
      reads++;
      return ["acme-baseline"];
    });
    expect(reads).toBe(1);
    expect(await store.readControl("acme-a")).toMatchObject({
      mode: "manual",
      changesBefore: ["acme-baseline"],
    });
    expect((await store.readControl("acme-b")).mode).toBe("manual");
    expect((await store.readControl("acme-c")).changesBefore).toEqual(["acme-kept"]);
    await control.recover(async () => {
      throw new Error("not lazy");
    });
  });
});

describe("giving control back", () => {
  test("reconciles with the baseline, then the factory drives", async () => {
    await control.take("acme-a", false, baseline(["acme-old"]));
    let seen: string[] = [];
    expect(
      await control.giveBack("acme-a", async (before) => {
        seen = [...before];
      }),
    ).toBe(true);
    expect(seen).toEqual(["acme-old"]);
    expect(await control.withPerson("acme-a")).toBe(false);
  });

  test("is a no-op while the factory drives", async () => {
    expect(
      await control.giveBack("acme-a", async () => {
        throw new Error("not reconciled");
      }),
    ).toBe(false);
  });

  test("waits for a requested takeover's stage to end", async () => {
    await control.take("acme-a", true, baseline([]));
    await expect(control.giveBack("acme-a", async () => {})).rejects.toThrow(
      "still finishing its stage",
    );
  });

  test("a failed reconciliation keeps the person in control, with the reason", async () => {
    await control.take("acme-a", false, baseline(["acme-old"]));
    await expect(
      control.giveBack("acme-a", async () => {
        throw new Error("acme link failed");
      }),
    ).rejects.toThrow("returning to automation failed: acme link failed");
    expect(await store.readControl("acme-a")).toMatchObject({
      mode: "manual",
      changesBefore: ["acme-old"],
      reason: "returning to automation failed: acme link failed",
    });
  });
});
