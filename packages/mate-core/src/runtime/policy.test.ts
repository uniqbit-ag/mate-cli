import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { companionFrameworkConfigPath, isCapabilityEnabled, readCompanionPolicy } from "./policy";

const tempRoots: string[] = [];

function makeCompanion(contents: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "companion-policy-"));
  tempRoots.push(dir);
  if (contents !== null) {
    const configPath = companionFrameworkConfigPath(dir);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, contents, "utf8");
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("readCompanionPolicy", () => {
  test("reads allowed agents, enabled capabilities, and git auto mode", () => {
    const companionPath = makeCompanion(
      [
        "type: companion",
        "git: auto",
        "allowedAgents:",
        "  - claude",
        "  - opencode",
        "capabilities:",
        "  - name: graphify",
        "  - name: openspec",
        "    schemaProfile: mate-v1",
        "",
      ].join("\n"),
    );

    expect(readCompanionPolicy(companionPath)).toEqual({
      allowedAgents: ["claude", "opencode"],
      enabledCapabilities: ["graphify", "openspec"],
      gitAutoMode: true,
    });
  });

  test("reflects a capability toggle immediately, with no projection involved", () => {
    const companionPath = makeCompanion("capabilities:\n  - name: react-doctor\n");
    expect(isCapabilityEnabled(readCompanionPolicy(companionPath), "react-doctor")).toBe(true);

    fs.writeFileSync(companionFrameworkConfigPath(companionPath), "capabilities: []\n", "utf8");
    expect(isCapabilityEnabled(readCompanionPolicy(companionPath), "react-doctor")).toBe(false);
  });

  test("yields an inert policy for a missing, empty, or unparseable companion config", () => {
    const inert = { allowedAgents: [], enabledCapabilities: [], gitAutoMode: false };
    expect(readCompanionPolicy(makeCompanion(null))).toEqual(inert);
    expect(readCompanionPolicy(makeCompanion(""))).toEqual(inert);
    expect(readCompanionPolicy(makeCompanion("[unbalanced\n"))).toEqual(inert);
    expect(readCompanionPolicy(makeCompanion("allowedAgents: nope\ncapabilities: 3\n"))).toEqual(
      inert,
    );
  });

  test("treats any git mode other than auto as disabled", () => {
    expect(readCompanionPolicy(makeCompanion("git: manual\n")).gitAutoMode).toBe(false);
  });
});
