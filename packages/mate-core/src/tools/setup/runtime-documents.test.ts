import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  CLAUDE_SETTINGS_DOCUMENT,
  OPENCODE_CONFIG_DOCUMENT,
  placeRuntimeDocument,
  removeRuntimeDocument,
} from "../../lib/orchestrator/projection-runtime-documents";
import type { RenderedRuntimeDocument } from "../../runtime/runtime-document-manifest";
import { runtimeOpenCodePluginRoot } from "../../runtime/runtime-directory";
import { renderWorkingRuntimeDocuments } from "../setup";
import { renderSecretDenyEntries } from "./providers/claude";
import {
  renderCompanionExternalDirectoryPermissions,
  renderSecretDenyPermissions,
} from "./providers/opencode";
import { mergeCompanionOpenCodeConfig } from "./runtime-documents";

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

const config = { allowedAgents: ["opencode"], capabilities: [] };

function regionAt(
  documents: RenderedRuntimeDocument[],
  at: string[],
  documentPath = OPENCODE_CONFIG_DOCUMENT,
) {
  const document = documents.find((candidate) => candidate.path === documentPath);
  return document?.regions.find((region) => JSON.stringify(region.at) === JSON.stringify(at));
}

describe("the OpenCode working target", () => {
  test("names the runtime-link plugin root, the companion skills and references.mate", async () => {
    const { companionPath, repoPath } = await fixture();

    const documents = (await renderWorkingRuntimeDocuments(companionPath, config, repoPath))
      .documents;

    expect(regionAt(documents, ["plugins"])).toMatchObject({
      values: [runtimeOpenCodePluginRoot()],
    });
    expect(regionAt(documents, ["skills"])).toMatchObject({
      values: [path.join(companionPath, ".agents", "skills")],
    });
    expect(regionAt(documents, ["references"])).toMatchObject({
      entries: { mate: companionPath },
    });
    expect(regionAt(documents, ["permissions"])).toMatchObject({
      values: [
        { action: "external_directory", resource: companionPath, effect: "allow" },
        { action: "external_directory", resource: `${companionPath}/**`, effect: "allow" },
        ...renderSecretDenyPermissions(companionPath),
      ],
    });
  });

  test("denies reading and editing .env but never the example file", async () => {
    const { companionPath, repoPath } = await fixture();

    const documents = (await renderWorkingRuntimeDocuments(companionPath, config, repoPath))
      .documents;
    const values = (regionAt(documents, ["permissions"]) as { values: Record<string, string>[] })
      .values;

    expect(values).toContainEqual({ action: "read", resource: "**/.env", effect: "deny" });
    expect(values).toContainEqual({ action: "edit", resource: "**/*.key", effect: "deny" });
    expect(values.some((rule) => rule.resource.includes("example"))).toBe(false);
  });

  test("drops the secret deny rules after an opt-out", async () => {
    const { companionPath, repoPath } = await fixture();
    const configPath = path.join(companionPath, ".mate", "config", "framework.yaml");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, "secrets:\n  guardrails: false\n", "utf8");

    const documents = (await renderWorkingRuntimeDocuments(companionPath, config, repoPath))
      .documents;

    expect(regionAt(documents, ["permissions"])).toMatchObject({
      values: renderCompanionExternalDirectoryPermissions(companionPath),
    });
  });
});

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
      values: ["EnterPlanMode", "DesignSync", ...renderSecretDenyEntries()],
    });
    expect(regionAt(documents, ["enableArtifact"], CLAUDE_SETTINGS_DOCUMENT)).toEqual({
      at: ["enableArtifact"],
      kind: "value",
      value: false,
      yields: true,
    });
  });

  test("drops the secret deny entries from the region after an opt-out", async () => {
    const { companionPath, repoPath } = await fixture();
    const configPath = path.join(companionPath, ".mate", "config", "framework.yaml");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, "secrets:\n  guardrails: false\n", "utf8");

    const documents = await renderClaudeDocuments(companionPath, repoPath);

    expect(regionAt(documents, ["permissions", "deny"], CLAUDE_SETTINGS_DOCUMENT)).toMatchObject({
      values: ["EnterPlanMode", "DesignSync"],
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
    expect(placed.permissions.deny).toEqual([
      "Bash(rm:*)",
      "EnterPlanMode",
      "DesignSync",
      ...renderSecretDenyEntries(),
    ]);
    expect(await removeRuntimeDocument(repoPath, CLAUDE_SETTINGS_DOCUMENT)).toBe("removed");

    expect(await fs.readFile(target, "utf8")).toBe(before);
  });
});

