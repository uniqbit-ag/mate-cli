import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createReportStore, isReportId, REPORT_LIMITS } from "./reports";

const ACME = "0123456789";
const BETA = "abcdef0123";
const DAY = 24 * 60 * 60 * 1000;

let root: string;
let time: number;
const clock = () => time;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "mate-reports-"));
  time = 1_000_000;
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("report store", () => {
  test("ids are unguessable 128-bit hex and listings carry no path", async () => {
    const store = createReportStore({ root, now: clock });
    const stored = await store.publish(ACME, { title: "One", html: "<p>1</p>" });
    expect(isReportId(stored.id)).toBe(true);
    expect(Object.keys(stored).toSorted()).toEqual(["bytes", "createdAt", "id", "title"]);
    expect(JSON.stringify(await store.list(ACME))).not.toContain(root);
  });

  test("evicts the oldest past the count cap and keeps the new report", async () => {
    const store = createReportStore({ root, now: clock, limits: { reports: 3 } });
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      time += 1;
      ids.push((await store.publish(ACME, { title: `r${index}`, html: "x" })).id);
    }
    const listed = (await store.list(ACME)).map((entry) => entry.id);
    expect(listed).toEqual([ids[4]!, ids[3]!, ids[2]!]);
    expect(await store.read(ids[0]!)).toBeNull();
    expect((await readdir(path.join(root, ACME))).filter((n) => n.endsWith(".html"))).toHaveLength(
      3,
    );
  });

  test("evicts the oldest past the byte cap and keeps the new report", async () => {
    const store = createReportStore({ root, now: clock, limits: { bytes: 10 } });
    time += 1;
    const first = await store.publish(ACME, { title: "a", html: "123456" });
    time += 1;
    const second = await store.publish(ACME, { title: "b", html: "123456" });
    expect((await store.list(ACME)).map((entry) => entry.id)).toEqual([second.id]);
    expect(await store.read(first.id)).toBeNull();
    expect(await store.read(second.id)).toBe("123456");
  });

  test("caps are per companion", async () => {
    const store = createReportStore({ root, now: clock, limits: { reports: 1 } });
    await store.publish(ACME, { title: "a", html: "x" });
    await store.publish(BETA, { title: "b", html: "x" });
    expect(await store.list(ACME)).toHaveLength(1);
    expect(await store.list(BETA)).toHaveLength(1);
  });

  test("expiry happens at cleanup time, not on reads", async () => {
    const store = createReportStore({ root, now: clock });
    const old = await store.publish(ACME, { title: "old", html: "<p>old</p>" });
    time += REPORT_LIMITS.ageMs + DAY;
    expect((await store.list(ACME)).map((entry) => entry.id)).toEqual([old.id]);
    expect(await store.read(old.id)).toBe("<p>old</p>");

    await store.cleanup();
    expect(await store.list(ACME)).toEqual([]);
    expect(await store.read(old.id)).toBeNull();
  });

  test("a later publish removes expired reports", async () => {
    const store = createReportStore({ root, now: clock });
    const old = await store.publish(ACME, { title: "old", html: "x" });
    time += REPORT_LIMITS.ageMs + DAY;
    const fresh = await store.publish(ACME, { title: "new", html: "y" });
    expect((await store.list(ACME)).map((entry) => entry.id)).toEqual([fresh.id]);
    expect(await store.read(old.id)).toBeNull();
  });

  test("reports persist across a new store over the same root", async () => {
    const stored = await createReportStore({ root, now: clock }).publish(ACME, {
      title: "kept",
      html: "<p>kept</p>",
    });
    const restarted = createReportStore({ root, now: clock });
    expect((await restarted.list(ACME)).map((entry) => entry.id)).toEqual([stored.id]);
    expect(await restarted.read(stored.id)).toBe("<p>kept</p>");
  });

  test("rejects non-id lookups and non-digest companions", async () => {
    const store = createReportStore({ root, now: clock });
    expect(await store.read("../index")).toBeNull();
    await expect(store.publish("../escape", { title: "x", html: "x" })).rejects.toThrow();
  });

  test("writes only under its root", async () => {
    const store = createReportStore({ root, now: clock });
    await store.publish(ACME, { title: "x", html: "x" });
    expect(await readdir(root)).toEqual([ACME]);
  });
});
