import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

const roots: string[] = [];
const bootstrap = path.join(import.meta.dirname, "cli-bootstrap.cjs");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; bin: string; bun: string; capture: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-bootstrap-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  const bun = path.join(root, "bun-installed");
  const capture = path.join(root, "capture");
  await fs.mkdir(bin);
  const bunScript = [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then exit 0; fi',
    'printf "%s\\n" "$@" > "$BUN_CAPTURE"',
    "exit 0",
    "",
  ].join("\n");
  await fs.writeFile(bun, bunScript);
  await fs.chmod(bun, 0o755);
  return { root, bin, bun, capture };
}

function run(entry: Awaited<ReturnType<typeof fixture>>, args: string[] = []) {
  return spawnSync(process.execPath, [bootstrap, ...args], {
    env: {
      ...process.env,
      HOME: entry.root,
      PATH: `${entry.bin}${path.delimiter}/usr/bin:/bin`,
      BUN_CAPTURE: entry.capture,
    },
    encoding: "utf8",
  });
}

describe("Node package bootstrap", () => {
  test("delegates directly when Bun is already available", async () => {
    const entry = await fixture();
    await fs.copyFile(entry.bun, path.join(entry.bin, "bun"));
    const result = run(entry, ["--version"]);
    expect(result.status).toBe(0);
    expect(await fs.readFile(entry.capture, "utf8")).toContain("--version");
  });

  test("reports a failed bootstrap when the installer does not provide Bun", async () => {
    const entry = await fixture();
    const installer =
      process.platform === "darwin" ? "brew" : process.platform === "win32" ? "powershell" : "sh";
    await fs.writeFile(path.join(entry.bin, installer), "#!/bin/sh\nexit 0\n");
    await fs.chmod(path.join(entry.bin, installer), 0o755);
    const result = run(entry, ["--yes"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("still unavailable");
  });

  test("delegates after a successful platform installer", async () => {
    const entry = await fixture();
    const installer =
      process.platform === "darwin" ? "brew" : process.platform === "win32" ? "powershell" : "sh";
    const installerScript = [
      "#!/bin/sh",
      `cp ${JSON.stringify(entry.bun)} ${JSON.stringify(path.join(entry.bin, "bun"))}`,
      `chmod +x ${JSON.stringify(path.join(entry.bin, "bun"))}`,
      "exit 0",
      "",
    ].join("\n");
    await fs.writeFile(path.join(entry.bin, installer), installerScript);
    await fs.chmod(path.join(entry.bin, installer), 0o755);
    const result = run(entry, ["--yes", "--version"]);
    expect(result.status).toBe(0);
    expect(await fs.readFile(entry.capture, "utf8")).toContain("--version");
  });
});