describe("merging the companion opencode.json", () => {
  test("carries companion settings the repository does not set", async () => {
    const { companionPath, repoPath } = await fixture({
      compaction: { auto: true },
      tool_output: { max_lines: 500 },
    });

    const documents = (await renderWorkingRuntimeDocuments(companionPath, config, repoPath))
      .documents;

    expect(regionAt(documents, ["compaction"])).toMatchObject({
      kind: "value",
      value: { auto: true },
    });
  });

  test("leaves a key the repository set itself", async () => {
    const { companionPath, repoPath } = await fixture({ tool_output: { max_lines: 500 } });
    await fs.mkdir(path.join(repoPath, ".opencode"), { recursive: true });
    await fs.writeFile(
      path.join(repoPath, ".opencode", "opencode.json"),
      JSON.stringify({ tool_output: { max_lines: 9 } }),
    );

    const documents = (await renderWorkingRuntimeDocuments(companionPath, config, repoPath))
      .documents;
    await placeRuntimeDocument(repoPath, OPENCODE_CONFIG_DOCUMENT, documents);

    expect(regionAt(documents, ["tool_output"])).toMatchObject({ kind: "value", yields: true });
    const placed = JSON.parse(
      await fs.readFile(path.join(repoPath, ".opencode", "opencode.json"), "utf8"),
    );
    expect(placed.tool_output).toEqual({ max_lines: 9 });
  });

  test("repository content does not change the render", async () => {
    const { companionPath, repoPath } = await fixture({ tool_output: { max_lines: 500 } });
    const target = path.join(repoPath, ".opencode", "opencode.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "{}\n");
    const empty = await renderWorkingRuntimeDocuments(companionPath, config, repoPath);
    await fs.writeFile(target, JSON.stringify({ tool_output: { max_lines: 9 } }));

    const setting = await renderWorkingRuntimeDocuments(companionPath, config, repoPath);

    expect(setting.documents).toEqual(empty.documents);
  });

  test("returns a relative-path warning instead of printing it", async () => {
    const { companionPath, repoPath } = await fixture({ instructions: ["./guide.md"] });
    const printed: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void printed.push(args);
    try {
      const { warnings } = await renderWorkingRuntimeDocuments(companionPath, config, repoPath);
      expect(warnings).toEqual([expect.stringContaining("instructions.0")]);
      expect(warnings[0]).toContain(path.join(companionPath, ".opencode", "opencode.json"));
    } finally {
      console.error = original;
    }
    expect(printed).toEqual([]);
  });

  test("keeps re-rendering a value Mate placed earlier", async () => {
    const { companionPath, repoPath } = await fixture({ compaction: { auto: true } });
    await placeRuntimeDocument(
      repoPath,
      OPENCODE_CONFIG_DOCUMENT,
      (await renderWorkingRuntimeDocuments(companionPath, config, repoPath)).documents,
    );

    const again = (await renderWorkingRuntimeDocuments(companionPath, config, repoPath)).documents;

    expect(regionAt(again, ["compaction"])).toMatchObject({ value: { auto: true } });
  });

  test("rewrites references to absolute paths and lets Mate's own win", async () => {
    const { companionPath, repoPath } = await fixture({
      references: { mate: "..", acme: "./docs" },
    });

    const documents = (await renderWorkingRuntimeDocuments(companionPath, config, repoPath))
      .documents;

    expect(regionAt(documents, ["references"])).toMatchObject({
      entries: { mate: companionPath, acme: path.join(companionPath, ".opencode", "docs") },
    });
  });

  test("joins companion MCP servers to Mate's and warns on other relative paths", async () => {
    const { companionPath, repoPath } = await fixture({
      mcp: { servers: { acme: { type: "local", command: ["./acme-mcp"] } } },
    });
    const base = (await renderWorkingRuntimeDocuments(companionPath, config, repoPath)).documents;

    const merged = await mergeCompanionOpenCodeConfig(companionPath, [
      {
        path: OPENCODE_CONFIG_DOCUMENT,
        regions: base.find((document) => document.path === OPENCODE_CONFIG_DOCUMENT)!.regions,
      },
    ]);

    expect(regionAt(merged.documents, ["mcp", "servers"])).toMatchObject({
      entries: { acme: { type: "local" } },
    });
    expect(merged.warnings.join("\n")).toContain("mcp.servers.acme.command.0");
  });
});
