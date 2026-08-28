import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { FrameworkConfig } from "../../lib/orchestrator/types";
import type { SetupContext } from "./plugin";
import { CLAUDE_LOCAL_CONFIG_DOCUMENT, renderDocumentsForTarget } from "./runtime-documents";
import { renderWorkingRuntimeDocuments } from "../setup";
import { projectionRepoRoot, projectionTarget, surfaceRoot } from "./surface-target";

/**
 * The target parameter itself: its default, its refusal, and the two things a
 * working-target pass must never do — write anywhere, or name the Working
 * Repository inside a value it renders.
 */

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const config: FrameworkConfig = {
  allowedAgents: ["claude"],
  capabilities: [{ name: "tokensave" }],
};

function contextFor(companionPath: string, repoPath?: string): SetupContext {
  return {
    companionPath,
    config,
    mode: "sync",
    activeProviders: ["claude"],
    target: "working",
    ...(repoPath ? { repoPath } : {}),
  };
}

async function makeFixture(prefix: string): Promise<{ repoPath: string; companionPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  const repoPath = path.join(root, "working");
  const companionPath = path.join(root, "companion");
  await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
  await fs.mkdir(companionPath, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: repoPath, stdio: "ignore" });
  await fs.writeFile(path.join(repoPath, "src", "index.ts"), "export const acme = 1;\n", "utf8");
  return { repoPath, companionPath };
}

async function tree(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of await fs.readdir(dir, { recursive: true })) {
    const full = path.join(dir, name);
    if (!(await fs.stat(full)).isFile()) continue;
    files[name] = await fs.readFile(full, "utf8");
  }
  return files;
}

describe("the projection target", () => {
  test("defaults to the companion, so a caller that names none is unchanged", () => {
    const ctx: SetupContext = {
      companionPath: "/companions/acme",
      config,
      mode: "sync",
      activeProviders: ["claude"],
    };

    expect(projectionTarget(ctx)).toBe("companion");
    expect(surfaceRoot(ctx)).toBe("/companions/acme");
  });

  test("refuses a working target with no Working Repository in scope", async () => {
    const { companionPath } = await makeFixture("mate-target-refuse-");

    expect(() => projectionTarget(contextFor(companionPath))).toThrow(
      /needs a Working Repository in scope/,
    );
    expect(() => renderDocumentsForTarget(contextFor(companionPath), new Map())).toThrow(
      /needs a Working Repository in scope/,
    );
  });

  /**
   * The companion default is the dangerous one: `projectionTarget` lets it
   * through with no repository, and an absent path used to resolve to the
   * current working directory — so a render started anywhere would have keyed
   * its MCP servers under that directory in the user's global Claude config.
   */
  test("refuses to address a render by the current directory when no repository is in scope", () => {
    const ctx: SetupContext = {
      companionPath: "/companions/acme",
      config,
      mode: "sync",
      activeProviders: ["claude"],
    };

    expect(() => projectionRepoRoot(ctx)).toThrow(/needs a Working Repository in scope/);
    expect(() => renderDocumentsForTarget(ctx, new Map())).toThrow(
      /needs a Working Repository in scope/,
    );
  });

  test("resolves the repository a render is addressed by to one absolute path", async () => {
    const { repoPath, companionPath } = await makeFixture("mate-target-repo-root-");
    const ctx = { ...contextFor(companionPath, path.join(repoPath, "src", "..")) };

    expect(projectionRepoRoot(ctx)).toBe(path.resolve(repoPath));
  });

  test("gives a working-target pass no surface root to write into", async () => {
    const { repoPath, companionPath } = await makeFixture("mate-target-root-");

    expect(() => surfaceRoot(contextFor(companionPath, repoPath))).toThrow(/renders its documents/);
  });

  test("renders without writing into either repository", async () => {
    const { repoPath, companionPath } = await makeFixture("mate-target-render-");
    const before = { working: await tree(repoPath), companion: await tree(companionPath) };

    const documents = await renderWorkingRuntimeDocuments(companionPath, config, repoPath);

    expect(documents.length).toBeGreaterThan(0);
    expect(await tree(repoPath)).toEqual(before.working);
    expect(await tree(companionPath)).toEqual(before.companion);
  });

  /**
   * The invariant is about what a document *points at*: a hook command, an MCP
   * server, a permitted directory. Rewriting one of those working-relative is
   * what would turn the projection into a copy. A region's `at` is an address,
   * not a path to a resource, so it is excluded here and asserted separately
   * below — the one place a working path legitimately appears.
   */
  test("names the Companion Repository inside every rendered value, never the working one", async () => {
    const { repoPath, companionPath } = await makeFixture("mate-target-paths-");

    const documents = await renderWorkingRuntimeDocuments(companionPath, config, repoPath);
    const values = JSON.stringify(
      documents.map((document) => ({
        ...document,
        regions: document.regions.map(({ at: _at, ...region }) => region),
      })),
    );

    expect(values).toContain(companionPath);
    expect(values).not.toContain(repoPath);
  });

  /**
   * Local scope is keyed by the directory Claude Code files the project under,
   * so this address — and only this one — is the Working Repository.
   */
  test("addresses the local MCP region by the working repository path", async () => {
    const { repoPath, companionPath } = await makeFixture("mate-target-local-mcp-");

    const documents = await renderWorkingRuntimeDocuments(companionPath, config, repoPath);
    const local = documents.find((document) => document.path === CLAUDE_LOCAL_CONFIG_DOCUMENT);

    expect(local?.regions).toHaveLength(1);
    expect(local?.regions[0]?.at).toEqual(["projects", path.resolve(repoPath), "mcpServers"]);
  });
});
