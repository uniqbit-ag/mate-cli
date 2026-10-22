import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  claudeUserConfigDir,
  definesUserClaudeAttribution,
  MANAGED_CLAUDE_ATTRIBUTION,
} from "./claude-attribution";

const tempRoots: string[] = [];

function fixture(): { userConfigDir: string; repoRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-attribution-"));
  tempRoots.push(root);
  const userConfigDir = path.join(root, "user");
  const repoRoot = path.join(root, "repo");
  fs.mkdirSync(userConfigDir, { recursive: true });
  fs.mkdirSync(path.join(repoRoot, ".claude"), { recursive: true });
  return { userConfigDir, repoRoot };
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("MANAGED_CLAUDE_ATTRIBUTION", () => {
  test("is the object form that hides every attribution", () => {
    expect(MANAGED_CLAUDE_ATTRIBUTION).toEqual({ commit: "", pr: "", sessionUrl: false });
  });
});

describe("definesUserClaudeAttribution", () => {
  test("is false when no scope defines attribution", () => {
    const scopes = fixture();
    writeJson(path.join(scopes.userConfigDir, "settings.json"), { model: "opus" });
    expect(definesUserClaudeAttribution(scopes)).toBe(false);
  });

  test("is true for custom attribution in the user settings", () => {
    const scopes = fixture();
    writeJson(path.join(scopes.userConfigDir, "settings.json"), {
      attribution: { commit: "Generated with AI" },
    });
    expect(definesUserClaudeAttribution(scopes)).toBe(true);
  });

  test("is true for attribution in the project settings", () => {
    const scopes = fixture();
    writeJson(path.join(scopes.repoRoot, ".claude", "settings.json"), {
      attribution: { pr: "Built with AI" },
    });
    expect(definesUserClaudeAttribution(scopes)).toBe(true);
    expect(definesUserClaudeAttribution({ userConfigDir: scopes.userConfigDir })).toBe(false);
  });

  test("is true for the deprecated includeCoAuthoredBy, whatever its value", () => {
    const scopes = fixture();
    writeJson(path.join(scopes.repoRoot, ".claude", "settings.local.json"), {
      includeCoAuthoredBy: false,
    });
    expect(definesUserClaudeAttribution(scopes)).toBe(true);
  });

  test("is false for Mate's own wrapped value", () => {
    const scopes = fixture();
    writeJson(path.join(scopes.repoRoot, ".claude", "settings.local.json"), {
      attribution: { ...MANAGED_CLAUDE_ATTRIBUTION },
    });
    expect(definesUserClaudeAttribution(scopes)).toBe(false);
  });

  test("is false for an unreadable or invalid file", () => {
    const scopes = fixture();
    writeJson(path.join(scopes.userConfigDir, "settings.json"), "{ not json");
    fs.mkdirSync(path.join(scopes.repoRoot, ".claude", "settings.json"));
    expect(definesUserClaudeAttribution(scopes)).toBe(false);
  });
});

describe("claudeUserConfigDir", () => {
  test("honours CLAUDE_CONFIG_DIR, else ~/.claude", () => {
    expect(claudeUserConfigDir({ CLAUDE_CONFIG_DIR: "/cfg" })).toBe(path.normalize("/cfg"));
    expect(claudeUserConfigDir({ HOME: "/home/me" })).toBe(path.join("/home/me", ".claude"));
  });
});
