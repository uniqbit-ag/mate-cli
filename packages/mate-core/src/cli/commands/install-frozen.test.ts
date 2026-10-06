import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, mock, test } from "bun:test";

import * as realInstall from "../../lib/install";

/**
 * Core requirements would shell out to network installers, so only plan
 * inspection and execution are stubbed; context, reconcile and state are real.
 */
mock.module("../../lib/install", () => ({
  ...realInstall,
  inspectInstallPlan: async (plan: realInstall.InstallPlan) => ({ ...plan, requirements: [] }),
  runInstallPlan: async () => ({ ok: true, results: [] }),
}));

const { runInstallCommand } = await import("./install");

const originalHome = process.env.HOME;
const originalArtifactPath = process.env.MATE_ARTIFACT_PATH;
let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "mate-install-frozen-"));
  process.env.HOME = home;
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalArtifactPath === undefined) delete process.env.MATE_ARTIFACT_PATH;
  else process.env.MATE_ARTIFACT_PATH = originalArtifactPath;
});

test("frozen mode writes the checkout's plugin-generated files and leaves the lockfile untouched", async () => {
  const companion = path.join(home, "companion");
  await fs.mkdir(path.join(companion, ".mate", "config"), { recursive: true });
  await fs.mkdir(path.join(companion, ".mate", "plugins"), { recursive: true });
  await fs.writeFile(
    path.join(companion, ".mate", "config", "framework.yaml"),
    JSON.stringify({ packageManagers: [], capabilities: [] }),
  );
  const lockFile = path.join(companion, ".mate", "plugins", "package-lock.json");
  const lock = '{"lockfileVersion":3,"packages":{}}\n';
  await fs.writeFile(lockFile, lock);
  process.env.MATE_ARTIFACT_PATH = companion;
  const before = await fs.readdir(companion);

  expect(await runInstallCommand(["--yes", "--frozen-plugins"], companion)).toBe(true);

  expect((await fs.readdir(companion)).length).toBeGreaterThan(before.length);
  expect(await fs.readFile(lockFile, "utf8")).toBe(lock);
});
