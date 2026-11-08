import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

import { getActiveDistribution, setActiveDistribution } from "../../../distribution";
import { publicNpmDeps } from "../../../lib/public-npm";
import { resolveVsix, VSIX_FILE, vsixResolverDeps } from "./vsix";

let home: string;
const originalHome = process.env.HOME;
const originalExecFile = publicNpmDeps.execFile;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "acme-vsix-home-"));
  process.env.HOME = home;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  publicNpmDeps.execFile = originalExecFile;
  await fs.rm(home, { recursive: true, force: true });
});

test("a VSIX cached before the v2 layout is not reused", async () => {
  const legacy = path.join(home, ".mate", "cache", "vscode", "1.2.3");
  await fs.mkdir(legacy, { recursive: true });
  await fs.writeFile(path.join(legacy, VSIX_FILE), "old");
  const pack = mock(async (_spec: string, destination: string) =>
    path.join(destination, "acme.tgz"),
  );

  const file = await resolveVsix(
    { version: "1.2.3" },
    { exists: vsixResolverDeps.exists, pack, extract: async () => {} },
  );

  expect(pack).toHaveBeenCalledTimes(1);
  expect(file).toBe(path.join(home, ".mate", "cache", "vscode", "v2", "1.2.3", VSIX_FILE));
});

test("the VSIX download uses the distribution's update registry", async () => {
  const previous = getActiveDistribution();
  setActiveDistribution({
    ...previous,
    config: { ...previous.config, update: { registry: "https://npm.acme.test/" } },
  });
  const execFile = mock(async () => ({ stdout: "acme.tgz\n", stderr: "" }));
  publicNpmDeps.execFile = execFile as never;

  try {
    await vsixResolverDeps.pack("@uniqbit/mate-vscode@1.2.3", home);
  } finally {
    setActiveDistribution(previous);
  }

  expect(execFile.mock.calls[0]?.[1]).toContain("--registry=https://npm.acme.test/");
});
