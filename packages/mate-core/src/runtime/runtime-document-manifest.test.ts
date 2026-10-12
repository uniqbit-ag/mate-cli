import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  EMPTY_MANIFEST,
  copies,
  documentRuntime,
  documents,
  links,
  manifestPath,
  parseManifest,
  readManifestSync,
  recordedMapKeys,
  serializeManifest,
  withCopies,
  withDocument,
  withLinks,
  withoutDocuments,
  wrappedFor,
  OPENCODE_CONFIG_DOCUMENT,
  OPENCODE_MCP_SERVERS_AT,
  mateDeclaredOpenCodeMcpServers,
  type ManagedRegion,
  type Manifest,
} from "./runtime-document-manifest";

const CLAUDE_REGIONS: ManagedRegion[] = [
  { at: ["enabledPlugins"], kind: "map", entries: { "mate@mate": true } },
];
const OPENCODE_REGIONS: ManagedRegion[] = [
  { at: ["mcp", "servers"], kind: "map", entries: { tokensave: { type: "local" } } },
  { at: ["plugin"], kind: "list", values: ["mate"] },
];

/** Bytes the writer produced before this module owned the format. */
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const FIXTURES = {
  documentsOnly: json({
    documents: {
      ".claude/settings.local.json": CLAUDE_REGIONS,
      ".opencode/opencode.json": OPENCODE_REGIONS,
    },
    runtimes: {
      ".claude/settings.local.json": "claude",
      ".opencode/opencode.json": "opencode",
    },
  }),
  documentsAndCopies: json({
    documents: {
      ".claude/settings.local.json": CLAUDE_REGIONS,
      ".opencode/opencode.json": OPENCODE_REGIONS,
    },
    runtimes: {
      ".claude/settings.local.json": "claude",
      ".opencode/opencode.json": "opencode",
    },
    copies: { ".opencode/command/a.md": { runtime: "opencode", sha256: "abc" } },
  }),
  copiesOnly: json({
    documents: {},
    copies: {
      ".opencode/command/a.md": { runtime: "opencode", sha256: "abc" },
      ".opencode/agent/b.md": { runtime: "opencode", sha256: "def" },
    },
  }),
  documentsAndLinks: json({
    documents: { ".opencode/opencode.json": OPENCODE_REGIONS },
    runtimes: { ".opencode/opencode.json": "opencode" },
    links: { ".claude/skills/acme": { runtime: "claude", target: "/acme/.claude/skills/acme" } },
  }),
  linksOnly: json({
    documents: {},
    links: { ".claude/skills/acme": { runtime: "claude", target: "/acme/.claude/skills/acme" } },
  }),
  legacyUntagged: json({
    documents: {
      ".opencode/opencode.json": OPENCODE_REGIONS,
      ".claude/settings.local.json": CLAUDE_REGIONS,
    },
  }),
  legacyRewritten: json({
    documents: {
      ".opencode/opencode.json": OPENCODE_REGIONS,
      ".claude/settings.local.json": CLAUDE_REGIONS,
    },
    runtimes: {
      ".opencode/opencode.json": "opencode",
      ".claude/settings.local.json": "claude",
    },
  }),
};

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function repoWithManifest(contents: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mate-manifest-"));
  tempRoots.push(repo);
  fs.mkdirSync(path.dirname(manifestPath(repo)), { recursive: true });
  fs.writeFileSync(manifestPath(repo), contents);
  return repo;
}

describe("parseManifest", () => {
  test.each([
    ["null", null],
    ["invalid JSON", "{not json"],
    ["a non-object", "[1, 2]"],
    ["a string", '"documents"'],
  ])("reads %s as the empty manifest", (_, raw) => {
    expect(parseManifest(raw)).toEqual(EMPTY_MANIFEST);
  });

  test("tolerates missing runtimes and copies", () => {
    const manifest = parseManifest(FIXTURES.legacyUntagged);
    expect(Object.keys(manifest.documents)).toEqual([
      ".opencode/opencode.json",
      ".claude/settings.local.json",
    ]);
    expect(manifest.runtimes).toEqual({});
    expect(manifest.copies).toEqual({});
  });

  test("drops non-object fields rather than failing", () => {
    expect(parseManifest(json({ documents: [], runtimes: "x", copies: 3 }))).toEqual(
      EMPTY_MANIFEST,
    );
  });
});

describe("documentRuntime", () => {
  test("attributes .opencode/** to OpenCode and everything else to Claude", () => {
    expect(documentRuntime(".opencode/opencode.json")).toBe("opencode");
    expect(documentRuntime(".opencode/nested/file.json")).toBe("opencode");
    expect(documentRuntime(".claude/settings.local.json")).toBe("claude");
    expect(documentRuntime(".mcp.json")).toBe("claude");
    expect(documentRuntime("~/.claude.json")).toBe("claude");
  });
});

