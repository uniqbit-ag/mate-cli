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

async function runProbe(installed = false): Promise<Probe> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acme-tui-reactivity-"));
  try {
    let entry: string | undefined;
    if (installed) {
      const target = path.join(root, "node_modules", "acme");
      await fs.mkdir(target, { recursive: true });
      for (const dir of ["src", "opencode-plugin"]) {
        await fs.cp(path.join(packageRoot, dir), path.join(target, dir), { recursive: true });
      }
      const manifest = JSON.parse(
        await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
      );
      await fs.writeFile(
        path.join(target, "package.json"),
        JSON.stringify({ ...manifest, name: "acme" }),
      );
      // Production dependencies only: OpenTUI peers must come from the host.
      for (const name of Object.keys(manifest.dependencies)) {
        const link = path.join(root, "node_modules", name);
        await fs.mkdir(path.dirname(link), { recursive: true });
        await fs.symlink(await fs.realpath(path.join(packageRoot, "node_modules", name)), link);
      }
      entry = path.join(target, "opencode-plugin", "tui.tsx");
      expect(() => Bun.resolveSync("@opentui/solid", target)).toThrow();
    }
    const env: Record<string, string | undefined> = { ...process.env };
    for (const name of Object.values(MATE_ENV)) delete env[name];
    env[MATE_ENV.companionPath] = path.join(root, "companion");
    env[MATE_ENV.repositoryPath] = path.join(root, "repo");
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        path.join(packageRoot, "test", "solid-client-preload.ts"),
        ...(installed
          ? ["--preload", path.join(packageRoot, "test", "solid-host-preload.ts")]
          : []),
        path.join(packageRoot, "test", "tui-reactivity-probe.ts"),
        ...(entry ? [entry] : []),
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
  for (const installed of [false, true]) {
    test(`placements render and stay reactive in ${installed ? "an installed package with host-only peers" : "the workspace without the Solid transform"}`, async () => {
      const probe = await runProbe(installed);

      expect(probe.placements).toBe(2);
      for (const { placement, initial, added, cleared } of probe.frames) {
        expect(initial, placement).toContain("mate v");
        expect(initial, placement).not.toContain("acme sync unfinished");
        expect(added, placement).toContain("acme sync unfinished");
        expect(cleared, placement).not.toContain("acme sync unfinished");
      }
    });
  }
});
