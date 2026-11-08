/**
 * Binds the VSIX to the release through a record in `@uniqbit/mate-core`.
 *
 *   bun scripts/release-vsix.ts embed <version> [workspace-root]
 *   bun scripts/release-vsix.ts verify <version> <extension-tarball> [workspace-root]
 *
 * `embed` runs at release preparation, before the image inputs pack core;
 * `verify` runs at publication, before any package is published.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { packageVsix } from "./package-vsix";

/** `mate vscode setup` verifies downloads and cached copies against it. */
export const RECORD_PATH = "packages/mate-core/src/cli/commands/vscode/release-vsix.json";
const VSIX_FILE = "mate-vscode.vsix";

const defaultRoot = path.join(import.meta.dir, "..", "..", "..");

export interface ReleaseVsixRecord {
  version: string | null;
  sha512: string | null;
}

/** SRI form, as npm writes integrity. */
function digestOf(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** Builds the VSIX in `root` and returns its path. */
export type VsixPackager = (root: string) => string;

const defaultPackager: VsixPackager = (root) => packageVsix(path.join(root, "apps/mate-vscode"));

/** Builds the VSIX, writes its version and digest to core's record, and stages the record. */
export function embed(version: string, root = defaultRoot, packager = defaultPackager): void {
  const digest = digestOf(fs.readFileSync(packager(root)));
  const record: ReleaseVsixRecord = { version, sha512: digest };
  fs.writeFileSync(path.join(root, RECORD_PATH), `${JSON.stringify(record, null, 2)}\n`);
  execFileSync("git", ["add", RECORD_PATH], { cwd: root, stdio: "inherit" });
  console.log(`Recorded ${VSIX_FILE} ${version}: ${digest}`);
}

/** Throws unless the VSIX inside `tarball` matches the record for `version`. */
export function verify(version: string, tarball: string, root = defaultRoot): void {
  const record = JSON.parse(
    fs.readFileSync(path.join(root, RECORD_PATH), "utf8"),
  ) as ReleaseVsixRecord;
  if (record.version !== version) {
    throw new Error(
      `the release VSIX record in ${RECORD_PATH} names version ${record.version}, but this release is ${version}.`,
    );
  }
  const vsix = execFileSync("tar", ["-xzOf", tarball, `package/${VSIX_FILE}`], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const digest = digestOf(vsix);
  if (record.sha512 !== digest) {
    throw new Error(
      `the packed ${VSIX_FILE} hashes to ${digest}, but the release VSIX record for ${version} names ${record.sha512}.`,
    );
  }
  console.log(`${VSIX_FILE} ${version} matches the release VSIX record: ${digest}`);
}

if (import.meta.main) {
  const [command, version, ...rest] = process.argv.slice(2);
  try {
    if (command === "embed" && version && rest.length <= 1) embed(version, rest[0]);
    else if (command === "verify" && version && rest[0] && rest.length <= 2)
      verify(version, rest[0], rest[1]);
    else
      throw new Error(
        "usage: release-vsix.ts embed <version> [workspace-root] | verify <version> <extension-tarball> [workspace-root]",
      );
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}
