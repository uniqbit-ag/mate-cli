import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  CLAUDE_LOCAL_CONFIG_DOCUMENT,
  OPENCODE_CONFIG_DOCUMENT,
  CLAUDE_SETTINGS_DOCUMENT,
  placeRuntimeDocument,
  removeRuntimeDocument,
  runtimeDocumentDeps,
  runtimeDocumentPresent,
} from "./projection-runtime-documents";
import type { RenderedRuntimeDocument } from "./projection-types";
import { writeRepoLocalRegistryEntry } from "./repo-local-registry";
import type { LinkedRepository } from "./types";
import { project } from "./working-repo-projection";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeRepo(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function exists(candidate: string): Promise<boolean> {
  return fs
    .access(candidate)
    .then(() => true)
    .catch(() => false);
}

/** The plugin reference, the one region whose value moves with every release. */
function openCodeDocument(pluginReference: string): RenderedRuntimeDocument[] {
  return [
    {
      path: OPENCODE_CONFIG_DOCUMENT,
      regions: [{ at: ["plugin"], kind: "list", values: [pluginReference] }],
    },
  ];
}

/** The guard hook group, whose command carries the Claude plugin root's path. */
function claudeDocument(pluginRoot: string): RenderedRuntimeDocument[] {
  return [
    {
      path: CLAUDE_SETTINGS_DOCUMENT,
      regions: [
        {
          at: ["hooks", "PreToolUse"],
          kind: "list",
          values: [{ hooks: [{ type: "command", command: `${pluginRoot}/hooks/guard.mjs` }] }],
        },
        { at: ["env"], kind: "map", entries: { MATE_PROJECTED: "1" } },
      ],
    },
  ];
}

/** Local scope in the user's own `~/.claude.json`, the one external target. */
function localConfigDocument(): RenderedRuntimeDocument[] {
  return [
    {
      path: CLAUDE_LOCAL_CONFIG_DOCUMENT,
      regions: [
        {
          at: ["projects", "/working", "mcpServers"],
          kind: "map",
          entries: { mate: { command: "mate", args: ["mcp"] } },
        },
      ],
    },
  ];
}

/**
 * A wrap that finds what an earlier wrap left is not appending to it. The
 * manifest is the record of what Mate put there, so a value that has moved on
 * is withdrawn before its successor is written — otherwise both stay, and only
 * the successor is ever recorded as Mate's to remove.
 */
describe("placing a runtime document twice", () => {
  test("a changed value replaces its predecessor instead of joining it", async () => {
    const repoPath = await makeRepo("runtime-document-rewrap-");
    const target = path.join(repoPath, ".opencode", "opencode.json");

    await placeRuntimeDocument(
      repoPath,
      OPENCODE_CONFIG_DOCUMENT,
      openCodeDocument("@uniqbit/mate-opencode-plugin@0.15.5"),
    );
    const state = await placeRuntimeDocument(
      repoPath,
      OPENCODE_CONFIG_DOCUMENT,
      openCodeDocument("@uniqbit/mate-opencode-plugin@0.16.0"),
    );

    expect(state).toBe("written");
    expect(JSON.parse(await fs.readFile(target, "utf8")).plugin).toEqual([
      "@uniqbit/mate-opencode-plugin@0.16.0",
    ]);
  });

  test("a moved plugin root leaves one hook group, not a stale one beside it", async () => {
    const repoPath = await makeRepo("runtime-document-replug-");
    const target = path.join(repoPath, ".claude", "settings.local.json");

    await placeRuntimeDocument(repoPath, CLAUDE_SETTINGS_DOCUMENT, claudeDocument("/old/plugin"));
    await placeRuntimeDocument(repoPath, CLAUDE_SETTINGS_DOCUMENT, claudeDocument("/new/plugin"));

    const settings = JSON.parse(await fs.readFile(target, "utf8"));
    expect(settings.hooks.PreToolUse).toEqual([
      { hooks: [{ type: "command", command: "/new/plugin/hooks/guard.mjs" }] },
    ]);
  });

  test("removal after a re-wrap restores the document byte for byte", async () => {
    const repoPath = await makeRepo("runtime-document-restore-");
    const target = path.join(repoPath, ".claude", "settings.local.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    const before = `${JSON.stringify(
      {
        hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo acme" }] }] },
        acmeSetting: true,
      },
      null,
      2,
    )}\n`;
    await fs.writeFile(target, before, "utf8");

    await placeRuntimeDocument(repoPath, CLAUDE_SETTINGS_DOCUMENT, claudeDocument("/old/plugin"));
    await placeRuntimeDocument(repoPath, CLAUDE_SETTINGS_DOCUMENT, claudeDocument("/new/plugin"));
    expect(await removeRuntimeDocument(repoPath, CLAUDE_SETTINGS_DOCUMENT)).toBe("removed");

    expect(await fs.readFile(target, "utf8")).toBe(before);
  });

  test("a document Mate created is gone after a re-wrap is removed", async () => {
    const repoPath = await makeRepo("runtime-document-deleted-");
    const target = path.join(repoPath, ".opencode", "opencode.json");

    await placeRuntimeDocument(
      repoPath,
      OPENCODE_CONFIG_DOCUMENT,
      openCodeDocument("@uniqbit/mate-opencode-plugin@0.15.5"),
    );
    await placeRuntimeDocument(
      repoPath,
      OPENCODE_CONFIG_DOCUMENT,
      openCodeDocument("@uniqbit/mate-opencode-plugin@0.16.0"),
    );
    await removeRuntimeDocument(repoPath, OPENCODE_CONFIG_DOCUMENT);

    expect(await exists(target)).toBe(false);
    expect(await exists(path.join(repoPath, ".opencode"))).toBe(false);
  });

  test("an unchanged render is current and rewrites nothing", async () => {
    const repoPath = await makeRepo("runtime-document-current-");
    const target = path.join(repoPath, ".claude", "settings.local.json");
    const documents = claudeDocument("/old/plugin");

    await placeRuntimeDocument(repoPath, CLAUDE_SETTINGS_DOCUMENT, documents);
    const written = await fs.readFile(target, "utf8");
    const state = await placeRuntimeDocument(repoPath, CLAUDE_SETTINGS_DOCUMENT, documents);

    expect(state).toBe("current");
    expect(await fs.readFile(target, "utf8")).toBe(written);
  });

  test("what a human wrote beside Mate's regions survives the withdrawal", async () => {
    const repoPath = await makeRepo("runtime-document-human-");
    const target = path.join(repoPath, ".opencode", "opencode.json");

    await placeRuntimeDocument(
      repoPath,
      OPENCODE_CONFIG_DOCUMENT,
      openCodeDocument("@uniqbit/mate-opencode-plugin@0.15.5"),
    );
    const seeded = JSON.parse(await fs.readFile(target, "utf8"));
    seeded.plugin = ["acme-plugin", ...seeded.plugin];
    await fs.writeFile(target, `${JSON.stringify(seeded, null, 2)}\n`, "utf8");

    await placeRuntimeDocument(
      repoPath,
      OPENCODE_CONFIG_DOCUMENT,
      openCodeDocument("@uniqbit/mate-opencode-plugin@0.16.0"),
    );

    expect(JSON.parse(await fs.readFile(target, "utf8")).plugin).toEqual([
      "acme-plugin",
      "@uniqbit/mate-opencode-plugin@0.16.0",
    ]);
  });
});

/**
 * Withdrawing a Capability empties the regions it contributed, and an emptied
 * document is not rendered at all — so "absent from this render" is the only
 * signal the placing side gets that the entries it wrote last time are no
 * longer wanted. Treating it as a no-op leaves a disabled MCP server declared
 * in the user's own `~/.claude.json` for good.
 */
describe("a document the current render no longer produces", () => {
  /** What an enabled tokensave contributes: one server under the repo's project. */
  function tokensaveLocalConfig(repoPath: string): RenderedRuntimeDocument[] {
    return [
      {
        path: CLAUDE_LOCAL_CONFIG_DOCUMENT,
        regions: [
          {
            at: ["projects", path.resolve(repoPath), "mcpServers"],
            kind: "map",
            entries: { tokensave: { command: "tokensave", args: ["mcp"] } },
          },
        ],
      },
    ];
  }

  test("disabling the Capability withdraws its server from the user's ~/.claude.json", async () => {
    const repoPath = await makeRepo("runtime-document-withdraw-external-");
    const companionPath = await makeRepo("runtime-document-withdraw-companion-");
    const homePath = await makeRepo("runtime-document-withdraw-home-");
    const homeDir = runtimeDocumentDeps.homeDir;
    runtimeDocumentDeps.homeDir = () => homePath;
    try {
      const repository: LinkedRepository = { id: "app", path: repoPath };
      await writeRepoLocalRegistryEntry(repoPath, companionPath, repository, "git");
      const target = path.join(homePath, ".claude.json");
      const before = `${JSON.stringify({ oauthAccount: { emailAddress: "acme" } }, null, 2)}\n`;
      await fs.writeFile(target, before, "utf8");
      const input = {
        repoPath,
        companionPath,
        repository,
        config: { allowedAgents: ["claude"], capabilities: [] },
      };

      await project("wrap", { ...input, runtimeDocuments: tokensaveLocalConfig(repoPath) });
      expect(JSON.parse(await fs.readFile(target, "utf8")).projects).toBeDefined();

      /** The Capability is off, so the render carries the settings document alone. */
      const result = await project("wrap", {
        ...input,
        runtimeDocuments: claudeDocument("/plugin"),
      });

      const withdrawn = result.outcomes.find(
        (outcome) => outcome.id === "claude-local-mcp-document",
      );
      expect(withdrawn?.state).toBe("written");
      expect(await runtimeDocumentPresent(repoPath, CLAUDE_LOCAL_CONFIG_DOCUMENT)).toBe(false);
      /** The user's file is theirs: emptied of Mate's keys, never deleted. */
      expect(await fs.readFile(target, "utf8")).toBe(before);
    } finally {
      runtimeDocumentDeps.homeDir = homeDir;
    }
  });

  test("a repo-local document Mate created is deleted, not left behind", async () => {
    const repoPath = await makeRepo("runtime-document-withdraw-local-");
    const target = path.join(repoPath, ".opencode", "opencode.json");

    await placeRuntimeDocument(
      repoPath,
      OPENCODE_CONFIG_DOCUMENT,
      openCodeDocument("@uniqbit/mate-opencode-plugin@0.16.0"),
    );
    const state = await placeRuntimeDocument(repoPath, OPENCODE_CONFIG_DOCUMENT, []);

    expect(state).toBe("written");
    expect(await exists(target)).toBe(false);
    expect(await exists(path.join(repoPath, ".opencode"))).toBe(false);
    expect(await runtimeDocumentPresent(repoPath, OPENCODE_CONFIG_DOCUMENT)).toBe(false);
  });

  test("a second withdrawal is current rather than a repeated removal", async () => {
    const repoPath = await makeRepo("runtime-document-withdraw-twice-");

    await placeRuntimeDocument(
      repoPath,
      OPENCODE_CONFIG_DOCUMENT,
      openCodeDocument("@uniqbit/mate-opencode-plugin@0.16.0"),
    );
    await placeRuntimeDocument(repoPath, OPENCODE_CONFIG_DOCUMENT, []);

    expect(await placeRuntimeDocument(repoPath, OPENCODE_CONFIG_DOCUMENT, [])).toBe("current");
  });

  /**
   * The one case that must not withdraw. A scope that renders no documents at
   * all — a launch, which projects some of these entries without a Runtime
   * Surface having rendered for it — is claiming nothing, and a withdrawal
   * there would take back the wrap's own work on every launch.
   */
  test("a pass that rendered no documents leaves what the wrap recorded", async () => {
    const repoPath = await makeRepo("runtime-document-withdraw-unrendered-");
    const target = path.join(repoPath, ".opencode", "opencode.json");

    await placeRuntimeDocument(
      repoPath,
      OPENCODE_CONFIG_DOCUMENT,
      openCodeDocument("@uniqbit/mate-opencode-plugin@0.16.0"),
    );
    const state = await placeRuntimeDocument(repoPath, OPENCODE_CONFIG_DOCUMENT);

    expect(state).toBe("skipped");
    expect(await exists(target)).toBe(true);
    expect(await runtimeDocumentPresent(repoPath, OPENCODE_CONFIG_DOCUMENT)).toBe(true);
  });
});

/**
 * A document that does not parse is not an empty one. `~/.claude.json` holds
 * Claude Code's auth, every project's history and its MCP approvals, and a wrap
 * racing a live session can read it mid-write; rebuilding from `{}` there would
 * replace the file with the few keys Mate contributes and say nothing. The wrap
 * stops instead, and the operator is told which document stopped it.
 */
describe("a target that does not parse", () => {
  /** A torn read: a prefix of a real document, cut off mid-object. */
  const torn = '{\n  "projects": {\n    "/working": {\n      "mcpServers": {';

  test("placing refuses and leaves the document byte for byte", async () => {
    const repoPath = await makeRepo("runtime-document-torn-place-");
    const target = path.join(repoPath, ".opencode", "opencode.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, torn, "utf8");

    await expect(
      placeRuntimeDocument(
        repoPath,
        OPENCODE_CONFIG_DOCUMENT,
        openCodeDocument("@uniqbit/mate-opencode-plugin@0.16.0"),
      ),
    ).rejects.toThrow(/not valid JSON/);

    expect(await fs.readFile(target, "utf8")).toBe(torn);
    expect(await runtimeDocumentPresent(repoPath, OPENCODE_CONFIG_DOCUMENT)).toBe(false);
  });

  test("removing refuses, leaves the document, and keeps the regions recorded", async () => {
    const repoPath = await makeRepo("runtime-document-torn-remove-");
    const target = path.join(repoPath, ".opencode", "opencode.json");
    await placeRuntimeDocument(
      repoPath,
      OPENCODE_CONFIG_DOCUMENT,
      openCodeDocument("@uniqbit/mate-opencode-plugin@0.16.0"),
    );
    await fs.writeFile(target, torn, "utf8");

    await expect(removeRuntimeDocument(repoPath, OPENCODE_CONFIG_DOCUMENT)).rejects.toThrow(
      /not valid JSON/,
    );

    expect(await fs.readFile(target, "utf8")).toBe(torn);
    /** Still Mate's to withdraw, so a later cleanup reaches the same regions. */
    expect(await runtimeDocumentPresent(repoPath, OPENCODE_CONFIG_DOCUMENT)).toBe(true);
  });

  test("the user's own ~/.claude.json survives a wrap that read it mid-write", async () => {
    const repoPath = await makeRepo("runtime-document-torn-external-");
    const homePath = await makeRepo("runtime-document-torn-home-");
    const homeDir = runtimeDocumentDeps.homeDir;
    runtimeDocumentDeps.homeDir = () => homePath;
    try {
      const target = path.join(homePath, ".claude.json");
      await fs.writeFile(target, torn, "utf8");

      await expect(
        placeRuntimeDocument(repoPath, CLAUDE_LOCAL_CONFIG_DOCUMENT, localConfigDocument()),
      ).rejects.toThrow(/not valid JSON/);

      expect(await fs.readFile(target, "utf8")).toBe(torn);
      /** No sibling temp file left where the rename never happened. */
      expect(await fs.readdir(homePath)).toEqual([".claude.json"]);
    } finally {
      runtimeDocumentDeps.homeDir = homeDir;
    }
  });

  test("the projection reports the document as failed rather than rewriting it", async () => {
    const repoPath = await makeRepo("runtime-document-torn-outcome-");
    const companionPath = await makeRepo("runtime-document-torn-companion-");
    const repository: LinkedRepository = { id: "app", path: repoPath };
    await writeRepoLocalRegistryEntry(repoPath, companionPath, repository, "git");
    const target = path.join(repoPath, ".opencode", "opencode.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, torn, "utf8");

    const result = await project("wrap", {
      repoPath,
      companionPath,
      repository,
      config: { allowedAgents: ["opencode"], capabilities: [] },
      runtimeDocuments: openCodeDocument("@uniqbit/mate-opencode-plugin@0.16.0"),
    });

    const failure = result.outcomes.find((outcome) => outcome.id === "opencode-runtime-document");
    expect(failure?.state).toBe("failed");
    expect(failure?.error?.message).toMatch(/not valid JSON/);
    expect(await fs.readFile(target, "utf8")).toBe(torn);
  });
});