describe("queries", () => {
  test("wrappedFor counts documents", () => {
    const manifest = parseManifest(FIXTURES.documentsOnly);
    expect(wrappedFor(manifest, "claude")).toBe(true);
    expect(wrappedFor(manifest, "opencode")).toBe(true);
    const claudeOnly = withoutDocuments(manifest, [OPENCODE_CONFIG_DOCUMENT]);
    expect(wrappedFor(claudeOnly, "claude")).toBe(true);
    expect(wrappedFor(claudeOnly, "opencode")).toBe(false);
  });

  test("wrappedFor counts copies alone", () => {
    const manifest = parseManifest(FIXTURES.copiesOnly);
    expect(wrappedFor(manifest, "opencode")).toBe(true);
    expect(wrappedFor(manifest, "claude")).toBe(false);
  });

  test("wrappedFor counts links alone", () => {
    const manifest = parseManifest(FIXTURES.linksOnly);
    expect(wrappedFor(manifest, "claude")).toBe(true);
    expect(wrappedFor(manifest, "opencode")).toBe(false);
  });

  test("links filters by runtime", () => {
    const manifest = parseManifest(FIXTURES.documentsAndLinks);
    expect(links(manifest, "claude")).toEqual({
      ".claude/skills/acme": { runtime: "claude", target: "/acme/.claude/skills/acme" },
    });
    expect(links(manifest, "opencode")).toEqual({});
  });

  test("recordedMapKeys lists a map region's keys at an address", () => {
    const manifest = parseManifest(FIXTURES.documentsOnly);
    expect(recordedMapKeys(manifest, OPENCODE_CONFIG_DOCUMENT, ["mcp", "servers"])).toEqual([
      "tokensave",
    ]);
    expect(recordedMapKeys(manifest, OPENCODE_CONFIG_DOCUMENT, ["plugin"])).toEqual([]);
    expect(recordedMapKeys(EMPTY_MANIFEST, OPENCODE_CONFIG_DOCUMENT, ["mcp", "servers"])).toEqual(
      [],
    );
  });

  test.each([
    ["regions that are not a list", { [OPENCODE_CONFIG_DOCUMENT]: { kind: "map" } }],
    ["a region that is not an object", { [OPENCODE_CONFIG_DOCUMENT]: [null, 3] }],
    [
      "a region without an address",
      { [OPENCODE_CONFIG_DOCUMENT]: [{ kind: "map", entries: { acme: {} } }] },
    ],
    [
      "a map region without entries",
      { [OPENCODE_CONFIG_DOCUMENT]: [{ at: ["mcp", "servers"], kind: "map", entries: null }] },
    ],
  ])("recordedMapKeys reads %s as no keys", (_, recorded) => {
    const manifest = parseManifest(json({ documents: recorded }));
    expect(recordedMapKeys(manifest, OPENCODE_CONFIG_DOCUMENT, ["mcp", "servers"])).toEqual([]);
  });

  test("wrappedFor is false for the empty manifest", () => {
    expect(wrappedFor(EMPTY_MANIFEST, "claude")).toBe(false);
    expect(wrappedFor(EMPTY_MANIFEST, "opencode")).toBe(false);
  });

  test("documents filters by the recorded runtime", () => {
    const manifest = parseManifest(
      json({
        documents: { "custom.json": [], ".opencode/opencode.json": [] },
        runtimes: { "custom.json": "opencode" },
      }),
    );
    expect(documents(manifest)).toEqual(["custom.json", ".opencode/opencode.json"]);
    expect(documents(manifest, "opencode")).toEqual(["custom.json", ".opencode/opencode.json"]);
    expect(documents(manifest, "claude")).toEqual([]);
  });

  test("documents falls back to the legacy rule without a tag", () => {
    const manifest = parseManifest(FIXTURES.legacyUntagged);
    expect(documents(manifest, "opencode")).toEqual([".opencode/opencode.json"]);
    expect(documents(manifest, "claude")).toEqual([".claude/settings.local.json"]);
  });

  test("copies filters by runtime", () => {
    const manifest = parseManifest(FIXTURES.documentsAndCopies);
    expect(Object.keys(copies(manifest))).toEqual([".opencode/command/a.md"]);
    expect(Object.keys(copies(manifest, "opencode"))).toEqual([".opencode/command/a.md"]);
    expect(copies(manifest, "claude")).toEqual({});
  });
});

