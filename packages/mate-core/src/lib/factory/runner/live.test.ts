import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LiveTurns, VIEWER_BUFFER } from "./live";
import { RunStore } from "./state";

let dir: string;
let store: RunStore;
let live: LiveTurns;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mate-live-"));
  store = new RunStore(path.join(dir, "runs"));
  live = new LiveTurns(store);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("following a running turn", () => {
  test("a feed is forgotten once its run settled and nobody watches", async () => {
    const feeds = (live as unknown as { feeds: Map<string, unknown> }).feeds;
    live.publish("acme-ws", { type: "text", id: "a", delta: "Reading" });
    await live.log("acme-ws", "Reading\n", true);
    const viewer = live.watch("acme-ws");
    await viewer.replay;
    live.publish("acme-ws", { type: "settled" });
    await live.flushed("acme-ws");
    expect(feeds.has("acme-ws")).toBe(true);
    viewer.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(feeds.has("acme-ws")).toBe(false);
  });

  test("a viewer joining mid-block gets the log, the open block and then the rest, once each", async () => {
    await live.log("acme-ws", "\n> /mate-explore-change\n");
    live.publish("acme-ws", { type: "text", id: "a", delta: "Reading the " });
    live.publish("acme-ws", { type: "text", id: "b", delta: "Done." });
    live.publish("acme-ws", { type: "text-end", id: "b" });
    void live.log("acme-ws", "Done.\n", true);
    const viewer = live.watch("acme-ws");
    live.publish("acme-ws", { type: "text", id: "a", delta: "workset." });
    live.publish("acme-ws", { type: "text-end", id: "a" });
    void live.log("acme-ws", "Reading the workset.\n", true);
    live.publish("acme-ws", { type: "tool", name: "Read", summary: "README.md" });
    await live.log("acme-ws", "\nlinked acme-a to acme-ws\n");
    live.publish("acme-ws", { type: "settled" });

    expect(await viewer.replay).toEqual({
      log: "\n> /mate-explore-change\nDone.\n",
      open: [{ id: "a", text: "Reading the " }],
    });
    const events = [];
    for (let event = await viewer.next(); event; event = await viewer.next()) {
      events.push(event);
      if (event.type === "settled") break;
    }
    expect(events).toEqual([
      { type: "text", id: "a", delta: "workset." },
      { type: "text-end", id: "a" },
      { type: "tool", name: "Read", summary: "README.md" },
      { type: "log", text: "\nlinked acme-a to acme-ws\n" },
      { type: "settled" },
    ]);
    viewer.close();
    expect(await store.readLog("acme-ws")).toBe(
      "\n> /mate-explore-change\nDone.\nReading the workset.\n\nlinked acme-a to acme-ws\n",
    );
  });

  test("a viewer that falls behind is dropped without holding the turn back", async () => {
    const slow = live.watch("acme-ws");
    const steady = live.watch("acme-ws");
    for (let index = 0; index <= VIEWER_BUFFER; index += 1) {
      live.publish("acme-ws", { type: "text", delta: "." });
      if (index < 10) await steady.next();
    }
    expect(await slow.next()).toEqual({ type: "lost" });
    expect(await slow.next()).toBeNull();
    steady.close();
  });

  test("a closed viewer stops waiting and gets nothing more", async () => {
    const viewer = live.watch("acme-ws");
    const pending = viewer.next();
    viewer.close();
    expect(await pending).toBeNull();
    live.publish("acme-ws", { type: "text", delta: "after" });
    expect(await viewer.next()).toBeNull();
  });

  test("blocks a cut-short turn left open end with the run", async () => {
    live.publish("acme-ws", { type: "text", id: "a", delta: "Half a sentence" });
    live.publish("acme-ws", { type: "settled" });
    expect((await live.watch("acme-ws").replay).open).toEqual([]);
  });
});
