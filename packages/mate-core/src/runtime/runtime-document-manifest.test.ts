import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { git, initRepo } from "../../test/git-checkouts";
import { readWrapState, readWrapStateSync } from "./wrap-state";
import {
  EMPTY_MANIFEST,
  confineManifest,
  manifestPath,
  readManifestNotices,
  updateManifest,
  copies,
  documentRuntime,
  documents,
  links,
  parseManifest as parseManifestIn,
  recordedMapKeys,
  serializeManifest,
  withCopies,
  withDocument,
  withLinks,
  withoutDocuments,
  OPENCODE_CONFIG_DOCUMENT,
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
/** Confinement pins `~/.claude.json` regions to this root; these fixtures record none. */
const parse = (raw: string | null) => parseManifestIn(raw, "/x/acme");
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
  /** Every destination kind a release recorded, the removal-only `.mcp.json` included. */
  allDestinations: json({
    documents: {
      ".claude/settings.local.json": CLAUDE_REGIONS,
      "~/.claude.json": [
        { at: ["projects", "/x/acme", "mcpServers"], kind: "map", entries: { acme: {} } },
      ],
      ".mcp.json": [{ at: ["mcpServers"], kind: "map", entries: { acme: {} } }],
      ".opencode/opencode.json": OPENCODE_REGIONS,
    },
    runtimes: {
      ".claude/settings.local.json": "claude",
      "~/.claude.json": "claude",
      ".mcp.json": "claude",
      ".opencode/opencode.json": "opencode",
    },
    copies: { ".opencode/command/a.md": { runtime: "opencode", sha256: "abc" } },
    links: {
      ".claude/skills/acme": { runtime: "claude", target: "/acme/.claude/skills/acme" },
      ".claude/commands/acme": { runtime: "claude", target: "/acme/.claude/commands/acme" },
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

describe("parseManifest", () => {
  test.each([
    ["null", null],
    ["invalid JSON", "{not json"],
    ["a non-object", "[1, 2]"],
    ["a string", '"documents"'],
  ])("reads %s as the empty manifest", (_, raw) => {
    expect(parse(raw)).toEqual(EMPTY_MANIFEST);
  });

  test("tolerates missing runtimes and copies", () => {
    const manifest = parse(FIXTURES.legacyUntagged);
    expect(Object.keys(manifest.documents)).toEqual([
      ".opencode/opencode.json",
      ".claude/settings.local.json",
    ]);
    expect(manifest.runtimes).toEqual({});
    expect(manifest.copies).toEqual({});
  });

  test("drops non-object fields rather than failing", () => {
    expect(parse(json({ documents: [], runtimes: "x", copies: 3 }))).toEqual(EMPTY_MANIFEST);
  });
});

describe("confineManifest", () => {
  const OWN_REGION = {
    at: ["projects", "/x/acme", "mcpServers"],
    kind: "map",
    entries: { acme: { command: "acme" } },
  };
  const copy = { runtime: "opencode", sha256: "abc" };
  const link = { runtime: "claude", target: "/acme/.claude/skills/a" };

  test.each([
    ["an escaping document", { documents: { "../acme.json": [] } }, "../acme.json"],
    ["an absolute document", { documents: { "/tmp/acme/x": [] } }, "/tmp/acme/x"],
    [
      "a user-global document outside the set",
      {
        documents: {
          "~/.claude/settings.json": [{ at: ["sandbox", "enabled"], kind: "value", value: false }],
        },
      },
      "~/.claude/settings.json",
    ],
    [
      "a region at another project",
      {
        documents: {
          "~/.claude.json": [{ ...OWN_REGION, at: ["projects", "/x/acme-other", "mcpServers"] }],
        },
      },
      '~/.claude.json region at ["projects","/x/acme-other","mcpServers"]',
    ],
    [
      "a value region",
      { documents: { "~/.claude.json": [{ at: OWN_REGION.at, kind: "value", value: {} }] } },
      '~/.claude.json region at ["projects","/x/acme","mcpServers"]',
    ],
    [
      "a stripping region",
      { documents: { "~/.claude.json": [{ ...OWN_REGION, stripPrefix: "acme" }] } },
      '~/.claude.json region at ["projects","/x/acme","mcpServers"]',
    ],
    ["a copy climbing out", { copies: { ".opencode/../x": copy } }, ".opencode/../x"],
    ["a copy with an empty segment", { copies: { ".opencode//x": copy } }, ".opencode//x"],
    ["a copy holding a newline", { copies: { ".opencode/a\n*": copy } }, ".opencode/a\n*"],
    ["a copy holding a backslash", { copies: { ".opencode/a\\b": copy } }, ".opencode/a\\b"],
    [
      "the merged OpenCode document as a copy",
      { copies: { ".opencode/opencode.json": copy } },
      ".opencode/opencode.json",
    ],
    [
      "an uncopied segment",
      { copies: { ".opencode/node_modules/x": copy } },
      ".opencode/node_modules/x",
    ],
    ["a nested link", { links: { ".claude/skills/a/b": link } }, ".claude/skills/a/b"],
  ])("drops and reports %s", (_, recorded, key) => {
    const { manifest, rejected } = confineManifest(json(recorded), "/x/acme");
    expect(rejected).toEqual([key]);
    expect(manifest).toEqual(EMPTY_MANIFEST);
  });

  test("keeps this repository's own region beside a forged one", () => {
    const forged = { ...OWN_REGION, at: ["projects", "/x/acme-other", "mcpServers"] };
    const { manifest } = confineManifest(
      json({ documents: { "~/.claude.json": [forged, OWN_REGION] } }),
      "/x/acme",
    );
    expect(manifest.documents).toEqual({ "~/.claude.json": [OWN_REGION] });
  });

  test.each(Object.entries(FIXTURES))("rejects nothing an earlier release wrote: %s", (_, raw) => {
    expect(confineManifest(raw, "/x/acme").rejected).toEqual([]);
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
  test("links filters by runtime", () => {
    const manifest = parse(FIXTURES.documentsAndLinks);
    expect(links(manifest, "claude")).toEqual({
      ".claude/skills/acme": { runtime: "claude", target: "/acme/.claude/skills/acme" },
    });
    expect(links(manifest, "opencode")).toEqual({});
  });

  test("recordedMapKeys lists a map region's keys at an address", () => {
    const manifest = parse(FIXTURES.documentsOnly);
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
    const manifest = parse(json({ documents: recorded }));
    expect(recordedMapKeys(manifest, OPENCODE_CONFIG_DOCUMENT, ["mcp", "servers"])).toEqual([]);
  });

  test("documents filters by the recorded runtime", () => {
    const manifest = parse(
      json({
        documents: { ".mcp.json": [], ".opencode/opencode.json": [] },
        runtimes: { ".mcp.json": "opencode" },
      }),
    );
    expect(documents(manifest)).toEqual([".mcp.json", ".opencode/opencode.json"]);
    expect(documents(manifest, "opencode")).toEqual([".mcp.json", ".opencode/opencode.json"]);
    expect(documents(manifest, "claude")).toEqual([]);
  });

  test("documents falls back to the legacy rule without a tag", () => {
    const manifest = parse(FIXTURES.legacyUntagged);
    expect(documents(manifest, "opencode")).toEqual([".opencode/opencode.json"]);
    expect(documents(manifest, "claude")).toEqual([".claude/settings.local.json"]);
  });

  test("copies filters by runtime", () => {
    const manifest = parse(FIXTURES.documentsAndCopies);
    expect(Object.keys(copies(manifest))).toEqual([".opencode/command/a.md"]);
    expect(Object.keys(copies(manifest, "opencode"))).toEqual([".opencode/command/a.md"]);
    expect(copies(manifest, "claude")).toEqual({});
  });
});

describe("edits", () => {
  test("withDocument records and withdraws without mutating", () => {
    const before: Manifest = parse(FIXTURES.copiesOnly);
    const snapshot = structuredClone(before);
    const added = withDocument(before, OPENCODE_CONFIG_DOCUMENT, OPENCODE_REGIONS);
    expect(added.documents[OPENCODE_CONFIG_DOCUMENT]).toEqual(OPENCODE_REGIONS);
    expect(before).toEqual(snapshot);

    const withdrawn = withDocument(added, OPENCODE_CONFIG_DOCUMENT, undefined);
    expect(documents(withdrawn)).toEqual([]);
    expect(added.documents[OPENCODE_CONFIG_DOCUMENT]).toEqual(OPENCODE_REGIONS);
  });

  test("withoutDocuments removes several without mutating", () => {
    const before = parse(FIXTURES.documentsAndCopies);
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
    const before = parse(FIXTURES.documentsAndCopies);
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
    expect(serializeManifest(parse(fixture))).toBe(fixture);
  });

  test("tags a legacy manifest's documents exactly as the earlier writer did", () => {
    expect(serializeManifest(parse(FIXTURES.legacyUntagged))).toBe(FIXTURES.legacyRewritten);
  });

  test("returns null when neither documents nor copies are recorded", () => {
    expect(serializeManifest(EMPTY_MANIFEST)).toBeNull();
    const emptied = withCopies(
      withoutDocuments(parse(FIXTURES.documentsAndCopies), [
        ".claude/settings.local.json",
        OPENCODE_CONFIG_DOCUMENT,
      ]),
      "opencode",
      {},
    );
    expect(serializeManifest(emptied)).toBeNull();
    expect(serializeManifest(withLinks(parse(FIXTURES.linksOnly), "claude", {}))).toBeNull();
  });

  test("withLinks replaces one runtime's links without mutating", () => {
    const manifest = parse(FIXTURES.documentsAndLinks);
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

  test("a prefix scopes withLinks and links to one link root", () => {
    const manifest = withLinks(parse(FIXTURES.documentsAndLinks), "claude", {
      ".claude/skills/acme": { runtime: "claude", target: "/acme/.claude/skills/acme" },
      ".claude/commands/opsx": { runtime: "claude", target: "/acme/.claude/commands/opsx" },
    });

    const commands = withLinks(
      manifest,
      "claude",
      { ".claude/commands/team": { runtime: "claude", target: "/acme/.claude/commands/team" } },
      { prefix: ".claude/commands/" },
    );
    expect(links(commands)).toEqual({
      ".claude/skills/acme": { runtime: "claude", target: "/acme/.claude/skills/acme" },
      ".claude/commands/team": { runtime: "claude", target: "/acme/.claude/commands/team" },
    });

    const skills = withLinks(manifest, "claude", {}, { prefix: ".claude/skills/" });
    expect(links(skills)).toEqual({
      ".claude/commands/opsx": { runtime: "claude", target: "/acme/.claude/commands/opsx" },
    });
    expect(links(manifest, "claude", { prefix: ".claude/commands/" })).toEqual({
      ".claude/commands/opsx": { runtime: "claude", target: "/acme/.claude/commands/opsx" },
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

describe("manifest files", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  /** A fresh path per test: the tracked answer is memoized per repository. */
  function tempRepo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acme-manifest-"));
    roots.push(root);
    return path.join(root, "acme");
  }
  function writeManifest(repo: string, contents: string): void {
    fs.mkdirSync(path.dirname(manifestPath(repo)), { recursive: true });
    fs.writeFileSync(manifestPath(repo), contents);
  }

  test("a rewrite drops a rejected key and keeps Mate's own", async () => {
    const repo = tempRepo();
    writeManifest(
      repo,
      json({
        documents: {
          ".claude/settings.local.json": CLAUDE_REGIONS,
          "~/.claude/settings.json": [{ at: ["sandbox", "enabled"], kind: "value", value: false }],
        },
      }),
    );

    expect(await readManifestNotices(repo)).toEqual([
      expect.stringContaining("records ~/.claude/settings.json, which is not a destination"),
    ]);
    await updateManifest(repo, (manifest) => manifest);

    const written = JSON.parse(fs.readFileSync(manifestPath(repo), "utf8")) as Manifest;
    expect(Object.keys(written.documents)).toEqual([".claude/settings.local.json"]);
  });

  test("a Git-tracked manifest reads as absent and is left as committed", async () => {
    const repo = initRepo(tempRepo());
    const committed = FIXTURES.documentsOnly;
    writeManifest(repo, committed);
    git(repo, "add", "-f", ".mate/runtime-documents.json");
    git(repo, "commit", "-q", "-m", "acme");

    expect(readWrapStateSync(repo).runtimes.size).toBe(0);
    expect((await readWrapState(repo)).runtimes.size).toBe(0);
    await updateManifest(repo, (manifest) =>
      withDocument(manifest, OPENCODE_CONFIG_DOCUMENT, OPENCODE_REGIONS),
    );
    await updateManifest(repo, () => EMPTY_MANIFEST);
    expect(fs.readFileSync(manifestPath(repo), "utf8")).toBe(committed);

    const [notice, ...rest] = await readManifestNotices(repo);
    expect(rest).toEqual([]);
    expect(notice).toContain(".mate/runtime-documents.json is tracked by Git");
    expect(notice).toContain("git rm --cached .mate/runtime-documents.json");
  });

  test("a manifest tracked under another letter case reads as tracked", async () => {
    const repo = initRepo(tempRepo());
    fs.mkdirSync(path.dirname(manifestPath(repo)), { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(manifestPath(repo)), "RUNTIME-DOCUMENTS.json"),
      FIXTURES.documentsOnly,
    );
    if (!fs.existsSync(manifestPath(repo))) return; // A case-sensitive file system keeps the two apart.
    git(repo, "add", "-f", ".mate/RUNTIME-DOCUMENTS.json");
    git(repo, "commit", "-q", "-m", "acme");

    expect(readWrapStateSync(repo).runtimes.size).toBe(0);
  });
});
