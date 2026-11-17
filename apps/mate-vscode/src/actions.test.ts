import { describe, expect, test } from "bun:test";

import { actionPrompt } from "./actions";

describe("actionPrompt", () => {
  test("Claude gets the skill as a slash command", () => {
    expect(actionPrompt("archive", "claude", "acme-queue")).toBe("/mate-archive-change acme-queue");
    expect(actionPrompt("publish", "claude", "2026-11-06-acme-queue")).toBe(
      "/mate-publish-artifact 2026-11-06-acme-queue",
    );
  });

  test("OpenCode gets a plain request naming the skill and the item", () => {
    expect(actionPrompt("archive", "opencode", "acme-queue")).toBe(
      "Use the mate-archive-change skill on change acme-queue.",
    );
    expect(actionPrompt("publish", "opencode", "2026-11-06-acme-queue")).toBe(
      "Use the mate-publish-artifact skill to publish 2026-11-06-acme-queue.",
    );
  });

  test.each(["", "Acme", "acme queue", "acme;rm", "-acme", "acme'x", "a".repeat(65)])(
    "rejects %p",
    (name) => {
      expect(actionPrompt("archive", "claude", name)).toBeNull();
      expect(actionPrompt("publish", "opencode", name)).toBeNull();
    },
  );
});
