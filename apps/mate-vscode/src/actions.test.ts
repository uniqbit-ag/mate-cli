import { describe, expect, test } from "bun:test";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  actionPrompt,
  changeActionAgents,
  parseAllowedAgents,
  readChangeActionAgents,
} from "./actions";

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

describe("parseAllowedAgents", () => {
  test("reads block and flow lists, quotes, and comments", () => {
    expect(
      parseAllowedAgents("version: 1\nallowedAgents:\n  - claude\n  - opencode\ngit: auto\n"),
    ).toEqual(["claude", "opencode"]);
    expect(parseAllowedAgents("allowedAgents:\n- 'opencode' # first\n- \"claude\"\n")).toEqual([
      "opencode",
      "claude",
    ]);
    expect(parseAllowedAgents("allowedAgents: [codex, claude]\n")).toEqual(["codex", "claude"]);
    expect(parseAllowedAgents("allowedAgents: []\n")).toEqual([]);
  });

  test("falls back to profiles.default, and ignores nested or absent keys", () => {
    const legacy = "profiles:\n  default:\n    allowedAgents:\n      - opencode\n";
    expect(parseAllowedAgents(legacy)).toEqual(["opencode"]);
    expect(parseAllowedAgents(`allowedAgents: null\n${legacy}`)).toEqual(["opencode"]);
    expect(
      parseAllowedAgents("profiles:\n  other:\n    allowedAgents: [claude]\n"),
    ).toBeUndefined();
    expect(parseAllowedAgents("engines:\n  allowedAgents: [claude]\n")).toBeUndefined();
    expect(parseAllowedAgents("# allowedAgents: [claude]\n")).toBeUndefined();
  });
});

describe("changeActionAgents", () => {
  test("are the entries the sidebar can start, Claude first", () => {
    expect(changeActionAgents(["codex", "opencode", "claude"])).toEqual(["claude", "opencode"]);
    expect(changeActionAgents(["pi", "opencode"])).toEqual(["opencode"]);
    expect(changeActionAgents(["codex", "pi"])).toEqual([]);
    expect(changeActionAgents(undefined)).toEqual([]);
  });

  test("reads the linked companion's framework.yaml", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "acme-agents-"));
    try {
      expect(await readChangeActionAgents(repo)).toEqual([]);
      const config = path.join(repo, ".mate/companion/.mate/config");
      await fs.mkdir(config, { recursive: true });
      await fs.writeFile(
        path.join(config, "framework.yaml"),
        "allowedAgents:\n  - pi\n  - claude\n",
      );
      expect(await readChangeActionAgents(repo)).toEqual(["claude"]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});
