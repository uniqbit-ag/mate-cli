import { describe, expect, test } from "bun:test";

import {
  findAction,
  specActionOffers,
  promptArgs,
  skillInstalledFor,
  SUBJECT_PATTERN,
} from "./actions";

describe("studio actions", () => {
  const show = findAction("show-me")!;

  test("registers show-me for specs", () => {
    expect(show).toMatchObject({ skill: "mate-show-me", label: "Show me", subject: "spec" });
    expect(findAction("rm-rf")).toBeNull();
    expect(findAction(undefined)).toBeNull();
  });

  test("builds the per-agent prompt", () => {
    expect(promptArgs(show, "claude", "acme-capability")).toEqual([
      "/mate-show-me acme-capability",
    ]);
    expect(promptArgs(show, "opencode", "acme-capability")).toEqual([
      "--prompt",
      "Use the mate-show-me skill on spec acme-capability.",
    ]);
  });

  test("subjects are safe names", () => {
    expect(SUBJECT_PATTERN.test("acme-capability")).toBe(true);
    for (const bad of ["-x", "a b", "A", "a;b", "", "a".repeat(65)]) {
      expect(SUBJECT_PATTERN.test(bad)).toBe(false);
    }
  });

  test("skill trees per agent", () => {
    const inventory = { claude: ["mate-show-me"], opencode: [], agents: [] };
    expect(skillInstalledFor(inventory, "mate-show-me", "claude")).toBe(true);
    expect(skillInstalledFor(inventory, "mate-show-me", "opencode")).toBe(false);
    expect(
      skillInstalledFor(
        { claude: [], opencode: [], agents: ["mate-show-me"] },
        "mate-show-me",
        "opencode",
      ),
    ).toBe(true);
    expect(
      skillInstalledFor(
        { claude: [], opencode: [], agents: ["mate-show-me"] },
        "mate-show-me",
        "claude",
      ),
    ).toBe(false);
  });

  describe("specActionOffers", () => {
    const inventory = { claude: ["mate-show-me"], opencode: ["mate-show-me"], agents: [] };
    const terminal = {
      target: { path: "/c/acme" },
      agents: ["claude" as const, "opencode" as const],
    };

    test("runs on every launchable agent with the skill when the terminal targets the companion", () => {
      const [offer] = specActionOffers("/c/acme", inventory, terminal);
      expect(offer!.runAgents).toEqual(["claude", "opencode"]);
      expect(offer!.copyAgents).toEqual(["claude", "opencode"]);
    });

    test("only agents that are launchable run", () => {
      const [offer] = specActionOffers("/c/acme", inventory, { ...terminal, agents: ["opencode"] });
      expect(offer!.runAgents).toEqual(["opencode"]);
    });

    test("no terminal or a pinned mismatch leaves copy only", () => {
      expect(specActionOffers("/c/acme", inventory, null)[0]!.runAgents).toEqual([]);
      expect(specActionOffers("/c/other", inventory, terminal)[0]!.runAgents).toEqual([]);
      expect(specActionOffers("/c/other", inventory, terminal)[0]!.copyAgents).toEqual([
        "claude",
        "opencode",
      ]);
    });

    test("no installed skill offers nothing", () => {
      expect(
        specActionOffers("/c/acme", { claude: [], opencode: [], agents: [] }, terminal),
      ).toEqual([]);
      expect(specActionOffers("/c/acme", undefined, terminal)).toEqual([]);
    });
  });
});
