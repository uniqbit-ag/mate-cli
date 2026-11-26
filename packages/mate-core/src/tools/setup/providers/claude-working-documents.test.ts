import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  CLAUDE_SETTINGS_DOCUMENT,
  placeRuntimeDocument,
  removeRuntimeDocument,
} from "../../../lib/orchestrator/projection-runtime-documents";
import {
  CLAUDE_LOCAL_CONFIG_DOCUMENT,
  type RenderedRuntimeDocument,
} from "../../../runtime/runtime-document-manifest";
import { renderWorkingRuntimeDocuments } from "../../setup";
import { renderSecretDenyEntries } from "./claude";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture(companionConfig?: unknown): Promise<{
  companionPath: string;
  repoPath: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acme-runtime-docs-"));
  tempRoots.push(root);
  const companionPath = path.join(root, "companion");
  const repoPath = path.join(root, "working");
  await fs.mkdir(path.join(companionPath, ".opencode"), { recursive: true });
  await fs.mkdir(repoPath, { recursive: true });
  if (companionConfig !== undefined) {
    await fs.writeFile(
      path.join(companionPath, ".opencode", "opencode.json"),
      JSON.stringify(companionConfig),
    );
  }
  return { companionPath, repoPath };
}

function regionAt(
  documents: RenderedRuntimeDocument[],
  at: string[],
  documentPath = CLAUDE_SETTINGS_DOCUMENT,
) {
  const document = documents.find((candidate) => candidate.path === documentPath);
  return document?.regions.find((region) => JSON.stringify(region.at) === JSON.stringify(at));
}

