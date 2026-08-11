import { describe, expect, test } from "bun:test";

import {
  InvalidOpenSpecResponseError,
  parseOpenSpecChangeList,
  parseOpenSpecChangeRoot,
} from "./openspec-schema";

describe("parseOpenSpecChangeList", () => {
  test("parses a well-formed response", () => {
    const raw = JSON.stringify({
      changes: [
        { name: "add-foo", completedTasks: 2, totalTasks: 5, status: "in-progress" },
        { name: "add-bar", completedTasks: 3, totalTasks: 3, status: "complete" },
      ],
    });

    expect(parseOpenSpecChangeList(raw)).toEqual([
      { name: "add-foo", completedTasks: 2, totalTasks: 5, status: "in-progress" },
      { name: "add-bar", completedTasks: 3, totalTasks: 3, status: "complete" },
    ]);
  });

  test("parses an empty change list", () => {
    expect(parseOpenSpecChangeList(JSON.stringify({ changes: [] }))).toEqual([]);
  });

  test("defaults a missing status to unknown", () => {
    const raw = JSON.stringify({ changes: [{ name: "x", completedTasks: 0, totalTasks: 1 }] });

    expect(parseOpenSpecChangeList(raw)).toEqual([
      { name: "x", completedTasks: 0, totalTasks: 1, status: "unknown" },
    ]);
  });

  test("rejects malformed JSON", () => {
    expect(() => parseOpenSpecChangeList("not json")).toThrow(InvalidOpenSpecResponseError);
  });

  test("rejects a response missing the changes array", () => {
    expect(() => parseOpenSpecChangeList(JSON.stringify({}))).toThrow(InvalidOpenSpecResponseError);
  });

  test("rejects a change entry missing task counts", () => {
    const raw = JSON.stringify({ changes: [{ name: "x" }] });

    expect(() => parseOpenSpecChangeList(raw)).toThrow(InvalidOpenSpecResponseError);
  });
});

describe("parseOpenSpecChangeRoot", () => {
  test("extracts changeRoot from a well-formed response", () => {
    const raw = JSON.stringify({
      changeName: "add-foo",
      changeRoot: "/companions/a/openspec/changes/add-foo",
    });

    expect(parseOpenSpecChangeRoot(raw)).toBe("/companions/a/openspec/changes/add-foo");
  });

  test("rejects malformed JSON", () => {
    expect(() => parseOpenSpecChangeRoot("not json")).toThrow(InvalidOpenSpecResponseError);
  });

  test("rejects a response missing changeRoot", () => {
    expect(() => parseOpenSpecChangeRoot(JSON.stringify({}))).toThrow(InvalidOpenSpecResponseError);
  });
});