describe("edits", () => {
  test("withDocument records and withdraws without mutating", () => {
    const before: Manifest = parseManifest(FIXTURES.copiesOnly);
    const snapshot = structuredClone(before);
    const added = withDocument(before, OPENCODE_CONFIG_DOCUMENT, OPENCODE_REGIONS);
    expect(added.documents[OPENCODE_CONFIG_DOCUMENT]).toEqual(OPENCODE_REGIONS);
    expect(before).toEqual(snapshot);

    const withdrawn = withDocument(added, OPENCODE_CONFIG_DOCUMENT, undefined);
    expect(documents(withdrawn)).toEqual([]);
    expect(added.documents[OPENCODE_CONFIG_DOCUMENT]).toEqual(OPENCODE_REGIONS);
  });

  test("withoutDocuments removes several without mutating", () => {
    const before = parseManifest(FIXTURES.documentsAndCopies);
    const snapshot = structuredClone(before);
    const after = withoutDocuments(before, [
      OPENCODE_CONFIG_DOCUMENT,
      ".claude/settings.local.json",
    ]);
    expect(documents(after)).toEqual([]);
    expect(Object.keys(copies(after))).toEqual([".opencode/command/a.md"]);
    expect(before).toEqual(snapshot);
  });

  test("withCopies replaces one runtime's copies without mutating", () => {
    const before = parseManifest(FIXTURES.documentsAndCopies);
    const snapshot = structuredClone(before);
    const after = withCopies(before, "opencode", {
      ".opencode/agent/b.md": { runtime: "opencode", sha256: "def" },
    });
    expect(Object.keys(copies(after))).toEqual([".opencode/agent/b.md"]);
    expect(documents(after)).toEqual(documents(before));
    expect(before).toEqual(snapshot);
    expect(copies(withCopies(after, "opencode", {}))).toEqual({});
  });
});

describe("serializeManifest", () => {
  test.each([
    ["documents only", FIXTURES.documentsOnly],
    ["documents and copies", FIXTURES.documentsAndCopies],
    ["copies only", FIXTURES.copiesOnly],
    ["documents and links", FIXTURES.documentsAndLinks],
    ["links only", FIXTURES.linksOnly],
  ])("round-trips %s byte for byte", (_, fixture) => {
    expect(serializeManifest(parseManifest(fixture))).toBe(fixture);
  });

  test("tags a legacy manifest's documents exactly as the earlier writer did", () => {
    expect(serializeManifest(parseManifest(FIXTURES.legacyUntagged))).toBe(
      FIXTURES.legacyRewritten,
    );
  });

  test("returns null when neither documents nor copies are recorded", () => {
    expect(serializeManifest(EMPTY_MANIFEST)).toBeNull();
    const emptied = withCopies(
      withoutDocuments(parseManifest(FIXTURES.documentsAndCopies), [
        ".claude/settings.local.json",
        OPENCODE_CONFIG_DOCUMENT,
      ]),
      "opencode",
      {},
    );
    expect(serializeManifest(emptied)).toBeNull();
    expect(
      serializeManifest(withLinks(parseManifest(FIXTURES.linksOnly), "claude", {})),
    ).toBeNull();
  });

  test("withLinks replaces one runtime's links without mutating", () => {
    const manifest = parseManifest(FIXTURES.documentsAndLinks);
    const next = withLinks(manifest, "claude", {
      ".claude/skills/other": { runtime: "claude", target: "/other" },
    });
    expect(links(next)).toEqual({
      ".claude/skills/other": { runtime: "claude", target: "/other" },
    });
    expect(links(manifest)).toEqual({
      ".claude/skills/acme": { runtime: "claude", target: "/acme/.claude/skills/acme" },
    });
  });

  test("records documents built by edits in the earlier writer's shape", () => {
    const built = withCopies(
      withDocument(
        withDocument(EMPTY_MANIFEST, ".claude/settings.local.json", CLAUDE_REGIONS),
        OPENCODE_CONFIG_DOCUMENT,
        OPENCODE_REGIONS,
      ),
      "opencode",
      { ".opencode/command/a.md": { runtime: "opencode", sha256: "abc" } },
    );
    expect(serializeManifest(built)).toBe(FIXTURES.documentsAndCopies);
  });
});

describe("readManifestSync", () => {
  test("reads the manifest at the Projection Root", () => {
    const repo = repoWithManifest(FIXTURES.documentsAndCopies);
    expect(readManifestSync(repo)).toEqual(parseManifest(FIXTURES.documentsAndCopies));
  });

  test("reads an absent manifest as empty", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mate-manifest-"));
    tempRoots.push(repo);
    expect(readManifestSync(repo)).toEqual(EMPTY_MANIFEST);
  });
});

describe("mateDeclaredOpenCodeMcpServers", () => {
  test("lists the servers in the region at the shared address", () => {
    expect(OPENCODE_MCP_SERVERS_AT).toEqual(["mcp", "servers"]);
    const repo = repoWithManifest(FIXTURES.documentsOnly);
    expect(mateDeclaredOpenCodeMcpServers(repo)).toEqual(["tokensave"]);
  });

  test("lists nothing for a malformed hand-edited region instead of throwing", () => {
    const repo = repoWithManifest(
      json({ documents: { [OPENCODE_CONFIG_DOCUMENT]: [{ at: "mcp", kind: "map", entries: 1 }] } }),
    );
    expect(mateDeclaredOpenCodeMcpServers(repo)).toEqual([]);
  });

  test("lists nothing when the wrap declared no OpenCode servers", () => {
    expect(mateDeclaredOpenCodeMcpServers(repoWithManifest(FIXTURES.copiesOnly))).toEqual([]);
  });
});
