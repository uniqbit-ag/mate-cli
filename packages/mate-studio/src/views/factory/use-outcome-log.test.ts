import { describe, expect, it } from "bun:test";

import { classifyStored, EMPTY_LOG, type LogEvent, logReducer } from "./use-outcome-log";

const text = (events: LogEvent[]) =>
  events
    .reduce(logReducer, EMPTY_LOG)
    .pieces.map((piece) => piece.text)
    .join("");

describe("the live log in an Outcome dialog", () => {
  it("replays the stored log, then streams text blocks and tool calls in place", () => {
    expect(
      text([
        { type: "replay", log: "Explored.\n", open: [{ id: "a", text: "Reading " }] },
        { type: "tool", name: "Read", summary: "README.md" },
        { type: "text", id: "a", delta: "the code." },
        { type: "text-end", id: "a" },
        { type: "tool-done", name: "Read", failed: true },
        { type: "log", text: "Linked acme-change.\n" },
      ]),
    ).toBe("Explored.\nReading the code.\n› Read README.md\n  Read failed\nLinked acme-change.\n");
  });

  it("a fresh replay starts over, and a lost view says so", () => {
    expect(
      text([
        { type: "text", id: "a", delta: "old" },
        { type: "replay", log: "Stored.\n", open: [] },
      ]),
    ).toBe("Stored.\n");
    expect(text([{ type: "lost" }])).toContain("fell behind the run");
  });

  it("keeps following when a stage settles, so the next stage shows in the same log", () => {
    expect(
      text([
        { type: "replay", log: "", open: [] },
        { type: "log", text: "Asked.\n" },
        { type: "settled" },
        { type: "log", text: "Answered.\n" },
      ]),
    ).toBe("Asked.\nAnswered.\n");
  });

  it("keeps who wrote each live piece", () => {
    const kinds = [
      { type: "log", text: "\n> /mate-explore-change acme\n" },
      { type: "text", id: "a", delta: "Reading." },
      { type: "tool", name: "Read", summary: "README.md" },
      { type: "tool-done", name: "Read", failed: true },
      { type: "lost" },
    ] satisfies LogEvent[];
    expect(kinds.reduce(logReducer, EMPTY_LOG).pieces.map((piece) => piece.kind)).toEqual([
      "factory",
      "agent",
      "tool",
      "failed",
      "factory",
    ]);
  });

  it("tells the factory's notes from agent text in a replayed log", () => {
    const stored =
      "\n> /mate-explore-change acme\nI read the code.\n\ncommitted: acme\npushed change/acme\n";
    const pieces = classifyStored(stored);
    expect(pieces.map((piece) => piece.kind)).toEqual(["agent", "factory", "agent", "factory"]);
    expect(pieces.map((piece) => piece.text).join("")).toBe(stored);
    expect(pieces[1]!.text).toBe("> /mate-explore-change acme\n");
  });
});
