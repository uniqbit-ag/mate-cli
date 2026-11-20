import { describe, expect, it } from "bun:test";

import { validateWorkAction } from "./work";

const companion = "0123456789";

describe("Work server function input", () => {
  it("passes a well-formed request through, bounded", () => {
    const request = {
      action: "claim" as const,
      workset: "acme-login",
      members: ["acme-login-api"],
      key: "k-1",
    };
    expect(validateWorkAction({ companion, request })).toEqual({ companion, request });
  });

  it.each([
    [{ companion: "../etc", request: { action: "refresh" } }, "no registered companion"],
    [{ companion, request: { action: "merge" } }, "unknown Work action"],
    [{ companion, request: { action: "transfer", workset: "acme" } }, "unknown Work action"],
    [{ companion, request: { action: "park", workset: "../acme" } }, "not a valid name"],
    [
      { companion, request: { action: "dispatch", workset: "acme", mode: "yolo", members: [] } },
      "mode",
    ],
    [{ companion, request: { action: "capture", text: "x".repeat(70_000) } }, "too long"],
    [
      { companion, request: { action: "claim", workset: "acme", members: [], key: "$(evil)" } },
      "key",
    ],
  ])("refuses %j", (input, reason) => {
    expect(() => validateWorkAction(input as never)).toThrow(reason);
  });

  it("drops fields an action does not take", () => {
    expect(
      validateWorkAction({
        companion,
        request: { action: "park", workset: "acme", extra: "x" } as never,
      }),
    ).toEqual({ companion, request: { action: "park", workset: "acme" } });
    expect(
      validateWorkAction({
        companion,
        request: {
          action: "share",
          workset: "acme",
          hash: "h",
          choice: "keep-mine",
          key: "k",
        } as never,
      }),
    ).toEqual({
      companion,
      request: { action: "share", workset: "acme", hash: "h", include: [], key: "k" },
    });
  });
});
