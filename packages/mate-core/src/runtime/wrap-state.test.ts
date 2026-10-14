import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  CLAUDE_SETTINGS_DOCUMENT,
  EMPTY_MANIFEST,
  OPENCODE_CONFIG_DOCUMENT,
  manifestPath,
  parseManifest,
  type ManagedRegion,
} from "./runtime-document-manifest";
import { readWrapState, readWrapStateSync, wrapStateOf } from "./wrap-state";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const GUARD = { matcher: "Edit", hooks: [{ type: "command", command: "/acme/guard.mjs" }] };
const BANNER = { hooks: [{ type: "command", command: "/acme/banner.mjs" }] };

const CLAUDE_REGIONS: ManagedRegion[] = [
  { at: ["hooks", "PreToolUse"], kind: "list", values: [GUARD] },
  { at: ["hooks", "SessionStart"], kind: "list", values: [BANNER] },
  { at: ["enabledPlugins"], kind: "map", entries: { "mate@mate": true } },
];
const OPENCODE_REGIONS: ManagedRegion[] = [
  { at: ["mcp", "servers"], kind: "map", entries: { tokensave: { type: "local" } } },
  { at: ["plugin"], kind: "list", values: ["mate"] },
];

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mate-wrap-state-"));
  tempRoots.push(repo);
  return repo;
}

function repoWithManifest(contents: string): string {
  const repo = tempRepo();
  fs.mkdirSync(path.dirname(manifestPath(repo)), { recursive: true });
  fs.writeFileSync(manifestPath(repo), contents);
  return repo;
}

/** A manifest path that exists but cannot be read as a file. */
function repoWithUnreadableManifest(): string {
  const repo = tempRepo();
  fs.mkdirSync(manifestPath(repo), { recursive: true });
  return repo;
}

describe("wrapStateOf", () => {
  test("names each runtime with a recorded document, copy or link", () => {
    const state = wrapStateOf(
      parseManifest(
        json({
          documents: { [CLAUDE_SETTINGS_DOCUMENT]: CLAUDE_REGIONS },
          runtimes: { [CLAUDE_SETTINGS_DOCUMENT]: "claude" },
          copies: { ".opencode/command/a.md": { runtime: "opencode", sha256: "abc" } },
        }),
      ),
    );
    expect([...state.runtimes].sort()).toEqual(["claude", "opencode"]);

    const linksOnly = wrapStateOf(
      parseManifest(
        json({
          documents: {},
          links: { ".claude/skills/acme": { runtime: "claude", target: "/acme/skills/acme" } },
        }),
      ),
    );
    expect([...linksOnly.runtimes]).toEqual(["claude"]);
  });

  test("the empty manifest is wrapped for nothing and carries nothing", () => {
    const state = wrapStateOf(EMPTY_MANIFEST);
    expect(state.runtimes.size).toBe(0);
    expect(state.carriedClaudeHookGroups).toEqual([]);
    expect(state.openCodeMcpServers).toEqual([]);
    expect(state.carriesClaudeHookGroup(GUARD)).toBe(false);
  });

  test("a legacy untagged manifest is attributed by document path", () => {
    const state = wrapStateOf(
      parseManifest(json({ documents: { [OPENCODE_CONFIG_DOCUMENT]: OPENCODE_REGIONS } })),
    );
    expect([...state.runtimes]).toEqual(["opencode"]);
  });

  test("carries the hook groups recorded in the settings document, by structure", () => {
    const state = wrapStateOf(
      parseManifest(json({ documents: { [CLAUDE_SETTINGS_DOCUMENT]: CLAUDE_REGIONS } })),
    );
    expect(state.carriedClaudeHookGroups).toEqual([GUARD, BANNER]);
    expect(state.carriesClaudeHookGroup(structuredClone(GUARD))).toBe(true);
    expect(state.carriesClaudeHookGroup({ ...GUARD, matcher: "Write" })).toBe(false);
  });

  test("lists the OpenCode MCP servers the wrap declared", () => {
    const state = wrapStateOf(
      parseManifest(json({ documents: { [OPENCODE_CONFIG_DOCUMENT]: OPENCODE_REGIONS } })),
    );
    expect(state.openCodeMcpServers).toEqual(["tokensave"]);
  });

  test("a malformed hand-edited region reads as nothing instead of throwing", () => {
    const state = wrapStateOf(
      parseManifest(
        json({
          documents: {
            [OPENCODE_CONFIG_DOCUMENT]: [{ at: "mcp", kind: "map", entries: 1 }],
            [CLAUDE_SETTINGS_DOCUMENT]: [{ at: ["hooks"], kind: "list", values: [null, 3] }],
          },
        }),
      ),
    );
    expect(state.openCodeMcpServers).toEqual([]);
    expect(state.carriedClaudeHookGroups).toEqual([]);
  });
});

describe("readWrapStateSync (lenient)", () => {
  test("reads the manifest at the Projection Root", () => {
    const repo = repoWithManifest(
      json({ documents: { [OPENCODE_CONFIG_DOCUMENT]: OPENCODE_REGIONS } }),
    );
    expect([...readWrapStateSync(repo).runtimes]).toEqual(["opencode"]);
  });

  test("an absent manifest reads as not wrapped", () => {
    expect(readWrapStateSync(tempRepo()).runtimes.size).toBe(0);
  });

  test("an unreadable manifest reads as not wrapped", () => {
    expect(readWrapStateSync(repoWithUnreadableManifest()).runtimes.size).toBe(0);
  });
});

describe("readWrapState (strict)", () => {
  test("reads the manifest at the Projection Root", async () => {
    const repo = repoWithManifest(
      json({ documents: { [CLAUDE_SETTINGS_DOCUMENT]: CLAUDE_REGIONS } }),
    );
    const state = await readWrapState(repo);
    expect([...state.runtimes]).toEqual(["claude"]);
    expect(state.carriesClaudeHookGroup(GUARD)).toBe(true);
  });

  test("an absent manifest reads as not wrapped", async () => {
    expect((await readWrapState(tempRepo())).runtimes.size).toBe(0);
  });

  test("an unreadable manifest throws", async () => {
    await expect(readWrapState(repoWithUnreadableManifest())).rejects.toThrow();
  });

  test("a corrupt manifest throws", async () => {
    await expect(readWrapState(repoWithManifest("{ not json"))).rejects.toThrow();
    await expect(readWrapState(repoWithManifest("[]"))).rejects.toThrow();
  });

  test("the lenient read takes a corrupt manifest as not wrapped", () => {
    expect(readWrapStateSync(repoWithManifest("{ not json")).runtimes.size).toBe(0);
  });
});
