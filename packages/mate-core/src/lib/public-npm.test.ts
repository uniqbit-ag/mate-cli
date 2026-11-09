import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, mock, test } from "bun:test";

import { packPublicPackage, publicNpmDeps } from "./public-npm";

const originalExecFile = publicNpmDeps.execFile;

afterEach(() => {
  publicNpmDeps.execFile = originalExecFile;
});

test("packs with the registry flags from a directory without project npm config", async () => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), "acme-pack-"));
  publicNpmDeps.execFile = mock(async (command, args, options) => {
    expect(command).toBe("npm");
    expect(args).toEqual([
      "pack",
      "@acme/mate-vscode@1.2.3",
      "--pack-destination",
      destination,
      "--registry=https://npm.acme.test/",
      "--@acme:registry=https://npm.acme.test/",
    ]);
    const cwd = options?.cwd as string;
    expect(cwd).not.toBe(process.cwd());
    expect(fs.readFileSync(path.join(cwd, "package.json"), "utf8").trim()).toBe("{}");
    expect(fs.existsSync(path.join(cwd, ".npmrc"))).toBe(false);
    return { stdout: "acme-mate-vscode-1.2.3.tgz\n", stderr: "" };
  }) as never;

  try {
    await expect(
      packPublicPackage("@acme/mate-vscode@1.2.3", destination, "https://npm.acme.test/"),
    ).resolves.toBe(path.join(destination, "acme-mate-vscode-1.2.3.tgz"));
  } finally {
    fs.rmSync(destination, { recursive: true, force: true });
  }
});
