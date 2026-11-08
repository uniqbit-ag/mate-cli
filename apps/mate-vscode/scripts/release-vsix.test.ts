import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { embed, RECORD_PATH } from "./release-vsix";

const tempDirs: string[] = [];
const SEED = `${JSON.stringify({ version: null, sha512: null }, null, 2)}\n`;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixtureWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acme-release-vsix-"));
  tempDirs.push(root);
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  fs.mkdirSync(path.dirname(path.join(root, RECORD_PATH)), { recursive: true });
  fs.writeFileSync(path.join(root, RECORD_PATH), SEED);
  return root;
}

function stubPackager(root: string): string {
  const file = path.join(root, "acme.vsix");
  fs.writeFileSync(file, "acme-vsix");
  return file;
}

test("embed records the bumped version and the VSIX digest, and stages the record", () => {
  const root = fixtureWorkspace();

  embed("1.2.3", root, stubPackager);

  expect(JSON.parse(fs.readFileSync(path.join(root, RECORD_PATH), "utf8"))).toEqual({
    version: "1.2.3",
    sha512: `sha512-${createHash("sha512").update("acme-vsix").digest("base64")}`,
  });
  const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
    cwd: root,
    encoding: "utf8",
  });
  expect(staged.split("\n")).toContain(RECORD_PATH);
});

test("embed fails and leaves the record unchanged when the VSIX build fails", () => {
  const root = fixtureWorkspace();

  expect(() =>
    embed("1.2.3", root, () => {
      throw new Error("acme build failed");
    }),
  ).toThrow("acme build failed");
  expect(fs.readFileSync(path.join(root, RECORD_PATH), "utf8")).toBe(SEED);
});
