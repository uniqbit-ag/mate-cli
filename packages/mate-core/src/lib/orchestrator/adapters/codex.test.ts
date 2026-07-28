import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { CodexAdapter } from "./codex";
import type { AdapterContext } from "./base";
import { LaunchPreflightError } from "../types";

const roots: string[] = [];
const adapter = new CodexAdapter();

async function temp(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-codex-adapter-"));
  roots.push(root);
  return root;
}

function context(companionPath: string): AdapterContext {
  return {
    repository: { id: "repo", path: "/tmp/repo", profile: "default" },
    policy: { allowedAgents: ["codex"] },
    companionPath,
    capabilities: [],
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("CodexAdapter companion instructions", () => {
  test("allows a missing AGENTS.md", async () => {
    const companion = await temp();

    expect(() => adapter.buildArgs(context(companion), [])).not.toThrow();
  });

  test("converts unreadable AGENTS.md into a launch preflight error", async () => {
    const companion = await temp();
    const agentsPath = path.join(companion, "AGENTS.md");
    await fs.mkdir(agentsPath);

    expect(() => adapter.buildArgs(context(companion), [])).toThrow(LaunchPreflightError);
    expect(() => adapter.buildArgs(context(companion), [])).toThrow(
      `Cannot read companion instructions at ${agentsPath}. Repair the file and retry.`,
    );
  });
});