describe("the Claude working target", () => {
  async function renderClaudeDocuments(companionPath: string, repoPath: string) {
    const rendered = await renderWorkingRuntimeDocuments(
      companionPath,
      { allowedAgents: ["claude"], capabilities: [] },
      repoPath,
    );
    return rendered.documents;
  }

  test("carries the disabled Claude features, yielding a user's own enableArtifact", async () => {
    const { companionPath, repoPath } = await fixture();

    const documents = await renderClaudeDocuments(companionPath, repoPath);

    expect(regionAt(documents, ["permissions", "deny"], CLAUDE_SETTINGS_DOCUMENT)).toEqual({
      at: ["permissions", "deny"],
      kind: "list",
      values: ["EnterPlanMode", "DesignSync", "SendFeedback", ...renderSecretDenyEntries()],
    });
    expect(regionAt(documents, ["enableArtifact"], CLAUDE_SETTINGS_DOCUMENT)).toEqual({
      at: ["enableArtifact"],
      kind: "value",
      value: false,
      yields: true,
    });
  });

  test("carries the managed attribution as a yielding region", async () => {
    const { companionPath, repoPath } = await fixture();

    const documents = await renderClaudeDocuments(companionPath, repoPath);

    expect(regionAt(documents, ["attribution"])).toEqual({
      at: ["attribution"],
      kind: "value",
      value: { commit: "", pr: "", sessionUrl: false },
      yields: true,
    });
  });

  test("places no attribution region when the project settings set their own", async () => {
    const { companionPath, repoPath } = await fixture();
    await fs.mkdir(path.join(repoPath, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(repoPath, ".claude", "settings.json"),
      JSON.stringify({ attribution: { pr: "Built with AI" } }),
    );

    expect(regionAt(await renderClaudeDocuments(companionPath, repoPath), ["attribution"])).toBe(
      undefined,
    );
  });

  test("leaves the user's local attribution unchanged", async () => {
    const { companionPath, repoPath } = await fixture();
    const target = path.join(repoPath, ".claude", "settings.local.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    const own = { commit: "Co-Authored-By: Jane Doe <jane@acme.example>" };
    await fs.writeFile(target, JSON.stringify({ attribution: own }), "utf8");

    const documents = await renderClaudeDocuments(companionPath, repoPath);
    await placeRuntimeDocument(repoPath, CLAUDE_SETTINGS_DOCUMENT, documents);

    expect(JSON.parse(await fs.readFile(target, "utf8")).attribution).toEqual(own);
  });

  test("drops the secret deny entries from the region after an opt-out", async () => {
    const { companionPath, repoPath } = await fixture();
    const configPath = path.join(companionPath, ".mate", "config", "framework.yaml");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, "secrets:\n  guardrails: false\n", "utf8");

    const documents = await renderClaudeDocuments(companionPath, repoPath);

    expect(regionAt(documents, ["permissions", "deny"], CLAUDE_SETTINGS_DOCUMENT)).toMatchObject({
      values: ["EnterPlanMode", "DesignSync", "SendFeedback"],
    });
  });

  test("placing and removing the Claude document restores a user's own deny entries byte for byte", async () => {
    const { companionPath, repoPath } = await fixture();
    const target = path.join(repoPath, ".claude", "settings.local.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    const before = `${JSON.stringify(
      { enableArtifact: true, permissions: { deny: ["Bash(rm:*)"] } },
      null,
      2,
    )}\n`;
    await fs.writeFile(target, before, "utf8");
    const documents = await renderClaudeDocuments(companionPath, repoPath);

    await placeRuntimeDocument(repoPath, CLAUDE_SETTINGS_DOCUMENT, documents);
    const placed = JSON.parse(await fs.readFile(target, "utf8"));
    expect(placed.enableArtifact).toBe(true);
    expect(placed.attribution).toEqual({ commit: "", pr: "", sessionUrl: false });
    expect(placed.permissions.deny).toEqual([
      "Bash(rm:*)",
      "EnterPlanMode",
      "DesignSync",
      "SendFeedback",
      ...renderSecretDenyEntries(),
    ]);
    expect(await removeRuntimeDocument(repoPath, CLAUDE_SETTINGS_DOCUMENT)).toBe("removed");

    expect(await fs.readFile(target, "utf8")).toBe(before);
  });

  test("places Mate's policy-file ask entry, and removing it keeps the user's ask entry", async () => {
    const { companionPath, repoPath } = await fixture();
    const target = path.join(repoPath, ".claude", "settings.local.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    const before = `${JSON.stringify({ permissions: { ask: ["Bash(git push:*)"] } }, null, 2)}\n`;
    await fs.writeFile(target, before, "utf8");
    const documents = await renderClaudeDocuments(companionPath, repoPath);

    await placeRuntimeDocument(repoPath, CLAUDE_SETTINGS_DOCUMENT, documents);
    const placed = JSON.parse(await fs.readFile(target, "utf8"));
    expect(placed.permissions.ask).toEqual([
      "Bash(git push:*)",
      `Edit(/${companionPath}/.mate/config/framework.yaml)`,
    ]);
    expect(await removeRuntimeDocument(repoPath, CLAUDE_SETTINGS_DOCUMENT)).toBe("removed");

    expect(await fs.readFile(target, "utf8")).toBe(before);
  });
});

describe("folding the companion .mcp.json", () => {
  async function renderLocalMcp(
    mcpJson: string | undefined,
    capabilities: { name: string }[] = [],
  ) {
    const { companionPath, repoPath } = await fixture();
    const mcpConfigPath = path.join(companionPath, ".mcp.json");
    if (mcpJson !== undefined) await fs.writeFile(mcpConfigPath, mcpJson);
    const { documents, warnings } = await renderWorkingRuntimeDocuments(
      companionPath,
      { allowedAgents: ["claude"], capabilities },
      repoPath,
    );
    const local = documents.find((document) => document.path === CLAUDE_LOCAL_CONFIG_DOCUMENT);
    return {
      servers: (local?.regions[0] as { entries?: unknown } | undefined)?.entries,
      warnings,
      mcpConfigPath,
    };
  }

  test("carries a companion server exactly as declared", async () => {
    const acmeDocs = { type: "http", url: "https://docs.acme.example/mcp" };

    const { servers, warnings } = await renderLocalMcp(
      JSON.stringify({ mcpServers: { "acme-docs": acmeDocs } }),
    );

    expect(servers).toEqual({ "acme-docs": acmeDocs });
    expect(warnings).toEqual([]);
  });

  test("a declared server wins over a companion entry of the same name", async () => {
    const { servers } = await renderLocalMcp(
      JSON.stringify({ mcpServers: { tokensave: { command: "acme-other" } } }),
      [{ name: "tokensave" }],
    );

    expect(servers).toEqual({ tokensave: { command: "tokensave", args: ["serve"] } });
  });

  test.each([
    ["no", undefined],
    ["an unparseable", "{"],
  ])("%s companion file renders the Mate servers only", async (_label, mcpJson) => {
    const { servers, warnings } = await renderLocalMcp(mcpJson, [{ name: "tokensave" }]);

    expect(servers).toEqual({ tokensave: { command: "tokensave", args: ["serve"] } });
    expect(warnings).toEqual([]);
  });

  test("returns one warning for a relative command", async () => {
    const { warnings, mcpConfigPath } = await renderLocalMcp(
      JSON.stringify({ mcpServers: { acme: { command: "./bin/acme-mcp" } } }),
    );

    expect(warnings).toEqual([expect.stringContaining("mcpServers.acme.command")]);
    expect(warnings[0]).toContain(mcpConfigPath);
  });
});
