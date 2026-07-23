import { describe, expect, test } from "bun:test";

describe("adapter module imports", () => {
  test("load without side effects", async () => {
    await import("./opencode");
    expect(true).toBe(true);
  });
});
