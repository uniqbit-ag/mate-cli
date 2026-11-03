import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MATE_ENV } from "../runtime/env-names";

const packageRoot = path.resolve(import.meta.dirname, "..", "..");

type Probe = {
  placements: number;
  frames: Array<{ placement: string; initial: string; added: string; cleared: string }>;
};

async function runProbe(): Promise<Probe> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-tui-reactivity-"));
  try {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const name of Object.values(MATE_ENV)) delete env[name];
    env[MATE_ENV.companionPath] = path.join(root, "companion");
    env[MATE_ENV.repositoryPath] = path.join(root, "repo");
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        path.join(packageRoot, "test", "solid-client-preload.ts"),
        path.join(packageRoot, "test", "tui-reactivity-probe.ts"),
      ],
      { cwd: packageRoot, env, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`probe exited ${exitCode}: ${stderr}`);
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Probe;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("Mate OpenCode TUI plugin reactivity", () => {
  test("placements follow staleness changes without the Solid transform", async () => {
    const probe = await runProbe();

    expect(probe.placements).toBe(2);
    for (const { placement, initial, added, cleared } of probe.frames) {
      expect(initial, placement).not.toContain("acme sync unfinished");
      expect(added, placement).toContain("acme sync unfinished");
      expect(cleared, placement).not.toContain("acme sync unfinished");
    }
  });
});
