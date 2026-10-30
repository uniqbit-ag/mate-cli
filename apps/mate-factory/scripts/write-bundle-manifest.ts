#!/usr/bin/env bun
/**
 * Records what the prebuilt workspace in this image actually is.
 *
 * Preparation validates a bundle against the distribution's own pins before it
 * copies anything, so this manifest is not what makes the bundle trustworthy.
 * It is what makes the bundle *legible*: an operator or a publication check can
 * read the installed versions, the target it was built for, and a content
 * digest without unpacking the image or starting a container.
 *
 *   bun scripts/write-bundle-manifest.ts /opt/mate/prebuilt <mate-version>
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface BundleManifest {
  mateVersion: string;
  packages: Record<string, string>;
  target: { platform: string; arch: string; nodeVersion: string };
  /** Content identity of the installed tree, so two bundles pinning the same versions are still distinguishable. */
  fingerprint: string;
  builtAt: string;
}

/** Deterministic across builds of the same tree: sorted, and content-addressed. */
export function fingerprint(root: string): string {
  const hash = crypto.createHash("sha256");
  const walk = (directory: string, prefix: string): void => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(directory, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        hash.update(`l:${relative}:${fs.readlinkSync(full)}\n`);
        continue;
      }
      if (entry.isDirectory()) {
        hash.update(`d:${relative}\n`);
        walk(full, relative);
        continue;
      }
      hash.update(`f:${relative}:`);
      hash.update(fs.readFileSync(full));
      hash.update("\n");
    }
  };
  walk(path.resolve(root), "");
  return hash.digest("hex");
}

export function buildManifest(bundle: string, mateVersion: string): BundleManifest {
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const packages: Record<string, string> = {};
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const installed = JSON.parse(
      fs.readFileSync(
        path.join(bundle, "node_modules", ...name.split("/"), "package.json"),
        "utf8",
      ),
    ) as { version: string };
    packages[name] = installed.version;
  }
  return {
    mateVersion,
    packages,
    target: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
    },
    fingerprint: fingerprint(bundle),
    builtAt: new Date().toISOString(),
  };
}

if (import.meta.main) {
  const [bundle, mateVersion] = process.argv.slice(2);
  if (!bundle || !mateVersion) {
    process.stderr.write("write-bundle-manifest: <bundle> and <mate-version> are required\n");
    process.exit(1);
  }
  const manifest = buildManifest(bundle, mateVersion);
  // Written beside the bundle rather than inside it, so what preparation copies
  // into a companion is exactly the installed workspace and nothing else.
  const file = path.join(path.dirname(path.resolve(bundle)), "prebuilt-manifest.json");
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${file}\n`);
}
