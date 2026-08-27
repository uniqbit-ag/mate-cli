import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { FrameworkConfig } from "../../lib/orchestrator/types";
import type { SetupContext } from "./plugin";
import { renderDocumentsForTarget } from "./runtime-documents";
import { renderWorkingRuntimeDocuments } from "../setup";
import { projectionTarget, surfaceRoot } from "./surface-target";

/**
 * The target parameter itself: its default, its refusal, and the two things a
 * working-target pass must never do — write anywhere, or name the Working
 * Repository inside a document it renders.
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

  test("names the Companion Repository inside every rendered document, never the working one", async () => {
    const { repoPath, companionPath } = await makeFixture("mate-target-paths-");

    const rendered = JSON.stringify(
      await renderWorkingRuntimeDocuments(companionPath, config, repoPath),
    );

    expect(rendered).toContain(companionPath);
    expect(rendered).not.toContain(repoPath);
  });
});
