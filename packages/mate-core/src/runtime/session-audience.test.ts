import { describe, expect, test } from "bun:test";

import {
  describeAudienceConflict,
  resolveSessionAudience,
  type SessionAudience,
  type SessionAudienceInput,
} from "./session-audience";

const declared = ["ba", "qa"];

function resolve(input: Omit<SessionAudienceInput, "declared">): SessionAudience {
  return resolveSessionAudience({ ...input, declared });
}

describe("resolveSessionAudience", () => {
  const cases: Array<[string, Omit<SessionAudienceInput, "declared">, SessionAudience]> = [
    ["bare, unwrapped", { session: "bare", wrapped: null, requested: null }, { kind: "base" }],
    [
      "bare, unwrapped, stray MATE_AUDIENCE",
      { session: "bare", wrapped: null, requested: "ba" },
      { kind: "base" },
    ],
    [
      "bare, wrapped",
      { session: "bare", wrapped: "ba", requested: null },
      { kind: "wrap", audience: "ba" },
    ],
    [
      "bare, wrapped, another MATE_AUDIENCE",
      { session: "bare", wrapped: "ba", requested: "qa" },
      { kind: "wrap", audience: "ba" },
    ],
    [
      "managed, unwrapped",
      { session: "managed", wrapped: null, requested: null },
      { kind: "base" },
    ],
    [
      "managed, unwrapped, MATE_AUDIENCE",
      { session: "managed", wrapped: null, requested: "ba" },
      { kind: "launch", audience: "ba" },
    ],
    [
      "managed, MATE_AUDIENCE=base",
      { session: "managed", wrapped: null, requested: "base" },
      { kind: "base" },
    ],
    [
      "managed, undeclared MATE_AUDIENCE",
      { session: "managed", wrapped: null, requested: "ops" },
      { kind: "base" },
    ],
    [
      "managed, wrapped",
      { session: "managed", wrapped: "ba", requested: null },
      { kind: "wrap", audience: "ba" },
    ],
    [
      "managed, wrapped, same MATE_AUDIENCE",
      { session: "managed", wrapped: "ba", requested: "ba" },
      { kind: "wrap", audience: "ba" },
    ],
    [
      "managed, wrapped, undeclared MATE_AUDIENCE",
      { session: "managed", wrapped: "ba", requested: "ops" },
      { kind: "wrap", audience: "ba" },
    ],
    [
      "managed, wrapped, another MATE_AUDIENCE",
      { session: "managed", wrapped: "ba", requested: "qa" },
      { kind: "conflict", wrapped: "ba", requested: "qa" },
    ],
  ];

  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(resolve(input)).toEqual(expected);
    });
  }
});

describe("describeAudienceConflict", () => {
  test("names both audiences and both ways out", () => {
    const message = describeAudienceConflict(
      { kind: "conflict", wrapped: "ba", requested: "qa" },
      { id: "app", path: "/work/app" },
    );
    for (const part of ['"ba"', '"qa"', "wrap --audience qa", "/work/app", "worktree"]) {
      expect(message).toContain(part);
    }
  });
});
