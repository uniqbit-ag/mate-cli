import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PREBUILT_BUNDLE_MARKER as BUNDLE_MARKER } from "./preinstalled-plugins";
import {
  currentTarget,
  getLocalWorkspaceDir,
  validatePrebuiltWorkspace,
  type PrebuiltWorkspaceTarget,
} from "./prebuilt-workspace";

export type PreparePrebuiltWorkspaceResult =
  | { ok: true; workspacePath: string; reused: boolean; packages: Record<string, string> }
  | { ok: false; workspacePath: string; failures: string[] };

export const prebuiltWorkspaceDeps = {
  /** Filesystem-only: a plain recursive copy, never a package manager or an install script. */
  copy: (source: string, destination: string) =>
    fs.cp(source, destination, { recursive: true, force: true, errorOnExist: false }),
};

/**
 * Content identity of an installed tree: a version match is not enough, since
 * two bundles can pin the same versions and still differ.
 */
export async function fingerprintWorkspace(root: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (prefix === "" && entry.name === BUNDLE_MARKER) continue;
      const full = path.join(dir, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        hash.update(`d:${relative}\n`);
        await walk(full, relative);
        continue;
      }
      if (entry.isSymbolicLink()) {
        hash.update(`l:${relative}:${await fs.readlink(full).catch(() => "")}\n`);
        continue;
      }
      hash.update(`f:${relative}:`);
      hash.update(await fs.readFile(full));
      hash.update("\n");
    }
  };
  await walk(path.resolve(root), "");
  return hash.digest("hex");
}

async function readBundleMarker(workspacePath: string): Promise<string | null> {
  try {
    const marker = JSON.parse(
      await fs.readFile(path.join(workspacePath, BUNDLE_MARKER), "utf8"),
    ) as { fingerprint?: string };
    return marker.fingerprint ?? null;
  } catch {
    return null;
  }
}

function samePackages(a: Record<string, string>, b: Record<string, string>): boolean {
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const name of names) if (a[name] !== b[name]) return false;
  return true;
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(
    () => true,
    () => false,
  );
}

/**
 * Copies a validated prebuilt workspace into the companion's machine-local
 * workspace. Presents nothing, waits for nothing, reads no selection and
 * writes none. A changed bundle is staged and validated before it replaces the
 * framework-owned generated workspace; any failure leaves the existing
 * workspace exactly as it was.
 */
export async function preparePrebuiltWorkspace(
  companionPath: string,
  bundlePath: string,
  target: PrebuiltWorkspaceTarget = currentTarget(),
): Promise<PreparePrebuiltWorkspaceResult> {
  const workspacePath = getLocalWorkspaceDir(companionPath);
  const source = path.resolve(bundlePath);

  const bundle = await validatePrebuiltWorkspace(source, target);
  if (!bundle.ok) return { ok: false, workspacePath, failures: bundle.failures };

  const fingerprint = await fingerprintWorkspace(source);
  if (await exists(workspacePath)) {
    const existing = await validatePrebuiltWorkspace(workspacePath, target);
    if (
      existing.ok &&
      samePackages(existing.packages, bundle.packages) &&
      (await readBundleMarker(workspacePath)) === fingerprint
    ) {
      return { ok: true, workspacePath, reused: true, packages: existing.packages };
    }
  }

  const staging = `${workspacePath}.staging`;
  const previous = `${workspacePath}.previous`;
  await fs.rm(staging, { recursive: true, force: true });
  await fs.rm(previous, { recursive: true, force: true });

  try {
    await fs.mkdir(path.dirname(workspacePath), { recursive: true });
    await prebuiltWorkspaceDeps.copy(source, staging);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    return {
      ok: false,
      workspacePath,
      failures: [`${source}: copying the bundle failed: ${(error as Error).message}`],
    };
  }

  const staged = await validatePrebuiltWorkspace(staging, target);
  if (!staged.ok) {
    await fs.rm(staging, { recursive: true, force: true });
    return { ok: false, workspacePath, failures: staged.failures };
  }

  await fs.writeFile(
    path.join(staging, BUNDLE_MARKER),
    `${JSON.stringify({ fingerprint, packages: staged.packages }, null, 2)}\n`,
    "utf8",
  );

  const hadExisting = await exists(workspacePath);
  try {
    if (hadExisting) await fs.rename(workspacePath, previous);
    await fs.rename(staging, workspacePath);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    if (hadExisting && !(await exists(workspacePath))) await fs.rename(previous, workspacePath);
    return {
      ok: false,
      workspacePath,
      failures: [`${workspacePath}: replacing the workspace failed: ${(error as Error).message}`],
    };
  }
  await fs.rm(previous, { recursive: true, force: true });

  return { ok: true, workspacePath, reused: false, packages: staged.packages };
}
