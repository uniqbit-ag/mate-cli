import { describe, expect, test } from "bun:test";

import { isDeclinedByMember } from "./member-choices";

describe("isDeclinedByMember", () => {
  const read = async () => ({ rtk: "declined" as const, tokensave: "accepted" as const });

  test("is true only when every listed capability was declined", async () => {
    expect(await isDeclinedByMember("/acme", ["rtk"], read)).toBe(true);
    expect(await isDeclinedByMember("/acme", ["rtk", "tokensave"], read)).toBe(false);
    expect(await isDeclinedByMember("/acme", ["graphify"], read)).toBe(false);
  });

  test("is false for no capabilities", async () => {
    expect(await isDeclinedByMember("/acme", [], read)).toBe(false);
  });
});
