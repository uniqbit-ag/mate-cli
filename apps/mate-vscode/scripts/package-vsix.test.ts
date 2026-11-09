import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { packageStagedVsix } from "./package-vsix";

const tempDirs: string[] = [];
const originalTz = process.env.TZ;

afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function stageFixture(): string {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "acme-vsix-stage-"));
  tempDirs.push(stage);
  const manifest = {
    name: "acme",
    displayName: "Acme",
    description: "Acme fixture extension.",
    version: "1.2.3",
    publisher: "acme",
    license: "MIT",
    repository: { type: "git", url: "https://example.com/acme.git" },
    engines: { vscode: "^1.85.0" },
    main: "./dist/extension.cjs",
    activationEvents: [],
    files: ["dist/", "LICENSE", "README.md"],
  };
  fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(stage, "README.md"), "# Acme\n\nAcme fixture extension.\n");
  fs.writeFileSync(path.join(stage, "LICENSE"), "MIT\n");
  fs.mkdirSync(path.join(stage, "dist"));
  fs.writeFileSync(path.join(stage, "dist", "extension.cjs"), "module.exports = {};\n");
  return stage;
}

function digest(file: string): string {
  return createHash("sha512").update(fs.readFileSync(file)).digest("base64");
}

function filesIn(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

test("packages one tree byte-identically across file times, file modes and time zones", () => {
  const stage = stageFixture();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "acme-vsix-out-"));
  tempDirs.push(out);

  process.env.TZ = "America/New_York";
  packageStagedVsix(stage, path.join(out, "first.vsix"));

  const past = new Date("2001-02-03T04:05:06Z");
  for (const file of filesIn(stage)) {
    fs.utimesSync(file, past, past);
    fs.chmodSync(file, 0o600);
  }
  fs.chmodSync(path.join(stage, "dist"), 0o700);
  process.env.TZ = "Asia/Tokyo";
  packageStagedVsix(stage, path.join(out, "second.vsix"));

  expect(digest(path.join(out, "second.vsix"))).toBe(digest(path.join(out, "first.vsix")));
}, 60_000);
