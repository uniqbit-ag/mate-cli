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
    expect(actionPrompt("submit", "claude", "acme-queue")).toBe("/mate-submit-change acme-queue");
    expect(actionPrompt("publish", "claude", "2026-11-06-acme-queue")).toBe(
      "/mate-publish-artifact 2026-11-06-acme-queue",
    );
  });

  test("OpenCode gets a plain request naming the skill and the item", () => {
    expect(actionPrompt("submit", "opencode", "acme-queue")).toBe(
      "Use the mate-submit-change skill on change acme-queue.",
    );
    expect(actionPrompt("publish", "opencode", "2026-11-06-acme-queue")).toBe(
      "Use the mate-publish-artifact skill to publish 2026-11-06-acme-queue.",
    );
  });

  test("the date of an archive anchor does not count toward the name's length", () => {
    expect(actionPrompt("publish", "claude", `2026-11-06-${"a".repeat(64)}`)).not.toBeNull();
  });

  test.each(["", "Acme", "acme queue", "acme;rm", "-acme", "acme'x", "a".repeat(65)])(
    "rejects %p",
    (name) => {
      expect(actionPrompt("submit", "claude", name)).toBeNull();
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

  test("reads multi-line flow lists, quoted keys, and aliases", () => {
    expect(parseAllowedAgents("allowedAgents: [\n  claude,\n  opencode,\n]\n")).toEqual([
      "claude",
      "opencode",
    ]);
    expect(parseAllowedAgents('"allowedAgents": [claude]\n')).toEqual(["claude"]);
    expect(
      parseAllowedAgents("defaults: &agents [claude, opencode]\nallowedAgents: *agents\n"),
    ).toEqual(["claude", "opencode"]);
  });

  test("is undefined for invalid YAML or a non-list value", () => {
    expect(parseAllowedAgents("allowedAgents: [claude\n")).toBeUndefined();
    expect(parseAllowedAgents("allowedAgents: claude\n")).toBeUndefined();
    expect(parseAllowedAgents("- claude\n")).toBeUndefined();
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
