import { describe, expect, test } from "bun:test";

import { pairingFromCommandArg } from "./command-args";

const PAIRING = {
  companionPath: "/companions/a",
  repository: { id: "app", path: "/repos/app" },
  health: "ready" as const,
  ambiguous: false,
};

describe("pairingFromCommandArg", () => {
  test("extracts the pairing from a pairing tree node", () => {
    expect(
      pairingFromCommandArg({
        kind: "pairing",
        pairing: PAIRING,
        contextValue: "pairing",
        description: "x",
      }),
    ).toEqual(PAIRING);
  });

  test("returns undefined for a non-pairing node", () => {
    expect(pairingFromCommandArg({ kind: "empty" })).toBeUndefined();
  });

  test("returns undefined for undefined/null/primitive args", () => {
    expect(pairingFromCommandArg(undefined)).toBeUndefined();
    expect(pairingFromCommandArg(null)).toBeUndefined();
    expect(pairingFromCommandArg("nope")).toBeUndefined();
  });
});
